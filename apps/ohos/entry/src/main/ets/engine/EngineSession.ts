import type {
  OhEngine, OhStartupLifecycle, OhInvitationIssued, OhSendReport, OhHistoryEntry, OhDevice,
  OhSyncSettings, OhProfileRecovery, OhEncryptionState, OhReceiveProgress, OhSyncSettingsPatch,
  OhTransferProgress, OhTransferStatus, OhNetworkRecoveryStatus, OhHistoryResource, OhBinaryResource
} from 'libuc_ohos_napi.so';

export interface EngineFactory {
  lifecycle: OhStartupLifecycle;
  start(): Promise<OhEngine>;
}

export interface SessionView {
  phase: string;
  busy: boolean;
  unlocked: boolean;
  deviceName: string;
  activeEntryId: string;
  invitationCode: string;
  invitationExpiresAt: number;
  joinId: string;
  joinStatus: string;
  message: string;
  history: OhHistoryEntry[];
  devices: OhDevice[];
  syncSettings?: OhSyncSettings;
  recovery?: OhProfileRecovery;
  encryption?: OhEncryptionState;
  receiveProgress: OhReceiveProgress[];
  transferProgress?: OhTransferProgress;
  transferStatus?: OhTransferStatus;
  networkRecovery?: OhNetworkRecoveryStatus;
  historyNextCursor?: string;
}

interface AdmissionSnapshot {
  device_trust: {
    current_join: { status: string; join_id: string } | null;
  };
}

export class EngineSession {
  private active?: OhEngine;
  private factory?: EngineFactory;
  private starting?: Promise<void>;
  private events?: Promise<void>;
  private operation?: Promise<unknown>;
  private transition: Promise<void> = Promise.resolve();
  private foreground: boolean = true;
  private closing: boolean = false;
  private listener?: (view: SessionView) => void;
  private view: SessionView = {
    phase: 'idle', busy: false, unlocked: false, deviceName: '', activeEntryId: '',
    invitationCode: '', invitationExpiresAt: 0, joinId: '', joinStatus: '', message: '',
    history: [], devices: [], receiveProgress: []
  };
  private historyQuery: string = '';

  observe(listener: (view: SessionView) => void): void {
    this.listener = listener;
    this.publish();
  }

  detach(): void { this.listener = undefined; }

  snapshot(): SessionView { return { ...this.view }; }

  clearOperationMessage(): void {
    if (this.view.phase === 'error') return;
    this.view.message = '';
    this.publish();
  }

  start(factory: EngineFactory): Promise<void> {
    if (this.starting !== undefined) return this.starting;
    if (this.active !== undefined) return Promise.resolve();
    if (this.closing) return Promise.reject(new Error('SESSION_CLOSED'));
    this.factory = factory;
    this.starting = this.startOnce(factory).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startOnce(factory: EngineFactory): Promise<void> {
    this.view.phase = 'starting';
    this.view.message = '';
    this.publish();
    try {
      this.active = await factory.start();
      this.events = this.consumeEvents(this.active);
      const recovery = await this.active.recoverSession(true);
      this.view.unlocked = recovery.unlocked;
      this.view.recovery = await this.active.queryProfileRecovery();
      this.view.encryption = await this.active.queryEncryptionState();
      await this.applyLifecycle();
    } catch (_error) {
      this.view.phase = 'error';
      this.view.message = '启动失败，请检查安全存储和 Engine 版本。';
      const failed = this.active;
      this.active = undefined;
      if (failed !== undefined) await failed.shutdownUntilComplete();
      await this.events;
      throw new Error('SESSION_START_FAILED');
    } finally {
      this.publish();
    }
  }

  setForeground(value: boolean): Promise<void> {
    this.foreground = value;
    if (!value) {
      this.view.invitationCode = '';
      this.view.invitationExpiresAt = 0;
      this.publish();
    }
    this.transition = this.transition.catch(() => {}).then(() => this.applyLifecycle()).catch(() => {
      this.view.phase = 'error';
      this.view.message = '前后台切换未完成，请重新打开应用。';
      this.publish();
      throw new Error('LIFECYCLE_FAILED');
    });
    return this.transition;
  }

  private async applyLifecycle(): Promise<void> {
    if (this.closing) return;
    const active = this.active;
    if (active === undefined) {
      if (this.factory !== undefined) {
        if (this.foreground) await this.factory.lifecycle.resume();
        else await this.factory.lifecycle.suspendWithDeadline(2000);
      }
      return;
    }
    if (!this.foreground) {
      await active.suspendWithDeadline(2000);
      this.view.phase = 'suspended';
    } else {
      await active.resume();
      this.view.message = '';
      await this.refreshAdmission(active);
      await this.refresh();
      this.view.phase = this.view.unlocked ? 'ready' : 'setup';
    }
    this.publish();
  }

  async createSpace(name: string, passphrase: string, confirmation: string): Promise<void> {
    if (passphrase.length === 0 || passphrase !== confirmation) throw new Error('INVALID_PASSPHRASE');
    await this.perform(async (active: OhEngine): Promise<void> => {
      await active.createSpace(name.trim() || null, passphrase);
      this.view.unlocked = true;
      this.view.phase = 'ready';
      await this.refresh();
    });
  }

  async joinSpace(code: string, name: string, passphrase: string): Promise<void> {
    if (code.trim().length === 0 || passphrase.length === 0) throw new Error('INVALID_JOIN');
    await this.perform(async (active: OhEngine): Promise<void> => {
      const result = await active.joinSpace(code.trim(), name.trim() || null, passphrase, false);
      this.view.joinId = result.joinId;
      this.view.joinStatus = result.status;
      if (result.status === 'active') {
        this.view.unlocked = true;
        this.view.phase = 'ready';
        await this.refresh();
      }
    });
  }

  async cancelJoin(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const result = await active.cancelJoinSpace(this.view.joinId);
      this.view.joinStatus = result.status;
    });
  }

  async invite(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const invitation: OhInvitationIssued = await active.issueInvitation();
      this.view.invitationCode = invitation.invitationCode;
      this.view.invitationExpiresAt = invitation.expiresAtMs;
    });
  }

  async changePassphrase(passphrase: string, confirmation: string): Promise<void> {
    if (passphrase.length === 0 || passphrase !== confirmation) throw new Error('INVALID_PASSPHRASE');
    await this.perform(async (active: OhEngine): Promise<void> => {
      await active.changeEncryptionPassphrase(passphrase, confirmation);
      this.view.message = '空间口令已更新。';
    });
  }

  async sendText(text: string): Promise<void> {
    if (text.length === 0) throw new Error('EMPTY_TEXT');
    await this.perform(async (active: OhEngine): Promise<void> => {
      const report: OhSendReport = await active.sendText(text, []);
      this.view.activeEntryId = report.entryId;
      this.view.message = `已接收 ${report.totalAccepted} · 重复 ${report.totalDuplicate} · 离线 ${report.totalOffline} · 等待 ${report.totalPending} · 失败 ${report.totalErrored}`;
    });
  }

  async sendImage(bytes: Uint8Array, mimeType: string = 'image/png'): Promise<void> {
    if (bytes.byteLength === 0) throw new Error('EMPTY_IMAGE');
    await this.perform(async (active: OhEngine): Promise<void> => {
      const report: OhSendReport = await active.sendImage(bytes, mimeType, []);
      this.view.activeEntryId = report.entryId;
      this.view.message = this.deliveryMessage(report);
    });
  }

  async sendFiles(handles: string[]): Promise<void> {
    if (handles.length === 0) throw new Error('EMPTY_FILES');
    await this.perform(async (active: OhEngine): Promise<void> => {
      const report: OhSendReport = await active.sendFiles(handles, []);
      this.view.activeEntryId = report.entryId;
      this.view.message = this.deliveryMessage(report);
    });
  }

  async observeClipboard(dispatch: boolean = true): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const report = await active.observeClipboardChange(dispatch);
      if (report !== null) {
        this.view.activeEntryId = report.entryId;
        this.view.message = this.deliveryMessage(report);
      } else {
        this.view.message = '本次未发送内容。';
      }
    });
  }

  async sendClipboardImage(bytes: Uint8Array, mimeType: string = 'image/png'): Promise<void> {
    await this.sendImage(bytes, mimeType);
  }

  async loadHistory(query: string = ''): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      this.historyQuery = query.trim();
      const page = await active.queryHistory(null, 50, this.historyQuery.length === 0 ? null : this.historyQuery);
      this.view.history = page.entries;
      this.view.historyNextCursor = page.nextCursor;
    });
  }

  async loadMoreHistory(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const cursor = this.view.historyNextCursor;
      if (cursor === undefined) return;
      const page = await active.queryHistory(cursor, 50, this.historyQuery.length === 0 ? null : this.historyQuery);
      this.view.history = this.view.history.concat(page.entries);
      this.view.historyNextCursor = page.nextCursor;
    });
  }

  async loadDevices(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => { this.view.devices = await active.listDevices(); });
  }

  async removeMember(deviceId: string): Promise<void> {
    if (deviceId.length === 0) throw new Error('INVALID_DEVICE');
    await this.perform(async (active: OhEngine): Promise<void> => {
      await active.removeMember(deviceId);
      this.view.message = '设备变更已提交，请刷新查看 Engine 的实际收敛状态。';
    });
  }

  async loadSyncSettings(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => { this.view.syncSettings = await active.querySyncSettings(); });
  }

  async loadReceiveProgress(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      this.view.receiveProgress = await active.listEntryReceiveProgress();
    });
  }

  async cancelReceive(entryId: string, attemptId: string): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const result = await active.cancelEntryReceive(entryId, attemptId);
      this.view.message = `接收操作：${result}`;
      this.view.receiveProgress = this.view.receiveProgress.filter((item: OhReceiveProgress): boolean =>
        item.entryId !== entryId || item.attemptId !== attemptId);
    });
  }

  async cancelInboundTransfer(transferId: string): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const result = await active.cancelInboundTransfer(transferId);
      this.view.message = `传输操作：${result}`;
      if (result === 'cancelled' || result === 'not_inflight') {
        if (this.view.transferProgress?.transferId === transferId) this.view.transferProgress = undefined;
        if (this.view.transferStatus?.transferId === transferId) this.view.transferStatus = undefined;
      }
    });
  }

  async queryNetworkRecoveryStatus(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      this.view.networkRecovery = await active.queryNetworkRecoveryStatus();
    });
  }

  async updateSyncSettings(patch: OhSyncSettingsPatch): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const result = await active.updateSyncSettings(patch);
      if (result.kind !== 'updated' || result.settings === undefined) throw new Error('SYNC_SETTINGS_REJECTED');
      this.view.syncSettings = result.settings;
      this.view.message = '同步设置已保存。';
    });
  }

  async unlock(passphrase: string): Promise<void> {
    if (passphrase.length === 0) throw new Error('EMPTY_PASSPHRASE');
    await this.perform(async (active: OhEngine): Promise<void> => {
      await active.unlockSpace(passphrase);
      this.view.unlocked = true;
      this.view.phase = 'ready';
      await this.refresh();
    });
  }

  async lock(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      await active.lockEncryption();
      this.view.unlocked = false;
      this.view.phase = 'setup';
      this.view.history = [];
      this.view.devices = [];
    });
  }

  async restore(entryId: string, mode: 'standard' | 'plain_text' | 'file_paths' = 'standard'): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const result = await active.restoreClipboard(entryId, mode);
      this.view.message = result === 'restored' ? '已恢复到系统剪贴板。' : '该记录的内容当前不可恢复。';
    });
  }

  async exportEntryFiles(entryId: string, destinationHandle: string): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      await active.exportEntryFiles(entryId, destinationHandle);
      this.view.message = '已将全部文件导出为 ZIP。';
    });
  }

  async loadHistoryResource(entryId: string, maxBytes: number = 4 * 1024 * 1024): Promise<{ bytes: Uint8Array; mimeType?: string }> {
    if (entryId.length === 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('INVALID_HISTORY_RESOURCE');
    }
    return this.withActive(async (active: OhEngine): Promise<{ bytes: Uint8Array; mimeType?: string }> => {
      const resource: OhHistoryResource = await active.getHistoryEntryResource(entryId);
      const declaredSize = Number(resource.sizeBytes);
      if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > maxBytes) {
        throw new Error('HISTORY_RESOURCE_TOO_LARGE');
      }
      let bytes = resource.inlineData;
      if (bytes === undefined && resource.blobId !== undefined) {
        const binary: OhBinaryResource = await active.readBlob(resource.blobId);
        bytes = binary.bytes;
      }
      if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
        throw new Error('HISTORY_RESOURCE_UNAVAILABLE');
      }
      return { bytes: new Uint8Array(bytes), mimeType: resource.mimeType };
    });
  }

  async deleteHistory(entryId: string): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      await active.deleteHistoryEntry(entryId);
      this.view.history = this.view.history.filter((item: OhHistoryEntry): boolean => item.entryId !== entryId);
    });
  }

  async resend(entryId: string): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const result = await active.resendEntry(entryId, []);
      this.view.message = result.kind === 'completed' ? '已重新加入发送队列。' : `无法重发：${result.kind}`;
    });
  }

  async loadRecoveryState(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      this.view.recovery = await active.queryProfileRecovery();
      this.view.encryption = await active.queryEncryptionState();
    });
  }

  async refreshSession(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => {
      const recovery = await active.recoverSession(true);
      this.view.unlocked = recovery.unlocked;
      await this.refreshAdmission(active);
      this.view.phase = this.view.unlocked ? 'ready' : 'setup';
      await this.refresh();
    });
  }

  async recoverNetwork(): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => { await active.recoverNetwork(); });
  }

  async notifyConnectivityOpportunity(reason: 'foreground' | 'system_wake' | 'network_changed'): Promise<void> {
    await this.perform(async (active: OhEngine): Promise<void> => { await active.notifyConnectivityOpportunity(reason); });
  }

  private async perform(operation: (engine: OhEngine) => Promise<void>): Promise<void> {
    if (this.active === undefined || this.closing || !this.foreground || this.view.busy) {
      throw new Error('SESSION_UNAVAILABLE');
    }
    this.view.busy = true;
    this.view.message = '';
    this.publish();
    try {
      this.operation = operation(this.active);
      await this.operation;
    } catch (_error) {
      this.view.message = '操作未完成，请检查输入、设备连接和权限后重试。';
      throw new Error('OPERATION_FAILED');
    } finally {
      this.view.busy = false;
      this.operation = undefined;
      this.publish();
    }
  }

  private async withActive<T>(operation: (engine: OhEngine) => Promise<T>): Promise<T> {
    if (this.active === undefined || this.closing || !this.foreground || this.view.busy) {
      throw new Error('SESSION_UNAVAILABLE');
    }
    this.view.busy = true;
    this.publish();
    try {
      this.operation = operation(this.active);
      return await this.operation as T;
    } catch (_error) {
      this.view.message = '历史内容暂时不可用。';
      throw new Error('OPERATION_FAILED');
    } finally {
      this.view.busy = false;
      this.operation = undefined;
      this.publish();
    }
  }

  private async refreshAdmission(active: OhEngine): Promise<void> {
    const snapshot = JSON.parse(await active.queryDeviceGroupChoices()) as AdmissionSnapshot;
    const current = snapshot.device_trust.current_join;
    if (current === null) return;
    const encryption = await active.queryEncryptionState();
    const recovery = await active.queryProfileRecovery();
    if (this.closing || this.active !== active || !this.foreground) return;
    this.view.joinId = current.join_id;
    this.view.joinStatus = current.status;
    this.view.encryption = encryption;
    this.view.recovery = recovery;
    this.view.unlocked = encryption.sessionReady && (this.view.unlocked || current.status === 'active');
    this.view.phase = this.view.unlocked ? 'ready' : 'setup';
    this.publish();
  }

  private async refreshAdmissionFromEvent(active: OhEngine): Promise<void> {
    // Read admission after an in-flight command so its pending result cannot overwrite completion.
    while (this.operation !== undefined) await this.operation.catch(() => {});
    if (this.closing || this.active !== active || !this.foreground || this.view.phase === 'error') return;
    try {
      await this.perform(async (): Promise<void> => {
        await this.refreshAdmission(active);
        await this.refresh();
      });
    } catch (_error) {
      // Keep the event consumer alive so a later invalidation or explicit refresh can retry.
    }
  }

  private async refresh(): Promise<void> {
    const active = this.active;
    if (active === undefined || !this.view.unlocked) return;
    this.view.deviceName = (await active.queryLocalDevice()).displayName;
    const entry = await active.queryActiveClipboard();
    this.view.activeEntryId = entry === null ? '' : entry.entryId;
    this.publish();
  }

  private async consumeEvents(active: OhEngine): Promise<void> {
    try {
      while (!this.closing && this.active === active) {
        const event = await active.nextEvent(500);
        if (event === null || this.closing || this.active !== active) continue;
        if (event.kind === 'fatal' || event.kind === 'lifecycle_failed') {
          this.view.phase = 'error';
          this.view.message = '连接已中断，请重新打开应用。';
          this.publish();
        } else if (event.kind === 're_pairing_required') {
          this.view.message = '设备关系已失效，请重新配对。';
          this.publish();
        } else if (event.kind === 'transfer_progress' && event.transferProgress !== undefined) {
          this.view.transferProgress = event.transferProgress;
          this.publish();
        } else if (event.kind === 'transfer_status' && event.transferStatus !== undefined) {
          this.view.transferStatus = event.transferStatus;
          this.publish();
        } else if (event.kind === 'network_recovery_changed' && event.networkRecoveryPhase !== undefined) {
          this.view.networkRecovery = {
            phase: event.networkRecoveryPhase,
            retryable: event.retryable === true,
            nextRetryInMs: event.nextRetryInMs
          };
          this.publish();
        } else if (event.kind === 'profile_recovery_changed' && event.profileRecovery !== undefined) {
          this.view.recovery = event.profileRecovery;
          this.publish();
        } else if (event.kind === 'settings_changed' && event.settingsSections?.includes('sync')) {
          await this.refreshSyncSettings(active);
        } else if (this.foreground && (event.kind === 'refresh_required' || event.kind === 'device_trust_changed')) {
          await this.refreshAdmissionFromEvent(active);
        } else if (this.foreground && (event.kind === 'active_clipboard_changed' || event.kind === 'incoming_entry')) {
          await this.refresh();
        }
      }
    } catch (_error) {
      if (!this.closing && this.active === active) {
        this.view.message = '状态更新中断，请重新打开应用。';
        this.publish();
      }
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.starting?.catch(() => {});
    await this.transition.catch(() => {});
    const active = this.active;
    if (active !== undefined) await active.shutdownUntilComplete();
    await this.operation?.catch(() => {});
    this.active = undefined;
    await this.events;
    this.view = { phase: 'closed', busy: false, unlocked: false, deviceName: '', activeEntryId: '', invitationCode: '', invitationExpiresAt: 0, joinId: '', joinStatus: '', message: '', history: [], devices: [], receiveProgress: [] };
    this.publish();
  }

  private publish(): void { this.listener?.(this.snapshot()); }

  private deliveryMessage(report: OhSendReport): string {
    return `已接收 ${report.totalAccepted} · 重复 ${report.totalDuplicate} · 离线 ${report.totalOffline} · 等待 ${report.totalPending} · 失败 ${report.totalErrored}`;
  }

  private async refreshSyncSettings(active: OhEngine): Promise<void> {
    try {
      this.view.syncSettings = await active.querySyncSettings();
      this.publish();
    } catch (_error) {
      this.view.message = '同步设置状态暂时不可用。';
      this.publish();
    }
  }
}

import { common, abilityAccessCtrl } from '@kit.AbilityKit';
import { engineRuntime } from '../engine/EngineRuntime';
import { SessionView } from '../engine/EngineSession';
import type { OhHistoryEntry, OhDevice, OhReceiveProgress } from 'libuc_ohos_napi.so';

@Entry
@Component
struct Index {
  @State private view: SessionView = engineRuntime.session.snapshot();
  @State private deviceName: string = '鸿蒙设备';
  @State private passphrase: string = '';
  @State private confirmation: string = '';
  @State private invitation: string = '';
  @State private draft: string = '';
  @State private feedback: string = '';
  @State private handlingAction: boolean = false;
  @State private joining: boolean = false;
  @State private unlocking: boolean = false;
  @State private newPassphrase: string = '';
  @State private newConfirmation: string = '';
  @State private search: string = '';
  @State private tab: string = 'send';
  @State private previewEntryId: string = '';
  @State private previewSource: string = '';
  @State private exportingDiagnostics: boolean = false;
  @State private diagnosticMessage: string = '';
  private readonly incomingShare = (text: string): void => {
    this.draft = text;
    this.tab = 'send';
    this.feedback = '已收到系统分享文字，请确认后发送。';
  };

  aboutToAppear(): void {
    engineRuntime.observeIncomingShare(this.incomingShare);
    const sharedText = engineRuntime.takeIncomingSharedText();
    if (sharedText !== undefined) this.incomingShare(sharedText);
    engineRuntime.session.observe((view: SessionView): void => {
      this.view = view;
      if (view.recovery?.state === 'awaiting_passphrase') this.unlocking = true;
    });
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    engineRuntime.start(context).catch(() => { this.feedback = '启动失败，请退出应用后重试。'; });
  }

  aboutToDisappear(): void {
    engineRuntime.clearIncomingShareObserver(this.incomingShare);
    engineRuntime.session.detach();
    this.passphrase = '';
    this.confirmation = '';
    this.invitation = '';
    this.draft = '';
    this.newPassphrase = '';
    this.newConfirmation = '';
  }

  private async runAction(operation: () => Promise<void>, failureMessage: string): Promise<void> {
    if (this.handlingAction || this.view.busy) return;
    this.handlingAction = true;
    this.feedback = '';
    engineRuntime.session.clearOperationMessage();
    try {
      await operation();
    } catch (_error) {
      this.feedback = failureMessage;
    } finally {
      this.handlingAction = false;
    }
  }

  private async setup(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      try {
        if (this.joining) {
          await engineRuntime.session.joinSpace(this.invitation, this.deviceName, this.passphrase);
        } else {
          await engineRuntime.session.createSpace(this.deviceName, this.passphrase, this.confirmation);
        }
      } finally {
        this.passphrase = '';
        this.confirmation = '';
        this.invitation = '';
      }
    }, '未完成设置，请检查邀请码、口令和连接。');
  }

  private async send(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.sendText(this.draft);
      this.draft = '';
    }, '发送未完成，内容已保留，可重试。');
  }

  private async unlock(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.unlock(this.passphrase);
      this.passphrase = '';
    }, '解锁未完成，请检查空间口令。');
  }

  private async observe(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      if (!(await this.ensurePastePermission())) return;
      await engineRuntime.session.observeClipboard(true);
    }, '剪贴板同步未完成，请检查权限和同步设置。');
  }

  private async sendImage(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      if (!(await this.ensurePastePermission())) return;
      await engineRuntime.sendClipboardImage();
    }, '图片发送未完成，请检查剪贴板图片、同步设置和连接后重试。');
  }

  private async loadHistory(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.loadHistory(this.search);
    }, '历史记录暂时不可用。');
  }

  private async loadMoreHistory(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.loadMoreHistory();
    }, '更多历史暂时不可用。');
  }

  private async loadDevices(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.loadDevices();
    }, '设备列表暂时不可用。');
  }

  private async loadSettings(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.loadSyncSettings();
    }, '同步设置暂时不可用。');
  }

  private async loadProgress(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.loadReceiveProgress();
    }, '传输进度暂时不可用。');
  }

  private async previewImage(item: OhHistoryEntry): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      this.previewSource = await engineRuntime.imagePreview(item.entryId);
      this.previewEntryId = item.entryId;
    }, '图片预览暂时不可用。');
  }

  private async toggleSync(enabled: boolean): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.updateSyncSettings({ syncEnabled: enabled });
    }, '同步设置未能保存。');
  }

  private async pickFiles(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      await engineRuntime.sendFiles(context);
    }, '文件发送未完成，选择已取消或文件不可读。');
  }

  private async exportItem(item: OhHistoryEntry): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      await engineRuntime.start(context);
      const exported = await engineRuntime.exportEntryFiles(item.entryId);
      if (!exported) this.feedback = '已取消导出 ZIP。';
    }, 'ZIP 导出未完成，请检查文件是否可用及保存位置的空间；目标可能留有不完整文件。');
  }

  private async exportDiagnostics(): Promise<void> {
    this.exportingDiagnostics = true;
    this.diagnosticMessage = '';
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.diagnosticMessage = await engineRuntime.exportDiagnostics(context);
    } catch (_error) {
      this.diagnosticMessage = '诊断导出未完成，请检查保存位置和可用空间。';
    } finally {
      this.exportingDiagnostics = false;
    }
  }

  private async cancelProgress(item: OhReceiveProgress): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.cancelReceive(item.entryId, item.attemptId);
    }, '取消接收未完成。');
  }

  private async cancelTransfer(transferId: string): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.cancelInboundTransfer(transferId);
    }, '取消传输未完成。');
  }

  private async changePassphrase(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.changePassphrase(this.newPassphrase, this.newConfirmation);
      this.newPassphrase = '';
      this.newConfirmation = '';
    }, '口令未更新，请确认两次输入一致。');
  }

  private async ensurePastePermission(): Promise<boolean> {
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const result = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, ['ohos.permission.READ_PASTEBOARD']);
      if (result.authResults.length === 0 || result.authResults[0] !== 0) {
        this.feedback = '未获得剪贴板权限。';
        return false;
      }
      return true;
    } catch (_error) {
      this.feedback = '无法申请剪贴板权限。';
      return false;
    }
  }

  private async restore(item: OhHistoryEntry): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      await engineRuntime.session.restore(item.entryId, item.contentType === 'text' ? 'plain_text' : 'standard');
    }, '恢复剪贴板未完成。');
  }

  private async paste(): Promise<void> {
    await this.runAction(async (): Promise<void> => {
      if (!(await this.ensurePastePermission())) return;
      this.draft = engineRuntime.clipboard.readText();
    }, '无法读取剪贴板，可直接输入文字。');
  }

  build() {
    Scroll() {
      Column({ space: 20 }) {
        Text('UniClipboard').fontSize(30).fontWeight(FontWeight.Bold).width('100%')
        Text('让设备共享剪贴板').fontSize(16).fontColor('#64748B').width('100%')
        if (this.view.phase === 'starting' || this.view.phase === 'idle') {
          LoadingProgress().width(40).height(40)
          Text('正在打开加密空间…')
        } else if (!this.view.unlocked && this.view.phase !== 'error') {
          if (this.view.recovery?.state === 'admission_recovery_required') {
            Text('当前加密空间需要恢复处理，不能直接创建或加入新空间。').fontSize(14).fontColor('#B3261E').width('100%')
            if (this.view.recovery.admission !== undefined) {
              Text(`恢复动作：${this.view.recovery.admission.action}`).fontSize(14).width('100%')
            }
          } else if (this.view.recovery?.state === 'awaiting_passphrase') {
            Text('检测到已有加密空间，请输入口令恢复会话。').fontSize(14).fontColor('#64748B').width('100%')
          }
          Column({ space: 12 }) {
            Row({ space: 12 }) {
              Button('创建空间').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction &&
                (this.view.recovery === undefined || this.view.recovery.state === 'not_required')).onClick(() => {
                this.joining = false;
                this.unlocking = false;
              })
              Button('加入空间').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction &&
                (this.view.recovery === undefined || this.view.recovery.state === 'not_required')).onClick(() => {
                this.joining = true;
                this.unlocking = false;
              })
            }.width('100%')
            Button('解锁已有空间').width('100%').enabled(!this.view.busy && !this.handlingAction && this.view.recovery?.state !== 'admission_recovery_required').onClick(() => {
              this.joining = false;
              this.unlocking = true;
            })
          }.width('100%')
          TextInput({ text: this.deviceName, placeholder: '设备名称' }).onChange((value: string) => { this.deviceName = value; })
          if (this.joining) {
            TextInput({ text: this.invitation, placeholder: '另一台设备的邀请码' }).onChange((value: string) => { this.invitation = value; })
          }
          if (this.unlocking) {
            Text('此设备已有加密空间，请输入口令恢复会话。').fontSize(14).fontColor('#64748B')
          }
          TextInput({ text: this.passphrase, placeholder: '空间口令' }).type(InputType.Password).onChange((value: string) => { this.passphrase = value; })
          if (!this.joining && !this.unlocking) {
            TextInput({ text: this.confirmation, placeholder: '再次输入口令' }).type(InputType.Password).onChange((value: string) => { this.confirmation = value; })
          }
          Button(this.view.busy || this.handlingAction ? '正在处理…' : this.unlocking ? '解锁加密空间' : this.joining ? '加入加密空间' : '创建加密空间')
            .width('100%').enabled(!this.view.busy && !this.handlingAction && this.passphrase.length > 0).onClick(() => { this.unlocking ? this.unlock() : this.setup(); })
          if (this.view.joinStatus.length > 0) {
            Text(`配对状态：${this.view.joinStatus}`).fontSize(14)
            Button('刷新配对状态').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.refreshSession(); }, '配对状态暂时不可用。'); })
            if (this.view.joinStatus === 'pending' || this.view.joinStatus === 'processing') {
              Button('取消加入').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.cancelJoin(); }, '取消加入未完成。'); })
            }
          }
        } else if (this.view.unlocked) {
          Text(this.view.deviceName).fontWeight(FontWeight.Medium).width('100%')
          Text(this.view.phase === 'ready' ? '前台接收已启用；进入后台后暂停连接。' : '当前会话未就绪，接收状态尚未确认。')
            .fontSize(14).fontColor('#64748B').width('100%')
          Row({ space: 8 }) {
            Button('发送').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.tab = 'send'; })
            Button('历史').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.tab = 'history'; this.loadHistory(); })
            Button('设备').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.tab = 'devices'; this.loadDevices(); })
            Button('设置').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.tab = 'settings'; this.loadSettings(); })
          }
          if (this.tab === 'send') {
            TextArea({ text: this.draft, placeholder: '输入或粘贴要发送的文字' }).height(180).onChange((value: string) => { this.draft = value; })
            Column({ space: 12 }) {
              Row({ space: 12 }) {
                Button('读取剪贴板').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.paste(); })
                Button('发送文字').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction && this.draft.length > 0).onClick(() => { this.send(); })
              }.width('100%')
              Row({ space: 12 }) {
                Button('发送图片').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.sendImage(); })
                Button('发送文件').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.pickFiles(); })
              }.width('100%')
            }.width('100%')
            Button('观察并同步当前剪贴板').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.observe(); })
            Divider()
            Button('邀请设备').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.invite(); }, '邀请码暂时不可用。'); })
            if (this.view.invitationCode.length > 0) {
              Text(this.view.invitationCode).copyOption(CopyOptions.InApp).fontSize(20)
              Text(`有效期至 ${new Date(this.view.invitationExpiresAt).toLocaleTimeString()}`).fontSize(12)
            }
            Button('恢复网络连接').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.recoverNetwork(); }, '网络恢复未完成。'); })
            if (this.view.transferProgress !== undefined) {
              Text(`传输 ${this.view.transferProgress.direction === 'sending' ? '发送' : '接收'}：${this.view.transferProgress.completedBytes}${this.view.transferProgress.totalBytes === undefined ? '' : ` / ${this.view.transferProgress.totalBytes}`} 字节`).fontSize(13)
              if (this.view.transferProgress.direction === 'receiving') {
                Button('取消当前接收').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.cancelTransfer(this.view.transferProgress?.transferId ?? ''); })
              }
            }
            if (this.view.transferStatus !== undefined) {
              Text(`传输状态：${this.view.transferStatus.status}`).fontSize(13)
            }
            if (this.view.networkRecovery !== undefined && this.view.networkRecovery.phase !== 'idle') {
              Text(`网络恢复：${this.view.networkRecovery.phase}`).fontSize(13)
            }
          } else if (this.tab === 'history') {
            TextInput({ text: this.search, placeholder: '搜索历史（由 Engine 执行加密查询）' }).onChange((value: string) => { this.search = value; })
            Button('搜索/刷新').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.loadHistory(); })
            ForEach(this.view.history, (item: OhHistoryEntry) => {
              Row({ space: 8 }) {
                Column() {
                  Text(item.contentType).fontWeight(FontWeight.Medium)
                  Text(item.preview === undefined ? item.entryId : item.preview).maxLines(2).fontSize(13)
                }.layoutWeight(1)
                Column({ space: 8 }) {
                  Row({ space: 8 }) {
                    Button('恢复').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.restore(item); })
                    if (item.contentType === 'file') {
                      Button('导出 ZIP').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.exportItem(item); })
                    }
                  }.width('100%')
                  if (item.contentType === 'image') {
                    Button('预览').width('100%').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.previewImage(item); })
                  }
                  Row({ space: 8 }) {
                    Button('重发').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.resend(item.entryId); }, '重发未完成。'); })
                    Button('删除').layoutWeight(1).enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.deleteHistory(item.entryId); }, '删除记录未完成。'); })
                  }.width('100%')
                }.layoutWeight(1)
              }.width('100%').padding(8).backgroundColor('#FFFFFF')
              if (this.previewEntryId === item.entryId && this.previewSource.length > 0) {
                Image(this.previewSource).width('100%').height(220).objectFit(ImageFit.Contain)
              }
            })
            if (this.view.historyNextCursor !== undefined) {
              Button('加载更多').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.loadMoreHistory(); })
            }
            Button('刷新接收进度').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.loadProgress(); })
            ForEach(this.view.receiveProgress, (progress: OhReceiveProgress) => {
              Row({ space: 8 }) {
                Text(`${progress.completedBytes} / ${progress.totalBytes} 字节`).layoutWeight(1)
                Button('取消').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.cancelProgress(progress); })
              }.width('100%').padding(8).backgroundColor('#FFFFFF')
            })
          } else if (this.tab === 'devices') {
            Button('刷新设备').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.loadDevices(); })
            ForEach(this.view.devices, (device: OhDevice) => {
              Row({ space: 8 }) {
                Text(device.displayName).layoutWeight(1)
                Text(device.isLocal ? '本机' : device.online ? '在线' : '离线').fontSize(13)
                if (!device.isLocal) {
                  Button('移除').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.removeMember(device.deviceId); }, '移除设备未完成。'); })
                }
              }.width('100%').padding(8).backgroundColor('#FFFFFF')
            })
          } else {
            Button('刷新设置').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.loadSettings(); })
            if (this.view.syncSettings !== undefined) {
              Toggle({ type: ToggleType.Switch, isOn: this.view.syncSettings.syncEnabled })
                .enabled(!this.view.busy && !this.handlingAction)
                .onChange((value: boolean) => { this.toggleSync(value); })
                .width('100%')
              Text(this.view.syncSettings.syncEnabled ? '允许向配对设备同步' : '已暂停向配对设备同步').fontSize(14)
              Toggle({ type: ToggleType.Switch, isOn: this.view.syncSettings.autoSyncEnabled })
                .enabled(!this.view.busy && !this.handlingAction)
                .onChange((value: boolean) => { this.runAction(async (): Promise<void> => { await engineRuntime.session.updateSyncSettings({ autoSyncEnabled: value }); }, '自动同步设置未能保存。'); })
                .width('100%')
              Text(this.view.syncSettings.autoSyncEnabled ? '自动同步已开启' : '自动同步已关闭').fontSize(14)
              Text('关闭后仍保留本机历史，可手动发送。').fontSize(13)
            }
            TextInput({ text: this.newPassphrase, placeholder: '新空间口令' }).type(InputType.Password)
              .onChange((value: string) => { this.newPassphrase = value; })
            TextInput({ text: this.newConfirmation, placeholder: '再次输入新口令' }).type(InputType.Password)
              .onChange((value: string) => { this.newConfirmation = value; })
            Button('更新空间口令').enabled(!this.view.busy && !this.handlingAction && this.newPassphrase.length > 0)
              .onClick(() => { this.changePassphrase(); })
            Button('刷新网络恢复状态').enabled(!this.view.busy && !this.handlingAction)
              .onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.queryNetworkRecoveryStatus(); }, '网络状态暂时不可用。'); })
            Button('导出诊断日志').enabled(!this.exportingDiagnostics && !this.view.busy && !this.handlingAction)
              .onClick(() => { this.exportDiagnostics(); })
            Text('仅导出运行诊断；通过系统文件窗口保存到你选择的位置。').fontSize(13)
            if (this.diagnosticMessage.length > 0) { Text(this.diagnosticMessage).fontSize(13) }
            Button('锁定加密空间').enabled(!this.view.busy && !this.handlingAction).onClick(() => { this.runAction(async (): Promise<void> => { await engineRuntime.session.lock(); }, '锁定加密空间未完成。'); })
          }
        }
        if (this.feedback.length > 0) {
          Text(this.feedback).fontSize(14).fontColor('#B3261E')
        } else if (this.view.message.length > 0) {
          Text(this.view.message).fontSize(14)
        }
      }.padding(24).width('100%').alignItems(HorizontalAlign.Start)
    }.width('100%').height('100%').backgroundColor('#F8FAFC')
  }
}

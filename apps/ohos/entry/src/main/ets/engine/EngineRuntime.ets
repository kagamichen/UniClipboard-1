import engine from '@uniclipboard/engine';
import { common, Want } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import type { OhEngine, OhStartupLifecycle, OhLocalDiagnosticExportReport } from 'libuc_ohos_napi.so';
import { EngineSession, EngineFactory } from './EngineSession';
import { createEngineHost } from '../host/EngineHost';
import { SecureAssetStorage } from '../host/SecureAssetStorage';
import { FileHandleRegistry } from '../host/FileHandleRegistry';
import { ClipboardAdapter } from '../host/ClipboardAdapter';
import { DocumentPicker } from '../host/DocumentPicker';
import { DiagnosticLogReader, DiagnosticLogSnapshot } from '../host/DiagnosticLogReader';
import { NetworkMonitor } from '../host/NetworkMonitor';
import { extractSharedText } from '../host/ShareIntent';
import type { OhClipboardRepresentation } from 'libuc_ohos_napi.so';

interface DiagnosticBundle {
  schemaVersion: number;
  createdAtMs: number;
  report: OhLocalDiagnosticExportReport;
  logs: DiagnosticLogSnapshot;
}

class NativeFactory implements EngineFactory {
  readonly lifecycle: OhStartupLifecycle = engine.createStartupLifecycle();
  private context: common.UIAbilityContext;
  private storage: SecureAssetStorage;
  private files: FileHandleRegistry;
  private clipboard: ClipboardAdapter;

  constructor(context: common.UIAbilityContext, storage: SecureAssetStorage, files: FileHandleRegistry, clipboard: ClipboardAdapter) {
    this.context = context;
    this.storage = storage;
    this.files = files;
    this.clipboard = clipboard;
  }

  start(): Promise<OhEngine> {
    const host = createEngineHost(this.context, this.storage, this.files, this.clipboard);
    engine.installProcessObservability({
      serviceVersion: '0.1.0', environment: 'production', appChannel: 'beta', remoteDiagnosticsEnabled: false
    }, {
      privateDataDirectory: host.privateDataDirectory,
      cacheDirectory: host.cacheDirectory,
      temporaryDirectory: host.temporaryDirectory
    });
    return engine.startEngine({ appVersion: '0.1.0', profileId: 'default' }, engine.prepareHost(host), this.lifecycle);
  }
}

class EngineRuntime {
  readonly session: EngineSession = new EngineSession();
  readonly clipboard: ClipboardAdapter = new ClipboardAdapter();
  private readonly storage: SecureAssetStorage = new SecureAssetStorage();
  private readonly files: FileHandleRegistry = new FileHandleRegistry();
  private readonly network = new NetworkMonitor();
  private picker?: DocumentPicker;
  private pendingSharedText?: string;
  private shareListener?: (text: string) => void;

  acceptIncomingWant(want: Want): void {
    const text = extractSharedText(want);
    if (text === undefined) return;
    this.pendingSharedText = text;
    this.shareListener?.(text);
  }

  takeIncomingSharedText(): string | undefined {
    const text = this.pendingSharedText;
    this.pendingSharedText = undefined;
    return text;
  }

  observeIncomingShare(listener: (text: string) => void): void {
    this.shareListener = listener;
  }

  clearIncomingShareObserver(listener: (text: string) => void): void {
    if (this.shareListener === listener) this.shareListener = undefined;
  }

  start(context: common.UIAbilityContext): Promise<void> {
    if (this.picker === undefined) this.picker = new DocumentPicker(context, this.files);
    return this.session.start(new NativeFactory(context, this.storage, this.files, this.clipboard)).then((): void => {
      this.clipboard.subscribe((): void => {
        if (this.session.snapshot().busy) return;
        this.session.observeClipboard(true).catch(() => {});
      });
      this.network.start((): void => {
        this.session.notifyConnectivityOpportunity('network_changed').catch(() => {});
      });
      this.session.notifyConnectivityOpportunity('foreground').catch(() => {});
    });
  }

  async sendFiles(context: common.UIAbilityContext): Promise<void> {
    if (this.picker === undefined) this.picker = new DocumentPicker(context, this.files);
    const picker = this.picker;
    await picker.withInputFiles(20, async (handles: string[]): Promise<void> => {
      await this.session.sendFiles(handles);
    });
  }

  async sendClipboardImage(): Promise<void> {
    const snapshot = await this.clipboard.read();
    const representation = snapshot.representations.find((item: OhClipboardRepresentation): boolean =>
      item.kind === 'inline' && item.mimeType === 'image/png' && item.bytes !== undefined);
    if (representation === undefined || representation.bytes === undefined) {
      throw new Error('OHOS_CLIPBOARD_IMAGE_UNAVAILABLE');
    }
    await this.session.sendClipboardImage(representation.bytes, representation.mimeType ?? 'image/png');
  }

  async exportEntryFiles(entryId: string): Promise<boolean> {
    if (this.picker === undefined) throw new Error('OHOS_PICKER_UNAVAILABLE');
    const result = await this.picker.withOutputFile('UniClipboard-files.zip', async (handle: string): Promise<boolean> => {
      await this.session.exportEntryFiles(entryId, handle);
      return true;
    });
    return result === true;
  }

  async exportDiagnostics(context: common.UIAbilityContext): Promise<string> {
    if (this.picker === undefined) this.picker = new DocumentPicker(context, this.files);
    const result = await this.picker.withOutputFile('UniClipboard-diagnostics.json', async (handle: string): Promise<boolean> => {
      const report = await engine.prepareLocalDiagnosticExport(2000);
      const logs = new DiagnosticLogReader().collect(`${context.cacheDir}/logs`);
      const bundle: DiagnosticBundle = { schemaVersion: 1, createdAtMs: Date.now(), report, logs };
      const bytes = new util.TextEncoder().encodeInto(JSON.stringify(bundle));
      try {
        this.files.fileWriteChunk(handle, '0', bytes);
        this.files.fileFinishWrite(handle);
      } finally {
        bytes.fill(0);
      }
      return logs.partial || report.flush !== 'completed';
    });
    if (result === null) return '已取消诊断导出。';
    return result ? '已导出诊断，部分日志缺失或已截断，请查看导出报告。' : '已导出诊断日志。';
  }

  async imagePreview(entryId: string): Promise<string> {
    const resource = await this.session.loadHistoryResource(entryId, 4 * 1024 * 1024);
    const mimeType = resource.mimeType ?? 'image/png';
    if (!mimeType.startsWith('image/')) throw new Error('OHOS_HISTORY_IMAGE_UNAVAILABLE');
    try {
      const encoded = new util.Base64Helper().encodeToStringSync(resource.bytes);
      return `data:${mimeType};base64,${encoded}`;
    } finally {
      resource.bytes.fill(0);
    }
  }

  onForeground(): void {
    this.session.setForeground(true)
      .then(() => this.session.notifyConnectivityOpportunity('foreground'))
      .catch(() => {});
  }
  onBackground(): void { this.session.setForeground(false).catch(() => {}); }

  async shutdown(): Promise<void> {
    this.picker?.close();
    this.clipboard.unsubscribe();
    this.network.stop();
    await this.session.shutdown();
    this.files.clear();
  }

}

export const engineRuntime = new EngineRuntime();

import { picker } from '@kit.CoreFileKit';
import type { common } from '@kit.AbilityKit';
import { FileHandleRegistry } from './FileHandleRegistry';

export class DocumentPicker {
  private readonly view: picker.DocumentViewPicker;
  private readonly files: FileHandleRegistry;
  private busy: boolean = false;
  private closed: boolean = false;

  constructor(context: common.UIAbilityContext, files: FileHandleRegistry) {
    this.files = files;
    try {
      this.view = new picker.DocumentViewPicker(context);
    } catch (_error) {
      throw new Error('OHOS_PICKER_UNAVAILABLE');
    }
  }

  /** Handles remain valid until the consumer settles. A cancelled selection returns null. */
  async withInputFiles<T>(maxFiles: number, consume: (handles: string[]) => Promise<T>): Promise<T | null> {
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 500) {
      throw new Error('OHOS_PICKER_INVALID_LIMIT');
    }
    this.begin();
    const handles: string[] = [];
    try {
      const uris = await this.select(maxFiles);
      this.requireOpen();
      if (uris.length === 0) return null;
      this.validateSelection(uris, maxFiles);
      for (const uri of uris) handles.push(this.files.registerInput(uri));
      return await consume(handles.slice());
    } finally {
      try {
        this.files.release(handles);
      } finally {
        this.busy = false;
      }
    }
  }

  /** The selected output is truncated once; a failed export may leave partial output. */
  async withOutputFile<T>(fileName: string, consume: (handle: string) => Promise<T>): Promise<T | null> {
    if (fileName.length === 0 || fileName === '.' || fileName === '..' || /[/\\\u0000]/.test(fileName)) {
      throw new Error('OHOS_PICKER_INVALID_NAME');
    }
    this.begin();
    const handles: string[] = [];
    try {
      const uris = await this.save(fileName);
      this.requireOpen();
      if (uris.length === 0) return null;
      this.validateSelection(uris, 1);
      const handle = this.files.registerOutput(uris[0]);
      handles.push(handle);
      return await consume(handle);
    } finally {
      try {
        this.files.release(handles);
      } finally {
        this.busy = false;
      }
    }
  }

  /** Prevents late picker results from starting work; active consumers retain their handles. */
  close(): void {
    this.closed = true;
  }

  private begin(): void {
    this.requireOpen();
    if (this.busy) throw new Error('OHOS_PICKER_BUSY');
    this.busy = true;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('OHOS_PICKER_UNAVAILABLE');
  }

  private validateSelection(uris: string[], maxFiles: number): void {
    if (uris.length > maxFiles || uris.some((uri: string): boolean => uri.length === 0)) {
      throw new Error('OHOS_PICKER_INVALID_SELECTION');
    }
  }

  private async select(maxFiles: number): Promise<string[]> {
    try {
      return await this.view.select({ maxSelectNumber: maxFiles });
    } catch (_error) {
      throw new Error('OHOS_PICKER_FAILED');
    }
  }

  private async save(fileName: string): Promise<string[]> {
    try {
      return await this.view.save({ newFileNames: [fileName] });
    } catch (_error) {
      throw new Error('OHOS_PICKER_FAILED');
    }
  }
}

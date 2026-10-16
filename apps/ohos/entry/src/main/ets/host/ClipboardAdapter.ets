import { pasteboard } from '@kit.BasicServicesKit';
import type { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { ImageClipboardCodec } from './ImageClipboardCodec';
import type { OhClipboardSnapshot, OhClipboardRepresentation } from 'libuc_ohos_napi.so';

export class ClipboardAdapter {
  private readonly system = pasteboard.getSystemPasteboard();
  private readonly images = new ImageClipboardCodec({ maxEncodedBytes: 16 * 1024 * 1024, maxPixels: 16 * 1024 * 1024 });
  private updateHandler?: () => void;
  private suppressUpdates: number = 0;

  subscribe(callback: () => void): void {
    this.unsubscribe();
    this.updateHandler = (): void => {
      if (this.suppressUpdates === 0) callback();
    };
    try {
      this.system.on('update', this.updateHandler);
    } catch (_error) {
      this.updateHandler = undefined;
      throw new Error('OHOS_CLIPBOARD_UNAVAILABLE');
    }
  }

  unsubscribe(): void {
    if (this.updateHandler !== undefined) {
      try {
        this.system.off('update', this.updateHandler);
      } catch (_error) {
      } finally {
        this.updateHandler = undefined;
      }
    }
  }

  readText(): string {
    try {
      return this.primaryText(this.system.getDataSync());
    } catch (error) {
      if ((error as BusinessError).code === 201) throw new Error('OHOS_CLIPBOARD_PERMISSION_DENIED');
      throw new Error('OHOS_CLIPBOARD_UNAVAILABLE');
    }
  }

  async read(): Promise<OhClipboardSnapshot> {
    try {
      const data = this.system.getDataSync();
      const representations: OhClipboardRepresentation[] = [];
      const mimeType = data.getPrimaryMimeType();
      if (mimeType === pasteboard.MIMETYPE_PIXELMAP) {
        const pixelMap = data.getPrimaryPixelMap();
        if (pixelMap === undefined || pixelMap === null) throw new Error('OHOS_CLIPBOARD_UNAVAILABLE');
        try {
          const bytes = await this.images.encodePng(pixelMap);
          representations.push({ kind: 'inline', format: 'image/png', mimeType: 'image/png', bytes });
        } finally {
          await pixelMap.release();
        }
      } else if (mimeType === pasteboard.MIMETYPE_TEXT_URI || mimeType === 'text/uri-list') {
        const uris: string[] = [];
        let missingUri = false;
        const count = data.getRecordCount();
        for (let index = 0; index < count; index += 1) {
          const record = data.getRecord(index);
          if (record.mimeType !== pasteboard.MIMETYPE_TEXT_URI && record.mimeType !== 'text/uri-list') continue;
          const uri = record.uri ?? '';
          if (uri.length === 0) missingUri = true;
          else uris.push(uri);
        }
        // Pasteboard can retain URI records after removing every invalid URI.
        // An empty set has no payload; a partial set must not be sent as complete.
        if (uris.length > 0) {
          if (missingUri) throw new Error('OHOS_CLIPBOARD_UNAVAILABLE');
          representations.push({
            kind: 'inline', format: 'files', mimeType: 'text/uri-list',
            bytes: new util.TextEncoder().encodeInto(`${uris.join('\n')}\n`)
          });
        }
      } else {
        const text = this.primaryText(data);
        if (text.length > 0) {
          representations.push({
            kind: 'inline', format: 'text/plain', mimeType: 'text/plain',
            bytes: new util.TextEncoder().encodeInto(text)
          });
        }
      }
      return { observedAtMs: Date.now(), representations };
    } catch (error) {
      if ((error as BusinessError).code === 201) throw new Error('OHOS_CLIPBOARD_PERMISSION_DENIED');
      throw new Error('OHOS_CLIPBOARD_UNAVAILABLE');
    }
  }

  async write(snapshot: OhClipboardSnapshot): Promise<void> {
    try {
      const representation = snapshot.representations.find((item: OhClipboardRepresentation): boolean =>
        item.kind === 'inline' && item.mimeType === 'text/plain');
      if (representation !== undefined && representation.bytes !== undefined) {
        const text = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(representation.bytes);
        this.suppressUpdates += 1;
        try {
          this.system.setDataSync(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text));
        } finally {
          this.suppressUpdates -= 1;
        }
        return;
      }
      const uriList = snapshot.representations.find((item: OhClipboardRepresentation): boolean =>
        item.kind === 'inline' && item.mimeType === 'text/uri-list' && item.bytes !== undefined);
      if (uriList !== undefined && uriList.bytes !== undefined) {
        const text = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(uriList.bytes);
        const uris = text.split(/\r?\n/).map((value: string): string => value.trim())
          .filter((value: string): boolean => value.length > 0 && !value.startsWith('#'));
        if (uris.length === 0) throw new Error('OHOS_CLIPBOARD_UNAVAILABLE');
        this.suppressUpdates += 1;
        try {
          const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_URI, uris[0]);
          for (let index = 1; index < uris.length; index += 1) {
            data.addRecord(pasteboard.MIMETYPE_TEXT_URI, uris[index]);
          }
          this.system.setDataSync(data);
        } finally {
          this.suppressUpdates -= 1;
        }
        return;
      }
      const image = snapshot.representations.find((item: OhClipboardRepresentation): boolean =>
        item.kind === 'inline' && item.mimeType === 'image/png');
      if (image === undefined || image.bytes === undefined) throw new Error('OHOS_CLIPBOARD_UNAVAILABLE');
      await this.images.withDecodedImage(image.bytes, async (pixelMap): Promise<void> => {
        this.suppressUpdates += 1;
        try {
          this.system.setDataSync(pasteboard.createData(pasteboard.MIMETYPE_PIXELMAP, pixelMap));
        } finally {
          this.suppressUpdates -= 1;
        }
      });
    } catch (error) {
      if ((error as BusinessError).code === 201) throw new Error('OHOS_CLIPBOARD_PERMISSION_DENIED');
      throw new Error('OHOS_CLIPBOARD_UNAVAILABLE');
    }
  }

  private primaryText(data: pasteboard.PasteData): string {
    return data.getPrimaryText() ?? '';
  }
}

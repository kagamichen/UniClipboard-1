import { common } from '@kit.AbilityKit';
import type { OhHost, OhHostResult, OhClipboardSnapshot } from 'libuc_ohos_napi.so';
import { BusinessError } from '@kit.BasicServicesKit';
import { FileHandleRegistry, FileMetadata } from './FileHandleRegistry';
import { SecureAssetStorage } from './SecureAssetStorage';
import { ClipboardAdapter } from './ClipboardAdapter';

export function createEngineHost(
  context: common.UIAbilityContext,
  storage: SecureAssetStorage,
  files: FileHandleRegistry,
  clipboard: ClipboardAdapter
): OhHost {
  return {
    privateDataDirectory: context.filesDir,
    cacheDirectory: context.cacheDir,
    temporaryDirectory: context.tempDir,
    secureStorageGet: (key: string): OhHostResult<Uint8Array | null> =>
      hostResult((): Uint8Array | null => storage.get(key)),
    secureStorageSet: (key: string, value: Uint8Array): OhHostResult<void> =>
      hostResult((): void => storage.set(key, value)),
    secureStorageDelete: (key: string): OhHostResult<void> =>
      hostResult((): void => storage.delete(key)),
    fileMetadata: (handle: string): OhHostResult<FileMetadata> =>
      hostResult((): FileMetadata => files.fileMetadata(handle)),
    fileReadChunk: (handle: string, offset: string, maxBytes: number): OhHostResult<Uint8Array> =>
      hostResult((): Uint8Array => files.fileReadChunk(handle, offset, maxBytes)),
    fileWriteChunk: (handle: string, offset: string, bytes: Uint8Array): OhHostResult<void> =>
      hostResult((): void => files.fileWriteChunk(handle, offset, bytes)),
    fileFinishWrite: (handle: string): OhHostResult<void> =>
      hostResult((): void => files.fileFinishWrite(handle)),
    clipboardRead: (): OhHostResult<OhClipboardSnapshot> | Promise<OhHostResult<OhClipboardSnapshot>> =>
      hostResultAsync((): Promise<OhClipboardSnapshot> => clipboard.read()),
    clipboardWrite: (snapshot: OhClipboardSnapshot): OhHostResult<void> | Promise<OhHostResult<void>> =>
      hostResultAsync((): Promise<void> => clipboard.write(snapshot))
  };
}

function hostResult<T>(operation: () => T): OhHostResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, errorCategory: errorCategory(error) };
  }
}

function hostResultAsync<T>(operation: () => Promise<T>): Promise<OhHostResult<T>> {
  try {
    return operation().then((value: T): OhHostResult<T> => ({ ok: true, value }))
      .catch((error: Object): OhHostResult<T> => ({ ok: false, errorCategory: errorCategory(error) }));
  } catch (error) {
    const failure: OhHostResult<T> = { ok: false, errorCategory: errorCategory(error) };
    return Promise.resolve(failure);
  }
}

function errorCategory(error: Object): string {
  const code = (error as BusinessError).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 201 || message.includes('PERMISSION_DENIED')) return 'permission_denied';
  if (message.includes('INVALID_HANDLE')) return 'invalid_handle';
  if (message.includes('UNAVAILABLE')) return 'unavailable';
  return 'io';
}

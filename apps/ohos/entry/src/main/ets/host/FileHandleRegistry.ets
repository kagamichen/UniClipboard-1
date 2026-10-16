import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

export interface FileMetadata {
  displayName: string;
  sizeBytes: string;
  mimeType?: string;
}

interface FileEntry {
  file: fileIo.File;
  writable: boolean;
  finished: boolean;
}

export class FileHandleRegistry {
  private readonly entries: Map<string, FileEntry> = new Map<string, FileEntry>();

  registerInput(uri: string): string {
    return this.register(uri, false);
  }

  registerOutput(uri: string): string {
    return this.register(uri, true);
  }

  remove(handle: string): void {
    const entry = this.entries.get(handle);
    if (entry !== undefined) {
      this.entries.delete(handle);
      this.close(entry.file);
    }
  }

  release(handles: string[]): void {
    let failed = false;
    for (const handle of handles) {
      try {
        this.remove(handle);
      } catch (_error) {
        failed = true;
      }
    }
    if (failed) throw new Error('OHOS_FILE_IO');
  }

  clear(): void {
    this.release(Array.from(this.entries.keys()));
  }

  fileMetadata(handle: string): FileMetadata {
    const entry = this.requireEntry(handle);
    const stat = this.stat(entry.file.fd);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('OHOS_FILE_INVALID_SIZE');
    return { displayName: entry.file.name, sizeBytes: stat.size.toString() };
  }

  fileReadChunk(handle: string, offset: string, maxBytes: number): Uint8Array {
    const entry = this.requireEntry(handle);
    const start = this.offset(offset);
    this.validateRange(start, maxBytes);
    const buffer = new ArrayBuffer(maxBytes);
    try {
      const count = this.read(entry.file.fd, buffer, start, maxBytes);
      if (!Number.isInteger(count) || count < 0 || count > maxBytes) throw new Error('OHOS_FILE_IO');
      return new Uint8Array(buffer).slice(0, count);
    } finally {
      new Uint8Array(buffer).fill(0);
    }
  }

  fileWriteChunk(handle: string, offset: string, bytes: Uint8Array): void {
    const entry = this.requireEntry(handle);
    if (!entry.writable) {
      throw new Error('OHOS_FILE_PERMISSION_DENIED');
    }
    if (entry.finished) throw new Error('OHOS_FILE_FINISHED');
    const start = this.offset(offset);
    this.validateRange(start, bytes.byteLength);
    const copy = new Uint8Array(bytes);
    try {
      let written = 0;
      while (written < copy.byteLength) {
        const remaining = copy.slice(written);
        try {
          const count = this.write(entry.file.fd, remaining, start + written);
          if (!Number.isInteger(count) || count <= 0 || count > remaining.byteLength) {
            throw new Error('OHOS_FILE_IO');
          }
          written += count;
        } finally {
          remaining.fill(0);
        }
      }
    } finally {
      copy.fill(0);
    }
  }

  fileFinishWrite(handle: string): void {
    const entry = this.requireEntry(handle);
    if (!entry.writable) {
      throw new Error('OHOS_FILE_PERMISSION_DENIED');
    }
    if (!entry.finished) {
      this.sync(entry.file.fd);
      entry.finished = true;
    }
  }

  private register(uri: string, writable: boolean): string {
    const handle = util.generateRandomUUID();
    const mode = writable ? fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC : fileIo.OpenMode.READ_ONLY;
    const file = this.open(uri, mode);
    this.entries.set(handle, { file, writable, finished: false });
    return handle;
  }

  private requireEntry(handle: string): FileEntry {
    const entry = this.entries.get(handle);
    if (entry === undefined) {
      throw new Error('OHOS_FILE_INVALID_HANDLE');
    }
    return entry;
  }

  private offset(value: string): number {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('OHOS_FILE_INVALID_OFFSET');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error('OHOS_FILE_INVALID_OFFSET');
    }
    return parsed;
  }

  private validateRange(offset: number, length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset + length)) {
      throw new Error('OHOS_FILE_INVALID_OFFSET');
    }
  }

  private open(uri: string, mode: number): fileIo.File {
    try {
      return fileIo.openSync(uri, mode);
    } catch (_error) {
      throw new Error('OHOS_FILE_IO');
    }
  }

  private stat(fd: number): fileIo.Stat {
    try {
      return fileIo.statSync(fd);
    } catch (_error) {
      throw new Error('OHOS_FILE_IO');
    }
  }

  private read(fd: number, buffer: ArrayBuffer, offset: number, length: number): number {
    try {
      if (fileIo.lseek(fd, offset, fileIo.WhenceType.SEEK_SET) !== offset) throw new Error('OHOS_FILE_IO');
      return fileIo.readSync(fd, buffer, { length });
    } catch (_error) {
      throw new Error('OHOS_FILE_IO');
    }
  }

  private write(fd: number, bytes: Uint8Array, offset: number): number {
    try {
      if (fileIo.lseek(fd, offset, fileIo.WhenceType.SEEK_SET) !== offset) throw new Error('OHOS_FILE_IO');
      return fileIo.writeSync(fd, bytes.buffer, { length: bytes.byteLength });
    } catch (_error) {
      throw new Error('OHOS_FILE_IO');
    }
  }

  private sync(fd: number): void {
    try {
      fileIo.fsyncSync(fd);
    } catch (_error) {
      throw new Error('OHOS_FILE_IO');
    }
  }

  private close(file: fileIo.File): void {
    try {
      fileIo.closeSync(file);
    } catch (_error) {
      throw new Error('OHOS_FILE_IO');
    }
  }
}

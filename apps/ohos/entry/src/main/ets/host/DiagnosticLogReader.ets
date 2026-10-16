import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

export interface DiagnosticLogFile {
  name: string;
  originalBytes: number;
  readBytes: number;
  exportedBytes: number;
  status: 'complete' | 'truncated' | 'unreadable';
  content: string;
}

export interface DiagnosticLogSnapshot {
  files: DiagnosticLogFile[];
  omittedFileCount: number;
  partial: boolean;
}

export class DiagnosticLogReader {
  private readonly totalBudget: number;
  private readonly fileBudget: number;
  private readonly maxFiles: number;

  constructor(totalBudget: number = 2 * 1024 * 1024, fileBudget: number = 512 * 1024, maxFiles: number = 7) {
    for (const value of [totalBudget, fileBudget, maxFiles]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('OHOS_DIAGNOSTIC_INVALID_LIMIT');
    }
    this.totalBudget = totalBudget;
    this.fileBudget = fileBudget;
    this.maxFiles = maxFiles;
  }

  /** Reads bounded tails of Engine JSONL files; incomplete lines are omitted and reported. */
  collect(directory: string): DiagnosticLogSnapshot {
    let names: string[];
    try {
      names = fileIo.listFileSync(directory).filter((name: string): boolean =>
        /^engine\.[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$/.test(name)).sort().reverse();
    } catch (_error) {
      throw new Error('OHOS_DIAGNOSTIC_LOGS_UNAVAILABLE');
    }
    const files: DiagnosticLogFile[] = [];
    let remaining = this.totalBudget;
    for (const name of names) {
      if (files.length >= this.maxFiles || remaining === 0) break;
      const result = this.read(`${directory}/${name}`, name, Math.min(remaining, this.fileBudget));
      remaining -= result.readBytes;
      files.push(result);
    }
    const omittedFileCount = names.length - files.length;
    return {
      files, omittedFileCount,
      partial: omittedFileCount > 0 || files.some((file: DiagnosticLogFile): boolean => file.status !== 'complete')
    };
  }

  private read(path: string, name: string, budget: number): DiagnosticLogFile {
    const result: DiagnosticLogFile = {
      name, originalBytes: 0, readBytes: 0, exportedBytes: 0, status: 'unreadable', content: ''
    };
    let file: fileIo.File | undefined;
    let bytes: Uint8Array | undefined;
    try {
      const entry = fileIo.lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) return result;
      file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      const size = fileIo.statSync(file.fd).size;
      if (!Number.isSafeInteger(size) || size < 0) return result;
      result.originalBytes = size;
      const length = Math.min(size, budget);
      const offset = size - length;
      bytes = new Uint8Array(length);
      if (fileIo.lseek(file.fd, offset, fileIo.WhenceType.SEEK_SET) !== offset) return result;
      while (result.readBytes < length) {
        const part = new ArrayBuffer(length - result.readBytes);
        try {
          const count = fileIo.readSync(file.fd, part, { length: part.byteLength });
          if (!Number.isInteger(count) || count < 0 || count > part.byteLength) return result;
          if (count === 0) break;
          bytes.set(new Uint8Array(part, 0, count), result.readBytes);
          result.readBytes += count;
        } finally {
          new Uint8Array(part).fill(0);
        }
      }
      const end = bytes.subarray(0, result.readBytes).lastIndexOf(10) + 1;
      const start = offset === 0 ? 0 : bytes.subarray(0, result.readBytes).indexOf(10) + 1;
      if (end > start) {
        result.content = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(bytes.subarray(start, end));
        result.exportedBytes = end - start;
      }
      result.status = offset === 0 && result.exportedBytes === size ? 'complete' : 'truncated';
    } catch (_error) {
      result.status = 'unreadable';
      result.content = '';
      result.exportedBytes = 0;
    } finally {
      bytes?.fill(0);
      if (file !== undefined) {
        try {
          fileIo.closeSync(file);
        } catch (_error) {
          result.status = 'unreadable';
        }
      }
    }
    return result;
  }
}

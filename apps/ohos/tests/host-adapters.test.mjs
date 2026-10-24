import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';

const fileIo = { OpenMode: { READ_ONLY: 0, READ_WRITE: 2, TRUNC: 0o1000 }, WhenceType: { SEEK_SET: 0 } };
const image = { PixelMapFormat: { RGBA_8888: 3 } };
const picker = {};
const connection = {};
const pasteboard = {
  MIMETYPE_PIXELMAP: 'pixelMap',
  MIMETYPE_TEXT_PLAIN: 'text/plain',
  MIMETYPE_TEXT_URI: 'text/uri',
  getSystemPasteboard: () => globalThis.__uniclipboardPasteboard
};
const asset = { Tag: { SECRET: 0, ALIAS: 1, RETURN_TYPE: 2, RETURN_LIMIT: 3 }, ReturnType: { ALL: 0 } };
class ArkTextEncoder {
  encodeInto(value) { return new TextEncoder().encode(value); }
}
class ArkTextDecoder {
  static create() {
    const decoder = new TextDecoder();
    return { decodeToString: bytes => decoder.decode(bytes) };
  }
}
globalThis.__uniclipboardHostFixtures = {
  fileIo, asset, image, picker, pasteboard, connection,
  util: { generateRandomUUID: randomUUID, TextEncoder: ArkTextEncoder, TextDecoder: ArkTextDecoder }
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@ohos.net.connection') return { url: 'ohos-test:connection', shortCircuit: true };
    if (specifier.startsWith('@kit.')) return { url: `ohos-test:${specifier}`, shortCircuit: true };
    if (context.parentURL?.endsWith('.ets') && specifier.startsWith('./')) {
      return { url: new URL(`${specifier}.ets`, context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'ohos-test:connection') {
      return { format: 'module', shortCircuit: true, source: 'export default globalThis.__uniclipboardHostFixtures.connection;' };
    }
    if (url.startsWith('ohos-test:')) {
      return { format: 'module', shortCircuit: true, source: 'export const { fileIo, asset, image, picker, pasteboard, util } = globalThis.__uniclipboardHostFixtures;' };
    }
    if (url.endsWith('.ets')) {
      return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')) };
    }
    return next(url, context);
  }
});
const { DiagnosticLogReader } = await import('../entry/src/main/ets/host/DiagnosticLogReader.ets');
const { FileHandleRegistry } = await import('../entry/src/main/ets/host/FileHandleRegistry.ets');
const { SecureAssetStorage } = await import('../entry/src/main/ets/host/SecureAssetStorage.ets');
const { ImageClipboardCodec } = await import('../entry/src/main/ets/host/ImageClipboardCodec.ets');
const { DocumentPicker } = await import('../entry/src/main/ets/host/DocumentPicker.ets');
const { ClipboardAdapter } = await import('../entry/src/main/ets/host/ClipboardAdapter.ets');
const { NetworkMonitor } = await import('../entry/src/main/ets/host/NetworkMonitor.ets');
const { extractSharedText } = await import('../entry/src/main/ets/host/ShareIntent.ets');
hooks.deregister();
delete globalThis.__uniclipboardHostFixtures;

test('system text share is extracted without accepting unrelated wants', () => {
  assert.equal(extractSharedText({
    action: 'ohos.want.action.sendData', type: 'text/plain',
    parameters: { 'ohos.extra.param.key.content': 'shared text' }
  }), 'shared text');
  assert.equal(extractSharedText({
    action: 'ohos.want.action.sendData', type: 'image/png',
    parameters: { 'ohos.extra.param.key.content': 'not text' }
  }), undefined);
  assert.equal(extractSharedText({
    action: 'ohos.want.action.viewData', type: 'text/plain',
    parameters: { text: 'not a share' }
  }), undefined);
});

function fileFixture(write) {
  const calls = [];
  let position = 0;
  Object.assign(fileIo, {
    openSync: () => ({ fd: 7 }),
    closeSync: () => calls.push('close'),
    fsyncSync: () => calls.push('sync'),
    lseek: (_fd, offset) => { position = offset; return offset; },
    writeSync: (fd, buffer, options) => write(fd, buffer, { ...options, offset: position })
  });
  const files = new FileHandleRegistry();
  return { files, calls, handle: files.registerOutput('fixture://output') };
}

test('partial file writes preserve byte slices and advance the file offset', () => {
  const writes = [];
  const f = fileFixture((_fd, buffer, options) => {
    const count = Math.min(2, options.length);
    writes.push({ offset: options.offset, bytes: Array.from(new Uint8Array(buffer).slice(0, count)) });
    return count;
  });
  const source = new Uint8Array([99, 1, 2, 3, 4, 5, 99]);
  f.files.fileWriteChunk(f.handle, '10', source.subarray(1, 6));
  f.files.fileFinishWrite(f.handle);
  f.files.remove(f.handle);
  assert.deepEqual(writes, [
    { offset: 10, bytes: [1, 2] }, { offset: 12, bytes: [3, 4] }, { offset: 14, bytes: [5] }
  ]);
  assert.deepEqual(f.calls, ['sync', 'close']);
  assert.deepEqual(Array.from(source), [99, 1, 2, 3, 4, 5, 99]);
});

for (const count of [0, -1, 99, 0.5, NaN]) {
  test(`invalid native write count ${count} fails and the caller releases the file`, () => {
    const f = fileFixture(() => count);
    assert.throws(() => f.files.fileWriteChunk(f.handle, '0', new Uint8Array([1, 2])), /OHOS_FILE_IO/);
    f.files.remove(f.handle);
    assert.deepEqual(f.calls, ['close']);
  });
}

test('unsafe file range is rejected before writing', () => {
  const f = fileFixture(() => assert.fail('must not write an imprecise offset'));
  assert.throws(() => f.files.fileWriteChunk(f.handle, String(Number.MAX_SAFE_INTEGER), new Uint8Array([1])), /INVALID_OFFSET/);
  f.files.remove(f.handle);
  assert.deepEqual(f.calls, ['close']);
});

test('input file handles cannot be written', () => {
  const f = fileFixture(() => assert.fail('must not write input handles'));
  const handle = f.files.registerInput('fixture://input');
  assert.throws(() => f.files.fileWriteChunk(handle, '0', new Uint8Array([1])), /PERMISSION_DENIED/);
  assert.deepEqual(f.calls, []);
});

test('export registration truncates once, including an empty export', () => {
  const calls = [];
  Object.assign(fileIo, {
    openSync: (_uri, mode) => { calls.push(['open', mode]); return { fd: 9 }; },
    fsyncSync: fd => calls.push(['sync', fd]),
    closeSync: file => calls.push(['close', file.fd])
  });
  const files = new FileHandleRegistry();
  const handle = files.registerOutput('fixture://existing-output');
  files.fileFinishWrite(handle);
  files.remove(handle);
  assert.deepEqual(calls, [['open', 2 | 0o1000], ['sync', 9], ['close', 9]]);
});

test('metadata and chunks use one opened input until the handle is released', () => {
  const calls = [];
  Object.assign(fileIo, {
    openSync: () => { calls.push('open'); return { fd: 8, name: 'fixture.txt' }; },
    statSync: () => ({ size: 2 }),
    lseek: (_fd, offset) => { calls.push(['seek', offset]); return offset; },
    readSync: (_fd, buffer) => { new Uint8Array(buffer).set([1]); return 1; },
    closeSync: () => calls.push('close')
  });
  const files = new FileHandleRegistry();
  const handle = files.registerInput('fixture://input');
  assert.equal(files.fileMetadata(handle).sizeBytes, '2');
  assert.deepEqual(files.fileReadChunk(handle, '1', 1), new Uint8Array([1]));
  assert.deepEqual(files.fileReadChunk(handle, '0', 1), new Uint8Array([1]));
  files.remove(handle);
  assert.deepEqual(calls, ['open', ['seek', 1], ['seek', 0], 'close']);
});

function documentFixture() {
  const calls = [];
  const bodies = new Map([['fixture://output', Buffer.from('previous longer contents')]]);
  const descriptors = new Map();
  let sequence = 0;
  Object.assign(fileIo, {
    openSync(uri, mode) {
      calls.push(['open', uri, mode]);
      if (uri === 'fixture://denied') throw new Error('private URI permission failure');
      if (mode & fileIo.OpenMode.TRUNC) bodies.set(uri, Buffer.alloc(0));
      if (!bodies.has(uri)) bodies.set(uri, Buffer.from('input'));
      const file = { fd: ++sequence, name: uri.split('/').at(-1) };
      descriptors.set(file.fd, { uri, position: 0 });
      return file;
    },
    statSync(fd) { return { size: bodies.get(descriptors.get(fd).uri).length }; },
    lseek(fd, offset, whence) {
      assert.equal(whence, fileIo.WhenceType.SEEK_SET);
      descriptors.get(fd).position = offset;
      return offset;
    },
    readSync(fd, buffer, options) {
      const entry = descriptors.get(fd);
      const bytes = bodies.get(entry.uri).subarray(entry.position, entry.position + options.length);
      new Uint8Array(buffer).set(bytes);
      entry.position += bytes.length;
      return bytes.length;
    },
    writeSync(fd, buffer, options) {
      const entry = descriptors.get(fd);
      const old = bodies.get(entry.uri);
      const count = Math.min(2, options.length);
      const next = Buffer.alloc(Math.max(old.length, entry.position + count));
      old.copy(next);
      Buffer.from(buffer).copy(next, entry.position, 0, count);
      bodies.set(entry.uri, next);
      entry.position += count;
      return count;
    },
    fsyncSync(fd) { calls.push(['sync', fd]); },
    closeSync(file) { calls.push(['close', file.fd]); descriptors.delete(file.fd); }
  });
  const view = {
    select: async () => ['fixture://a', 'fixture://b'],
    save: async () => ['fixture://output']
  };
  const context = {};
  picker.DocumentViewPicker = class { constructor(actual) { assert.equal(actual, context); return view; } };
  const files = new FileHandleRegistry();
  return { files, selection: new DocumentPicker(context, files), view, calls, bodies, descriptors };
}

test('selected files retain handles through asynchronous consumption and revoke them afterward', async () => {
  const f = documentFixture();
  let selected;
  const result = await f.selection.withInputFiles(2, async handles => {
    selected = [...handles];
    assert.equal(f.descriptors.size, 2);
    assert.ok(handles.every(handle => !handle.includes('fixture')));
    await Promise.resolve();
    assert.equal(f.files.fileMetadata(handles[0]).sizeBytes, '5');
    handles.length = 0;
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(f.descriptors.size, 0);
  for (const handle of selected) assert.throws(() => f.files.fileMetadata(handle), /INVALID_HANDLE/);
});

test('save replaces a longer output and finishes without stale trailing bytes', async () => {
  const f = documentFixture();
  await f.selection.withOutputFile('短文件.txt', async handle => {
    f.files.fileWriteChunk(handle, '0', Buffer.from('abc'));
    f.files.fileWriteChunk(handle, '3', Buffer.from('de'));
    f.files.fileFinishWrite(handle);
    f.files.fileFinishWrite(handle);
    assert.throws(() => f.files.fileWriteChunk(handle, '0', Buffer.from('x')), /FINISHED/);
  });
  assert.equal(f.bodies.get('fixture://output').toString(), 'abcde');
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'sync').length, 1);
  assert.equal(f.descriptors.size, 0);
});

test('empty exports erase the old output and flush before release', async () => {
  const f = documentFixture();
  await f.selection.withOutputFile('empty', async handle => f.files.fileFinishWrite(handle));
  assert.equal(f.bodies.get('fixture://output').length, 0);
  assert.deepEqual(f.calls.map(call => call[0]), ['open', 'sync', 'close']);
});

test('random chunk reads use absolute offsets on a reused descriptor', () => {
  const f = documentFixture();
  const handle = f.files.registerInput('fixture://a');
  assert.equal(Buffer.from(f.files.fileReadChunk(handle, '2', 2)).toString(), 'pu');
  assert.equal(Buffer.from(f.files.fileReadChunk(handle, '0', 2)).toString(), 'in');
  assert.equal(f.files.fileReadChunk(handle, '100', 2).length, 0);
  f.files.clear();
});

test('invalid read results reject and temporary buffers are wiped', () => {
  for (const count of [-1, 3, 0.5, NaN]) {
    const f = documentFixture();
    const handle = f.files.registerInput('fixture://a');
    let copy;
    fileIo.readSync = (_fd, buffer) => { copy = new Uint8Array(buffer); copy.fill(7); return count; };
    assert.throws(() => f.files.fileReadChunk(handle, '0', 2), /FILE_IO/);
    assert.deepEqual(copy, new Uint8Array([0, 0]));
    f.files.clear();
  }
});

test('invalid read ranges are rejected before touching the file', () => {
  const f = documentFixture();
  const handle = f.files.registerInput('fixture://a');
  fileIo.lseek = () => assert.fail('must validate before native IO');
  for (const offset of ['', '-1', '1.5', '1e2', ' 1', '0x10', '9007199254740992']) {
    assert.throws(() => f.files.fileReadChunk(handle, offset, 1), /INVALID_OFFSET/);
  }
  for (const length of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => f.files.fileReadChunk(handle, '0', length), /INVALID_OFFSET/);
  }
  assert.throws(() => f.files.fileReadChunk(handle, String(Number.MAX_SAFE_INTEGER), 1), /INVALID_OFFSET/);
  f.files.clear();
});

test('cancelled selections do not open files or invoke consumers', async () => {
  const f = documentFixture();
  f.view.select = f.view.save = async () => [];
  assert.equal(await f.selection.withInputFiles(2, async () => assert.fail()), null);
  assert.equal(await f.selection.withOutputFile('name', async () => assert.fail()), null);
  assert.deepEqual(f.calls, []);
});

test('partial registration failure releases all previously opened inputs', async () => {
  const f = documentFixture();
  f.view.select = async () => ['fixture://a', 'fixture://denied'];
  await assert.rejects(f.selection.withInputFiles(2, async () => assert.fail()), /^Error: OHOS_FILE_IO$/);
  assert.equal(f.descriptors.size, 0);
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 1);
});

test('consumer failure releases handles without deleting selected output', async () => {
  const f = documentFixture();
  const failure = new Error('synthetic engine failure');
  await assert.rejects(f.selection.withOutputFile('name', async handle => {
    f.files.fileWriteChunk(handle, '0', Buffer.from('partial'));
    throw failure;
  }), error => error === failure);
  assert.equal(f.bodies.get('fixture://output').toString(), 'partial');
  assert.equal(f.descriptors.size, 0);
});

test('a close failure does not prevent other handles from being released', async () => {
  const f = documentFixture();
  const close = fileIo.closeSync;
  fileIo.closeSync = file => { close(file); if (file.fd === 1) throw new Error('private close detail'); };
  let selected;
  await assert.rejects(f.selection.withInputFiles(2, async handles => { selected = handles; }), /^Error: OHOS_FILE_IO$/);
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 2);
  for (const handle of selected) assert.throws(() => f.files.fileMetadata(handle), /INVALID_HANDLE/);
  f.files.clear();
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 2);
});

test('pending pickers reject concurrent requests and discard results after shutdown', async () => {
  const f = documentFixture();
  let complete;
  f.view.select = () => new Promise(resolve => { complete = resolve; });
  const pending = f.selection.withInputFiles(2, async () => assert.fail());
  await assert.rejects(f.selection.withOutputFile('name', async () => assert.fail()), /PICKER_BUSY/);
  f.selection.close();
  complete(['fixture://a']);
  await assert.rejects(pending, /PICKER_UNAVAILABLE/);
  await assert.rejects(f.selection.withInputFiles(1, async () => assert.fail()), /PICKER_UNAVAILABLE/);
  assert.deepEqual(f.calls, []);
});

test('closing a picker does not revoke an active consumer midway through IO', async () => {
  const f = documentFixture();
  await f.selection.withInputFiles(2, async handles => {
    f.selection.close();
    assert.equal(f.files.fileMetadata(handles[0]).sizeBytes, '5');
    await Promise.resolve();
    assert.equal(f.descriptors.size, 2);
  });
  assert.equal(f.descriptors.size, 0);
});

test('picker errors are sanitized and later requests remain available', async () => {
  const f = documentFixture();
  f.view.select = async () => { throw new Error('private URI'); };
  await assert.rejects(f.selection.withInputFiles(1, async () => assert.fail()), /^Error: OHOS_PICKER_FAILED$/);
  f.view.select = async () => [];
  assert.equal(await f.selection.withInputFiles(1, async () => assert.fail()), null);
});

test('picker arguments and unexpected selections fail before opening files', async () => {
  const f = documentFixture();
  for (const limit of [0, 501, 1.5, NaN]) {
    await assert.rejects(f.selection.withInputFiles(limit, async () => assert.fail()), /INVALID_LIMIT/);
  }
  for (const name of ['', '.', '..', '../file', 'a/b', 'a\\b', 'nul\0file']) {
    await assert.rejects(f.selection.withOutputFile(name, async () => assert.fail()), /INVALID_NAME/);
  }
  await assert.rejects(f.selection.withInputFiles(1, async () => assert.fail()), /INVALID_SELECTION/);
  f.view.save = async () => ['fixture://a', 'fixture://b'];
  await assert.rejects(f.selection.withOutputFile('name', async () => assert.fail()), /INVALID_SELECTION/);
  assert.deepEqual(f.calls, []);
});

test('malformed secure-storage records must not be treated as missing keys', () => {
  const storage = new SecureAssetStorage();
  for (const value of [undefined, 'corrupt-secret', 123]) {
    asset.querySync = () => [new Map([[asset.Tag.SECRET, value]])];
    assert.throws(() => storage.get('fixture-key'), /SECURE_STORAGE_UNAVAILABLE/);
  }
  asset.querySync = () => [];
  assert.equal(storage.get('fixture-key'), null);
  asset.querySync = () => { throw { code: 24000002 }; };
  assert.equal(storage.get('fixture-key'), null);
  asset.querySync = () => { throw { code: 201 }; };
  assert.throws(() => storage.get('fixture-key'), /SECURE_STORAGE_UNAVAILABLE/);
  asset.querySync = () => [new Map([[asset.Tag.SECRET, new Uint8Array([1, 2, 3])]])];
  assert.deepEqual(storage.get('fixture-key'), new Uint8Array([1, 2, 3]));
});


function imageFixture() {
  const calls = [];
  const pixelMap = {
    getImageInfo: async () => ({ size: { width: 2, height: 3 } }),
    release: async () => { calls.push('pixel:release'); }
  };
  const packer = {
    packToData: async (pixel, options) => {
      calls.push({ pixel, options });
      return new Uint8Array([1, 2, 3]).buffer;
    },
    release: async () => { calls.push('packer:release'); }
  };
  const source = {
    getImageInfo: async () => ({ size: { width: 2, height: 3 } }),
    createPixelMap: async (options) => { calls.push(options); return pixelMap; },
    release: async () => { calls.push('source:release'); }
  };
  const inputBuffers = [];
  Object.assign(image, {
    createImagePacker: () => { calls.push('packer:create'); return packer; },
    createImageSource: (buffer) => { inputBuffers.push(new Uint8Array(buffer)); return source; }
  });
  const codec = new ImageClipboardCodec({ maxEncodedBytes: 32, maxPixels: 64 });
  return { codec, pixelMap, packer, source, calls, inputBuffers };
}

test('clipboard image reads release the pasteboard PixelMap after encoding', async () => {
  const f = imageFixture();
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => ({
      getPrimaryMimeType: () => pasteboard.MIMETYPE_PIXELMAP,
      getPrimaryPixelMap: () => f.pixelMap
    })
  };
  const adapter = new ClipboardAdapter();
  const snapshot = await adapter.read();
  assert.deepEqual(snapshot.representations[0], {
    kind: 'inline', format: 'image/png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3])
  });
  assert.deepEqual(f.calls.slice(-2), ['packer:release', 'pixel:release']);
});

test('clipboard image release failures are reported as unavailable', async () => {
  const f = imageFixture();
  f.pixelMap.release = async () => { throw new Error('synthetic pixel release failure'); };
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => ({
      getPrimaryMimeType: () => pasteboard.MIMETYPE_PIXELMAP,
      getPrimaryPixelMap: () => f.pixelMap
    })
  };
  await assert.rejects(new ClipboardAdapter().read(), /CLIPBOARD_UNAVAILABLE/);
});

test('clipboard permission failures stay distinguishable from unavailable data', async () => {
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => { throw { code: 201 }; }
  };
  await assert.rejects(new ClipboardAdapter().read(), /CLIPBOARD_PERMISSION_DENIED/);
});

test('clipboard URI records are normalized to an Engine uri-list', async () => {
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => ({
      getPrimaryMimeType: () => pasteboard.MIMETYPE_TEXT_URI,
      getPrimaryUri: () => 'file:///storage/emulated/0/Documents/a%20b.txt',
      getRecordCount: () => 1,
      getRecord: () => ({ mimeType: pasteboard.MIMETYPE_TEXT_URI, uri: 'file:///storage/emulated/0/Documents/a%20b.txt' })
    })
  };
  const snapshot = await new ClipboardAdapter().read();
  assert.equal(snapshot.representations[0].format, 'files');
  assert.equal(snapshot.representations[0].mimeType, 'text/uri-list');
  assert.equal(new TextDecoder().decode(snapshot.representations[0].bytes),
    'file:///storage/emulated/0/Documents/a%20b.txt\n');
});

test('clipboard file reads retain every URI in order without decoding names', async () => {
  const records = [
    { mimeType: pasteboard.MIMETYPE_TEXT_URI, uri: 'file:///a%20b.txt' },
    { mimeType: pasteboard.MIMETYPE_TEXT_PLAIN, plainText: 'file description' },
    { mimeType: pasteboard.MIMETYPE_TEXT_URI, uri: 'file:///%E4%B8%AD%E6%96%87.txt' }
  ];
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => ({
      getPrimaryMimeType: () => pasteboard.MIMETYPE_TEXT_URI,
      getPrimaryUri: () => records[0].uri,
      getRecordCount: () => records.length,
      getRecord: index => records[index]
    })
  };
  const snapshot = await new ClipboardAdapter().read();
  assert.equal(new TextDecoder().decode(snapshot.representations[0].bytes),
    'file:///a%20b.txt\nfile:///%E4%B8%AD%E6%96%87.txt\n');
});

for (const uri of [undefined, null, '']) {
  test(`clipboard file read rejects an incomplete record (${uri})`, async () => {
    const records = [
      { mimeType: pasteboard.MIMETYPE_TEXT_URI, uri: 'file:///valid.txt' },
      { mimeType: pasteboard.MIMETYPE_TEXT_URI, uri }
    ];
    globalThis.__uniclipboardPasteboard = {
      getDataSync: () => ({
        getPrimaryMimeType: () => pasteboard.MIMETYPE_TEXT_URI,
        getPrimaryUri: () => records[0].uri,
        getRecordCount: () => records.length,
        getRecord: index => records[index]
      })
    };
    await assert.rejects(new ClipboardAdapter().read(), /OHOS_CLIPBOARD_UNAVAILABLE/);
  });
}

test('clipboard URI restore writes every URI record and suppresses the echo', async () => {
  const calls = [];
  let written;
  globalThis.__uniclipboardPasteboard = {
    setDataSync: data => { written = data; calls.push('write'); },
  };
  pasteboard.createData = (mimeType, uri) => {
    const data = {
      mimeType,
      uris: [uri],
      addRecord: (_recordMimeType, value) => data.uris.push(value)
    };
    return data;
  };
  const adapter = new ClipboardAdapter();
  await adapter.write({ observedAtMs: 1, representations: [{
    kind: 'inline', format: 'files', mimeType: 'text/uri-list',
    bytes: new TextEncoder().encode('file:///a\n# comment\nfile:///b\n')
  }] });
  assert.deepEqual(written, { mimeType: pasteboard.MIMETYPE_TEXT_URI, uris: ['file:///a', 'file:///b'], addRecord: written.addRecord });
  assert.deepEqual(calls, ['write']);
});

test('image budgets reject invalid bounds', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ImageClipboardCodec({ maxEncodedBytes: value, maxPixels: 64 }), /INVALID_LIMIT/);
    assert.throws(() => new ImageClipboardCodec({ maxEncodedBytes: 32, maxPixels: value }), /INVALID_LIMIT/);
  }
});

test('PNG encoding limits the packer output and preserves caller-owned PixelMap', async () => {
  const f = imageFixture();
  assert.deepEqual(await f.codec.encodePng(f.pixelMap), new Uint8Array([1, 2, 3]));
  assert.deepEqual(f.calls, [
    'packer:create',
    { pixel: f.pixelMap, options: { format: 'image/png', quality: 100, bufferSize: 32, needsPackProperties: false } },
    'packer:release'
  ]);
});

test('encoding failures still release the packer', async () => {
  const f = imageFixture();
  const failure = new Error('synthetic pack failure');
  f.packer.packToData = async () => { throw failure; };
  await assert.rejects(f.codec.encodePng(f.pixelMap), (error) => error === failure);
  assert.deepEqual(f.calls, ['packer:create', 'packer:release']);
});

test('empty or oversized packed output is rejected and releases the packer', async () => {
  for (const length of [0, 33]) {
    const f = imageFixture();
    f.packer.packToData = async () => new ArrayBuffer(length);
    await assert.rejects(f.codec.encodePng(f.pixelMap), /SIZE_LIMIT/);
    assert.deepEqual(f.calls, ['packer:create', 'packer:release']);
  }
});

test('invalid or oversized dimensions are rejected before encoding', async () => {
  for (const size of [{ width: 0, height: 1 }, { width: -1, height: 2 },
    { width: NaN, height: 2 }, { width: 1.5, height: 2 },
    { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER }, { width: 9, height: 8 }]) {
    const f = imageFixture();
    f.pixelMap.getImageInfo = async () => ({ size });
    await assert.rejects(f.codec.encodePng(f.pixelMap), /PIXEL_LIMIT/);
    assert.deepEqual(f.calls, []);
  }
});

test('decode copies only the input view and releases resources after the consumer', async () => {
  const f = imageFixture();
  const original = new Uint8Array([99, 1, 2, 3, 99]);
  await f.codec.withDecodedImage(original.subarray(1, 4), async (pixel) => {
    assert.equal(pixel, f.pixelMap);
    assert.deepEqual(f.inputBuffers[0], new Uint8Array([1, 2, 3]));
    assert.deepEqual(f.calls, [{ desiredPixelFormat: image.PixelMapFormat.RGBA_8888 }]);
    f.calls.push('consume');
  });
  assert.deepEqual(f.calls, [{ desiredPixelFormat: 3 }, 'consume', 'pixel:release', 'source:release']);
  assert.deepEqual(f.inputBuffers[0], new Uint8Array([0, 0, 0]));
  assert.deepEqual(original, new Uint8Array([99, 1, 2, 3, 99]));
});

test('empty or oversized encoded input is rejected before allocating an image source', async () => {
  for (const length of [0, 33]) {
    const f = imageFixture();
    await assert.rejects(f.codec.withDecodedImage(new Uint8Array(length), async () => assert.fail()), /SIZE_LIMIT/);
    assert.equal(f.inputBuffers.length, 0);
  }
});

test('source dimensions are checked before pixel decoding', async () => {
  const f = imageFixture();
  f.source.getImageInfo = async () => ({ size: { width: 65, height: 1 } });
  await assert.rejects(f.codec.withDecodedImage(new Uint8Array([1]), async () => assert.fail()), /PIXEL_LIMIT/);
  assert.deepEqual(f.calls, ['source:release']);
  assert.deepEqual(f.inputBuffers[0], new Uint8Array([0]));
});

test('decoded dimensions are checked before the image reaches the consumer', async () => {
  const f = imageFixture();
  f.pixelMap.getImageInfo = async () => ({ size: { width: 65, height: 1 } });
  await assert.rejects(f.codec.withDecodedImage(new Uint8Array([1]), async () => assert.fail()), /PIXEL_LIMIT/);
  assert.deepEqual(f.calls.slice(-2), ['pixel:release', 'source:release']);
  assert.deepEqual(f.inputBuffers[0], new Uint8Array([0]));
});

test('source creation failure still wipes the copied bytes', async () => {
  const f = imageFixture();
  let failedInput;
  image.createImageSource = (buffer) => { failedInput = new Uint8Array(buffer); throw new Error('synthetic source failure'); };
  await assert.rejects(f.codec.withDecodedImage(new Uint8Array([1, 2]), async () => assert.fail()), /source failure/);
  assert.deepEqual(failedInput, new Uint8Array([0, 0]));
  assert.deepEqual(f.calls, []);
});

test('pixel decoding failure releases the source and wipes copied bytes', async () => {
  const f = imageFixture();
  const failure = new Error('synthetic decode failure');
  f.source.createPixelMap = async () => { throw failure; };
  await assert.rejects(f.codec.withDecodedImage(new Uint8Array([1]), async () => assert.fail()), (error) => error === failure);
  assert.deepEqual(f.calls, ['source:release']);
  assert.deepEqual(f.inputBuffers[0], new Uint8Array([0]));
});

test('consumer failure still releases both native resources', async () => {
  const f = imageFixture();
  const failure = new Error('synthetic clipboard write failure');
  await assert.rejects(f.codec.withDecodedImage(new Uint8Array([1]), async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(f.calls.slice(-2), ['pixel:release', 'source:release']);
  assert.deepEqual(f.inputBuffers[0], new Uint8Array([0]));
});

test('PixelMap release failure still releases the source and wipes copied bytes', async () => {
  const f = imageFixture();
  f.pixelMap.release = async () => { f.calls.push('pixel:release'); throw new Error('synthetic release failure'); };
  await assert.rejects(f.codec.withDecodedImage(new Uint8Array([1]), async () => {}), /release failure/);
  assert.deepEqual(f.calls.slice(-2), ['pixel:release', 'source:release']);
  assert.deepEqual(f.inputBuffers[0], new Uint8Array([0]));
});

test('source release failure still wipes copied bytes', async () => {
  const f = imageFixture();
  f.source.release = async () => { f.calls.push('source:release'); throw new Error('synthetic release failure'); };
  await assert.rejects(f.codec.withDecodedImage(new Uint8Array([1]), async () => {}), /release failure/);
  assert.deepEqual(f.calls.slice(-2), ['pixel:release', 'source:release']);
  assert.deepEqual(f.inputBuffers[0], new Uint8Array([0]));
});

test('native resources stay alive until an asynchronous consumer finishes', async () => {
  const f = imageFixture();
  let complete;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = f.codec.withDecodedImage(new Uint8Array([1]), async () => {
    entered();
    await new Promise((resolve) => { complete = resolve; });
  });
  await started;
  assert.deepEqual(f.calls, [{ desiredPixelFormat: 3 }]);
  assert.deepEqual(f.inputBuffers[0], new Uint8Array([1]));
  complete();
  await pending;
  assert.deepEqual(f.calls.slice(-2), ['pixel:release', 'source:release']);
});

test('unavailable native image factories fail explicitly', async () => {
  for (const missing of [null, undefined]) {
    const f = imageFixture();
    image.createImagePacker = () => missing;
    await assert.rejects(f.codec.encodePng(f.pixelMap), /IMAGE_UNAVAILABLE/);
    let copied;
    image.createImageSource = (buffer) => { copied = new Uint8Array(buffer); return missing; };
    await assert.rejects(f.codec.withDecodedImage(new Uint8Array([1]), async () => assert.fail()), /IMAGE_UNAVAILABLE/);
    assert.deepEqual(copied, new Uint8Array([0]));
  }
});


test('an empty system pasteboard yields an empty snapshot even when primary text is undefined', async () => {
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => ({
      getPrimaryMimeType: () => undefined,
      getPrimaryText: () => undefined
    })
  };
  const clipboard = new ClipboardAdapter();
  assert.deepEqual((await clipboard.read()).representations, []);
  assert.equal(clipboard.readText(), '');
});

test('a non-text pasteboard can have no primary text', async () => {
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => ({
      getPrimaryMimeType: () => 'application/example',
      getPrimaryText: () => null
    })
  };
  const clipboard = new ClipboardAdapter();
  assert.deepEqual((await clipboard.read()).representations, []);
  assert.equal(clipboard.readText(), '');
});

test('clipboard text survives the system adapter without modification', async () => {
  const text = '中文 clipboard\nline two';
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => ({
      getPrimaryMimeType: () => 'text/plain',
      getPrimaryText: () => text
    })
  };
  const clipboard = new ClipboardAdapter();
  assert.equal(clipboard.readText(), text);
  assert.equal(new TextDecoder().decode((await clipboard.read()).representations[0].bytes), text);
});


function diagnosticFixture(entries) {
  const opened = [];
  const closed = [];
  const descriptors = new Map();
  let next = 1;
  Object.assign(fileIo, {
    listFileSync: () => Object.keys(entries),
    lstatSync(path) {
      const entry = entries[path.split('/').at(-1)];
      return { isFile: () => !entry.directory, isSymbolicLink: () => !!entry.symlink };
    },
    openSync(path) {
      const name = path.split('/').at(-1);
      if (entries[name].denied) throw new Error('private file path');
      const file = { fd: next++ };
      descriptors.set(file.fd, { entry: entries[name], position: 0 });
      opened.push(name);
      return file;
    },
    statSync(fd) { return { size: descriptors.get(fd).entry.data.length }; },
    lseek(fd, offset) { descriptors.get(fd).position = offset; return offset; },
    readSync(fd, buffer) {
      const item = descriptors.get(fd);
      const count = Math.min(buffer.byteLength, item.entry.data.length - item.position, item.entry.chunk ?? Infinity);
      new Uint8Array(buffer).set(item.entry.data.subarray(item.position, item.position + count));
      item.position += count;
      return count;
    },
    closeSync(file) { closed.push(file.fd); descriptors.delete(file.fd); }
  });
  return { opened, closed, descriptors };
}

test('diagnostic export reads only strict Engine log names and closes partial-read inputs', () => {
  const f = diagnosticFixture({
    'engine.2026-10-05.jsonl': { data: Buffer.from('{"event":"ok"}\n'), chunk: 2 },
    'private.txt': { data: Buffer.from('private') },
    '../engine.2026-10-04.jsonl': { data: Buffer.from('private') }
  });
  const snapshot = new DiagnosticLogReader().collect('/logs');
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.files[0].content, '{"event":"ok"}\n');
  assert.equal(snapshot.files[0].exportedBytes, 15);
  assert.deepEqual(f.opened, ['engine.2026-10-05.jsonl']);
  assert.equal(f.closed.length, 1);
  assert.equal(f.descriptors.size, 0);
});

test('diagnostic tails omit broken UTF-8 prefixes and incomplete final lines', () => {
  diagnosticFixture({ 'engine.2026-10-05.jsonl': { data: Buffer.from('中文\n{"ok":1}\npartial') } });
  const snapshot = new DiagnosticLogReader(20, 20).collect('/logs');
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.files[0].content, '{"ok":1}\n');
  assert.equal(snapshot.files[0].readBytes, 20);
  assert.equal(snapshot.files[0].exportedBytes, 9);
});

test('diagnostic export budgets newest files and reports omitted files', () => {
  const f = diagnosticFixture({
    'engine.2026-10-03.jsonl': { data: Buffer.from('old\n') },
    'engine.2026-10-05.jsonl': { data: Buffer.from('new\n') },
    'engine.2026-10-04.jsonl': { data: Buffer.from('mid\n') }
  });
  const snapshot = new DiagnosticLogReader(4, 4).collect('/logs');
  assert.equal(snapshot.omittedFileCount, 2);
  assert.equal(snapshot.partial, true);
  assert.deepEqual(f.opened, ['engine.2026-10-05.jsonl']);
});

test('diagnostic export refuses symlinks and retains fixed unreadable status', () => {
  const f = diagnosticFixture({
    'engine.2026-10-05.jsonl': { data: Buffer.from('private'), symlink: true },
    'engine.2026-10-04.jsonl': { data: Buffer.from('private'), denied: true }
  });
  const snapshot = new DiagnosticLogReader().collect('/logs');
  assert.equal(snapshot.partial, true);
  assert.deepEqual(f.opened, []);
  assert.ok(snapshot.files.every(item => item.status === 'unreadable' && item.content === ''));
  assert.doesNotMatch(JSON.stringify(snapshot), /private/);
});

test('missing diagnostic directory is an error instead of an empty successful export', () => {
  fileIo.listFileSync = () => { throw new Error('private path'); };
  assert.throws(() => new DiagnosticLogReader().collect('/logs'), /OHOS_DIAGNOSTIC_LOGS_UNAVAILABLE/);
});

function networkFixture() {
  const instances = [];
  connection.createNetConnection = () => {
    const instance = {
      handlers: {}, unregisterCount: 0,
      on(event, callback) { this.handlers[event] = callback; },
      register(callback) { this.completeRegistration = callback; },
      unregister(callback) { this.unregisterCount += 1; this.completeUnregistration = callback; }
    };
    instances.push(instance);
    return instance;
  };
  return { monitor: new NetworkMonitor(), instances };
}

test('late network registration after stop is released and cannot notify a new observer', () => {
  const { monitor, instances } = networkFixture();
  let notified = 0;
  monitor.start(() => { notified += 1; });
  const old = instances[0];
  monitor.stop();
  monitor.start(() => { notified += 10; });
  old.completeRegistration(undefined);
  assert.equal(old.unregisterCount, 1);
  old.handlers.netAvailable({});
  assert.equal(notified, 0);
  instances[1].completeRegistration(undefined);
  instances[1].handlers.netAvailable({});
  assert.equal(notified, 10);
  monitor.stop();
  assert.equal(instances[1].unregisterCount, 1);
});

test('old network registration failure cannot stop a replacement monitor', () => {
  const { monitor, instances } = networkFixture();
  let notified = 0;
  monitor.start(() => {});
  const old = instances[0];
  monitor.stop();
  monitor.start(() => { notified += 1; });
  instances[1].completeRegistration(undefined);
  old.completeRegistration({ code: 2100003 });
  instances[1].handlers.netLost({});
  assert.equal(notified, 1);
  assert.equal(instances[1].unregisterCount, 0);
  monitor.stop();
});

test('old unregister completion cannot clear replacement registration ownership', () => {
  const { monitor, instances } = networkFixture();
  monitor.start(() => {});
  instances[0].completeRegistration(undefined);
  monitor.stop();
  monitor.start(() => {});
  instances[1].completeRegistration(undefined);
  instances[0].completeUnregistration(undefined);
  monitor.stop();
  assert.equal(instances[1].unregisterCount, 1);
});

test('network events belong to the active registration and stop is idempotent', () => {
  const { monitor, instances } = networkFixture();
  let notified = 0;
  monitor.start(() => { notified += 1; });
  monitor.start(() => { notified += 100; });
  assert.equal(instances.length, 1);
  instances[0].completeRegistration(undefined);
  for (const event of ['netAvailable', 'netLost', 'netUnavailable']) instances[0].handlers[event]({});
  assert.equal(notified, 3);
  monitor.stop();
  monitor.stop();
  instances[0].handlers.netAvailable({});
  assert.equal(notified, 3);
  assert.equal(instances[0].unregisterCount, 1);
});

for (const uris of [[], [undefined], [null], [''], [undefined, '']]) {
  test(`clipboard URI records cleared by the system produce no file content (${JSON.stringify(uris)})`, async () => {
    globalThis.__uniclipboardPasteboard = {
      getDataSync: () => ({
        getPrimaryMimeType: () => pasteboard.MIMETYPE_TEXT_URI,
        getRecordCount: () => uris.length,
        getRecord: index => ({ mimeType: pasteboard.MIMETYPE_TEXT_URI, uri: uris[index] })
      })
    };
    const snapshot = await new ClipboardAdapter().read();
    assert.deepEqual(snapshot.representations, []);
  });
}

test('clipboard system read errors are never converted into an empty snapshot', async () => {
  globalThis.__uniclipboardPasteboard = {
    getDataSync: () => { throw { code: 12900005 }; }
  };
  await assert.rejects(new ClipboardAdapter().read(), /OHOS_CLIPBOARD_UNAVAILABLE/);
});

// W2.5 stub regressions: M6 disk-full / mid-stream failure cleanup / fsync failure.

test('an immediate disk-full write failure surfaces and the handle still releases exactly once', () => {
  const f = fileFixture(() => { throw new Error('ENOSPC'); });
  assert.throws(() => f.files.fileWriteChunk(f.handle, '0', new Uint8Array([1, 2, 3])), /OHOS_FILE_IO/);
  f.files.remove(f.handle);
  assert.deepEqual(f.calls, ['close']);
});

test('a mid-stream write failure keeps the delivered prefix, fails loudly and leaves the registry reusable', () => {
  const delivered = [];
  const f = fileFixture((_fd, buffer, options) => {
    if (delivered.length >= 1) throw new Error('ENOSPC');
    const count = Math.min(2, options.length);
    delivered.push({ offset: options.offset, bytes: Array.from(new Uint8Array(buffer).slice(0, count)) });
    return count;
  });
  assert.throws(() => f.files.fileWriteChunk(f.handle, '10', new Uint8Array([7, 8, 9, 10])), /OHOS_FILE_IO/);
  assert.deepEqual(delivered, [{ offset: 10, bytes: [7, 8] }]);
  f.files.remove(f.handle);
  assert.deepEqual(f.calls, ['close']);

  const next = f.files.registerOutput('fixture://output-2');
  delivered.length = 0;
  f.files.fileWriteChunk(next, '0', new Uint8Array([42]));
  f.files.fileFinishWrite(next);
  f.files.remove(next);
  assert.deepEqual(f.calls, ['close', 'sync', 'close']);
});

test('an fsync failure fails the finish without latching success', () => {
  const f = fileFixture(() => 1);
  fileIo.fsyncSync = () => { throw new Error('ENOSPC'); };
  assert.throws(() => f.files.fileFinishWrite(f.handle), /OHOS_FILE_IO/);
  // finished must remain false, so a retried finish syncs again instead of
  // reporting a durable export that never reached the disk.
  assert.throws(() => f.files.fileFinishWrite(f.handle), /OHOS_FILE_IO/);
  fileIo.fsyncSync = () => f.calls.push('sync');
  f.files.fileFinishWrite(f.handle);
  f.files.remove(f.handle);
  assert.deepEqual(f.calls, ['sync', 'close']);
});

// W2.5 stub regressions: M7 network switch sequencing and lifecycle guards.

test('network switches notify once per transition and stop unregisters', () => {
  const { monitor, instances } = networkFixture();
  let notified = 0;
  monitor.start(() => { notified += 1; });
  const net = instances[0];
  net.completeRegistration(undefined);
  net.handlers.netAvailable({});
  net.handlers.netLost({});
  net.handlers.netUnavailable();
  net.handlers.netAvailable({});
  assert.equal(notified, 4);
  monitor.stop();
  net.handlers.netLost({});
  assert.equal(notified, 4);
  assert.equal(net.unregisterCount, 1);
});

test('a duplicate start is ignored instead of leaking a second registration', () => {
  const { monitor, instances } = networkFixture();
  let first = 0;
  let second = 0;
  monitor.start(() => { first += 1; });
  monitor.start(() => { second += 1; });
  assert.equal(instances.length, 1);
  instances[0].completeRegistration(undefined);
  instances[0].handlers.netAvailable({});
  assert.equal(first, 1);
  assert.equal(second, 0);
  monitor.stop();
});

test('a failed registration is discarded so a later start can recover', () => {
  const { monitor, instances } = networkFixture();
  let notified = 0;
  monitor.start(() => { notified += 1; });
  instances[0].completeRegistration({ code: 201 });
  assert.equal(instances[0].unregisterCount, 0);

  monitor.start(() => { notified += 10; });
  assert.equal(instances.length, 2);
  instances[1].completeRegistration(undefined);
  instances[0].handlers.netAvailable({});
  instances[1].handlers.netAvailable({});
  assert.equal(notified, 10);
  monitor.stop();
});

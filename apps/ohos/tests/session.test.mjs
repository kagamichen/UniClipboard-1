import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineSession } from '../entry/src/main/ets/engine/EngineSession.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const calls = [];
  const queue = [];
  let waiting;
  const emit = value => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(value); }
    else queue.push(value);
  };
  let state = 'running';
  const engine = {
    recoverSession: async () => ({ unlocked: false, resumed: false }),
    queryDeviceGroupChoices: async () => JSON.stringify({ device_trust: { current_join: null } }),
    queryLocalDevice: async () => ({ deviceId: 'test', displayName: 'Test' }),
    queryActiveClipboard: async () => null,
    lifecycleState: async () => state,
    suspendWithDeadline: async () => { state = 'suspended'; calls.push('suspend'); },
    resume: async () => { state = 'running'; calls.push('resume'); },
    shutdownUntilComplete: async () => { calls.push('shutdown'); emit(null); },
    nextEvent: async () => queue.length > 0 ? queue.shift() : new Promise(resolve => { waiting = resolve; }),
    createSpace: async () => ({ selfDeviceId: 'test' }),
    joinSpace: async () => ({ status: 'pending', joinId: 'join-test' }),
    sendText: async () => ({ entryId: 'entry', totalAccepted: 0, totalDuplicate: 0, totalPending: 0, totalOffline: 1, totalErrored: 0 }),
    queryHistory: async () => ({ entries: [{ entryId: 'entry', contentType: 'text', preview: 'hello', createdAtMs: 1 }] }),
    listDevices: async () => [{ deviceId: 'test', displayName: 'Test', isLocal: true, online: true }],
    querySyncSettings: async () => ({ syncEnabled: true, autoSyncEnabled: true, syncFrequency: 'realtime', contentTypes: { text: true }, syncOnRestore: true }),
    updateSyncSettings: async patch => ({ kind: 'updated', settings: { syncEnabled: patch.syncEnabled ?? true, autoSyncEnabled: true, syncFrequency: 'realtime', contentTypes: { text: true }, syncOnRestore: true } }),
    queryProfileRecovery: async () => ({ state: 'not_required', canSubmitPassphrase: false, restartRequired: false, backgroundReady: true, cleanupPending: false, losses: [] }),
    queryEncryptionState: async () => ({ initialized: true, sessionReady: true }),
    changeEncryptionPassphrase: async () => { calls.push('change-passphrase'); },
    unlockSpace: async () => 'space',
    lockEncryption: async () => {},
    restoreClipboard: async () => 'restored',
    deleteHistoryEntry: async () => {},
    observeClipboardChange: async () => null,
    listEntryReceiveProgress: async () => [{ entryId: 'entry', attemptId: 'attempt', state: 'receiving', totalBytes: '100', completedBytes: '25', itemsTotal: 1, itemsCompleted: 0 }],
    cancelEntryReceive: async () => 'cancelled',
    cancelInboundTransfer: async () => 'cancelled',
    notifyConnectivityOpportunity: async () => {},
    queryNetworkRecoveryStatus: async () => ({ phase: 'idle', retryable: false }),
    ...overrides
  };
  const factory = {
    lifecycle: { resume: async () => { calls.push('startup-resume'); }, suspendWithDeadline: async () => { calls.push('startup-suspend'); } },
    start: async () => { calls.push('start'); return engine; }
  };
  return { engine, factory, calls, emit };
}

test('concurrent start creates one Engine and leaves first launch unconfigured', async () => {
  const f = fixture();
  const session = new EngineSession();
  await Promise.all([session.start(f.factory), session.start(f.factory)]);
  assert.equal(f.calls.filter(c => c === 'start').length, 1);
  assert.equal(session.snapshot().phase, 'setup');
  assert.equal(session.snapshot().unlocked, false);
  await session.shutdown();
});

test('background during startup is delivered and resulting runtime remains suspended', async () => {
  const f = fixture();
  const gate = deferred();
  f.factory.start = () => gate.promise;
  const session = new EngineSession();
  const starting = session.start(f.factory);
  await session.setForeground(false);
  assert.deepEqual(f.calls, ['startup-suspend']);
  gate.resolve(f.engine);
  await starting;
  assert.equal(session.snapshot().phase, 'suspended');
  await session.setForeground(true);
  assert.equal(session.snapshot().phase, 'setup');
  assert.deepEqual(f.calls, ['startup-suspend', 'suspend', 'resume']);
  await session.shutdown();
});

test('failed recovery closes native runtime and keeps diagnostics content-free', async () => {
  const f = fixture({ recoverSession: async () => { throw new Error('secret passphrase clipboard-content'); } });
  const session = new EngineSession();
  await assert.rejects(session.start(f.factory), /SESSION_START_FAILED/);
  assert.ok(f.calls.includes('shutdown'));
  assert.equal(session.snapshot().phase, 'error');
  assert.doesNotMatch(JSON.stringify(session.snapshot()), /secret|clipboard-content/);
  await session.shutdown();
});

test('pending pairing must not be displayed as unlocked', async () => {
  const f = fixture();
  const session = new EngineSession();
  await session.start(f.factory);
  await session.joinSpace('invite', 'Phone', 'passphrase');
  assert.equal(session.snapshot().unlocked, false);
  assert.equal(session.snapshot().joinStatus, 'pending');
  await session.shutdown();
});

test('offline send is reported as offline and does not invent successful delivery', async () => {
  const f = fixture();
  const session = new EngineSession();
  await session.start(f.factory);
  await session.createSpace('Phone', 'passphrase', 'passphrase');
  await session.sendText('message');
  assert.match(session.snapshot().message, /已接收 0/);
  assert.match(session.snapshot().message, /离线 1/);
  await session.shutdown();
});

test('history search and sync settings stay behind the session operation gate', async () => {
  const f = fixture();
  const session = new EngineSession();
  await session.start(f.factory);
  await session.createSpace('Phone', 'passphrase', 'passphrase');
  await session.loadHistory('hello');
  assert.equal(session.snapshot().history[0].preview, 'hello');
  await session.loadSyncSettings();
  assert.equal(session.snapshot().syncSettings.syncEnabled, true);
  await session.updateSyncSettings({ syncEnabled: false });
  assert.equal(session.snapshot().syncSettings.syncEnabled, false);
  await session.shutdown();
});

test('passphrase changes and network status stay behind the session operation gate', async () => {
  const f = fixture();
  const session = new EngineSession();
  await session.start(f.factory);
  await session.createSpace('Phone', 'passphrase', 'passphrase');
  await session.changePassphrase('new-passphrase', 'new-passphrase');
  await session.queryNetworkRecoveryStatus();
  assert.ok(f.calls.includes('change-passphrase'));
  assert.equal(session.snapshot().networkRecovery.phase, 'idle');
  await session.shutdown();
});

test('locking clears content views and unlocking refreshes the active session', async () => {
  const f = fixture({ recoverSession: async () => ({ unlocked: true, resumed: true }) });
  const session = new EngineSession();
  await session.start(f.factory);
  await session.loadHistory();
  await session.lock();
  assert.equal(session.snapshot().unlocked, false);
  assert.deepEqual(session.snapshot().history, []);
  await session.unlock('passphrase');
  assert.equal(session.snapshot().unlocked, true);
  await session.shutdown();
});

test('history pagination and receive cancellation remain explicit Engine operations', async () => {
  let calls = 0;
  const f = fixture({
    queryHistory: async cursor => {
      calls += 1;
      return cursor === null ? { entries: [{ entryId: 'one', contentType: 'text', createdAtMs: 1 }], nextCursor: 'next' } :
        { entries: [{ entryId: 'two', contentType: 'file', createdAtMs: 2 }] };
    }
  });
  const session = new EngineSession();
  await session.start(f.factory);
  await session.createSpace('Phone', 'passphrase', 'passphrase');
  await session.loadHistory();
  await session.loadMoreHistory();
  assert.equal(calls, 2);
  assert.deepEqual(session.snapshot().history.map(item => item.entryId), ['one', 'two']);
  await session.loadReceiveProgress();
  assert.equal(session.snapshot().receiveProgress[0].completedBytes, '25');
  await session.cancelReceive('entry', 'attempt');
  assert.deepEqual(session.snapshot().receiveProgress, []);
  await session.shutdown();
});

test('history image resources accept inline or blob bytes within an explicit budget', async () => {
  const f = fixture({
    getHistoryEntryResource: async () => ({ sizeBytes: '3', mimeType: 'image/png', blobId: 'blob' }),
    readBlob: async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })
  });
  const session = new EngineSession();
  await session.start(f.factory);
  await session.createSpace('Phone', 'passphrase', 'passphrase');
  const resource = await session.loadHistoryResource('entry', 3);
  assert.deepEqual(Array.from(resource.bytes), [1, 2, 3]);
  await assert.rejects(session.loadHistoryResource('entry', 2), /OPERATION_FAILED/);
  await session.shutdown();
});

test('transfer and network events are exposed without inventing completion', async () => {
  const f = fixture();
  const session = new EngineSession();
  await session.start(f.factory);
  f.emit({ kind: 'transfer_progress', transferProgress: { transferId: 't', peerId: 'p', direction: 'sending', completedBytes: '4', totalBytes: '8' } });
  f.emit({ kind: 'network_recovery_changed', networkRecoveryPhase: 'retry_scheduled', retryable: true, nextRetryInMs: 500 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().transferProgress.completedBytes, '4');
  assert.equal(session.snapshot().networkRecovery.phase, 'retry_scheduled');
  assert.equal(session.snapshot().networkRecovery.retryable, true);
  await session.cancelInboundTransfer('t');
  assert.equal(session.snapshot().transferProgress, undefined);
  await session.shutdown();
});

test('reject overlapping operations and clear busy after failure', async () => {
  const gate = deferred();
  const f = fixture({ sendText: () => gate.promise });
  const session = new EngineSession();
  await session.start(f.factory);
  await session.createSpace('Phone', 'passphrase', 'passphrase');
  const sending = session.sendText('message');
  await assert.rejects(session.sendText('second'), /SESSION_UNAVAILABLE/);
  gate.reject(new Error('private filename'));
  await assert.rejects(sending, /OPERATION_FAILED/);
  assert.equal(session.snapshot().busy, false);
  assert.doesNotMatch(session.snapshot().message, /private filename/);
  await session.shutdown();
});

test('shutdown waits for startup and releases a late native instance', async () => {
  const f = fixture();
  const gate = deferred();
  f.factory.start = () => gate.promise;
  const session = new EngineSession();
  const starting = session.start(f.factory);
  const closing = session.shutdown();
  gate.resolve(f.engine);
  await Promise.all([starting, closing]);
  assert.equal(session.snapshot().phase, 'closed');
  assert.equal(f.calls.filter(c => c === 'shutdown').length, 1);
  await assert.rejects(session.start(f.factory), /SESSION_CLOSED/);
});

test('lifecycle failure is visible instead of pretending the app is suspended', async () => {
  const f = fixture({ suspendWithDeadline: async () => { throw new Error('private-path'); } });
  const session = new EngineSession();
  await session.start(f.factory);
  await assert.rejects(session.setForeground(false), /LIFECYCLE_FAILED/);
  assert.equal(session.snapshot().phase, 'error');
  assert.doesNotMatch(session.snapshot().message, /private-path/);
  await session.shutdown();
});

test('shutdown drains a failing operation before publishing closed state', async () => {
  const gate = deferred();
  const f = fixture({ sendText: () => gate.promise });
  const shutdown = f.engine.shutdownUntilComplete;
  f.engine.shutdownUntilComplete = async () => { gate.reject(new Error('cancelled')); await shutdown(); };
  const session = new EngineSession();
  await session.start(f.factory);
  const sending = session.sendText('message');
  const rejected = assert.rejects(sending, /OPERATION_FAILED/);
  await session.shutdown();
  await rejected;
  assert.equal(session.snapshot().phase, 'closed');
  assert.equal(session.snapshot().message, '');
  assert.equal(session.snapshot().busy, false);
});

const drainEvents = () => new Promise(resolve => setImmediate(resolve));

test('query completion events cannot recursively trigger state refresh', async () => {
  let queries = 0;
  const f = fixture({
    recoverSession: async () => ({ unlocked: true, resumed: true }),
    queryLocalDevice: async () => {
      if (++queries > 20) throw new Error('refresh feedback loop');
      f.emit({ kind: 'operation_finished', terminal: 'succeeded' });
      return { deviceId: 'test', displayName: 'Test' };
    },
    queryActiveClipboard: async () => {
      f.emit({ kind: 'operation_finished', terminal: 'succeeded' });
      return null;
    }
  });
  const session = new EngineSession();
  await session.start(f.factory);
  await drainEvents();
  const initial = queries;
  assert.equal(initial, 1);
  f.emit({ kind: 'active_clipboard_changed' });
  await drainEvents();
  assert.equal(queries, initial + 1);
  assert.equal(session.snapshot().message, '');
  await session.shutdown();
});

test('background events are skipped and foreground refreshes the latest state', async () => {
  let entry = 'first';
  const f = fixture({
    recoverSession: async () => ({ unlocked: true, resumed: true }),
    queryActiveClipboard: async () => ({ entryId: entry })
  });
  const session = new EngineSession();
  await session.start(f.factory);
  await session.setForeground(false);
  entry = 'latest';
  f.emit({ kind: 'active_clipboard_changed' });
  await drainEvents();
  assert.equal(session.snapshot().activeEntryId, 'first');
  await session.setForeground(true);
  assert.equal(session.snapshot().activeEntryId, 'latest');
  await session.shutdown();
});

test('fatal native event is visible without triggering more queries', async () => {
  const f = fixture();
  const session = new EngineSession();
  await session.start(f.factory);
  f.emit({ kind: 'fatal', errorCode: 1101 });
  await drainEvents();
  assert.equal(session.snapshot().phase, 'error');
  assert.match(session.snapshot().message, /连接已中断/);
  await session.shutdown();
});

test('a new host action clears the old operation outcome without changing session state', async () => {
  const f = fixture();
  const session = new EngineSession();
  await session.start(f.factory);
  await session.sendText('first');
  const before = session.snapshot();
  assert.match(before.message, /离线 1/);
  session.clearOperationMessage();
  assert.deepEqual(session.snapshot(), { ...before, message: '' });
  f.emit({ kind: 'fatal', errorCode: 1101 });
  await drainEvents();
  session.clearOperationMessage();
  assert.match(session.snapshot().message, /连接已中断/);
  await session.shutdown();
});

test('foreground resumes a quiesced Engine after the suspend wait expired', async () => {
  let state = 'running';
  let resumes = 0;
  const f = fixture({
    recoverSession: async () => ({ unlocked: true, resumed: true }),
    lifecycleState: async () => state,
    suspendWithDeadline: async () => {
      state = 'quiesced';
      throw new Error('suspend wait expired');
    },
    resume: async () => { resumes += 1; state = 'running'; },
    queryLocalDevice: async () => {
      if (state !== 'running') throw new Error('operation admission is closed');
      return { deviceId: 'test', displayName: 'Test' };
    }
  });
  const session = new EngineSession();
  await session.start(f.factory);
  const initialResumes = resumes;
  await assert.rejects(session.setForeground(false), /LIFECYCLE_FAILED/);
  assert.equal(session.snapshot().phase, 'error');
  await session.setForeground(true);
  assert.equal(resumes, initialResumes + 1);
  assert.equal(session.snapshot().phase, 'ready');
  assert.equal(session.snapshot().message, '');
  await session.shutdown();
});


test('file archive export uses the complete collection operation and reports success only after completion', async () => {
  const gate = deferred();
  const calls = [];
  const f = fixture({ exportEntryFiles: async (...args) => { calls.push(args); await gate.promise; } });
  const session = new EngineSession();
  await session.start(f.factory);
  const exporting = session.exportEntryFiles('files-entry', 'selected-output');
  assert.equal(session.snapshot().busy, true);
  assert.equal(session.snapshot().message, '');
  assert.deepEqual(calls, [['files-entry', 'selected-output']]);
  gate.resolve();
  await exporting;
  assert.equal(session.snapshot().message, '已将全部文件导出为 ZIP。');
  await session.shutdown();
});

test('file archive failure never reports a successful export', async () => {
  const f = fixture({ exportEntryFiles: async () => { throw new Error('private destination'); } });
  const session = new EngineSession();
  await session.start(f.factory);
  await assert.rejects(session.exportEntryFiles('entry', 'output'), /OPERATION_FAILED/);
  assert.equal(session.snapshot().busy, false);
  assert.ok(!session.snapshot().message.includes('已将全部'));
  assert.ok(!session.snapshot().message.includes('private'));
  await session.shutdown();
});

test('background suspension interrupts an active export without waiting for its completion', async () => {
  const gate = deferred();
  const f = fixture({
    exportEntryFiles: async () => gate.promise,
    suspendWithDeadline: async () => {
      f.calls.push('suspend');
      gate.reject(new Error('synthetic lifecycle cancellation'));
    }
  });
  const session = new EngineSession();
  await session.start(f.factory);
  const exporting = assert.rejects(session.exportEntryFiles('entry', 'output'), /OPERATION_FAILED/);
  await session.setForeground(false);
  await exporting;
  assert.equal(session.snapshot().phase, 'suspended');
  assert.equal(session.snapshot().busy, false);
  assert.equal(f.calls.filter(call => call === 'suspend').length, 1);
  assert.ok(!session.snapshot().message.includes('已将全部'));
  await session.setForeground(true);
  f.engine.exportEntryFiles = async () => {};
  await session.exportEntryFiles('entry', 'new-output');
  assert.equal(session.snapshot().message, '已将全部文件导出为 ZIP。');
  await session.shutdown();
});

test('admission invalidation promotes a pending join only after Engine confirms active and ready', async () => {
  let current = { status: 'pending', join_id: 'join-test' };
  let ready = false;
  const f = fixture({
    queryDeviceGroupChoices: async () => JSON.stringify({ device_trust: { current_join: current } }),
    queryEncryptionState: async () => ({ initialized: ready, sessionReady: ready })
  });
  const session = new EngineSession();
  await session.start(f.factory);
  await session.joinSpace('invite', 'Phone', 'passphrase');
  f.emit({ kind: 'refresh_required', refreshReason: 'state_invalidated' });
  await drainEvents();
  assert.equal(session.snapshot().unlocked, false);
  current = { status: 'active', join_id: 'join-test' };
  f.emit({ kind: 'refresh_required', refreshReason: 'state_invalidated' });
  await drainEvents();
  assert.equal(session.snapshot().unlocked, false);
  ready = true;
  f.emit({ kind: 'refresh_required', refreshReason: 'state_invalidated' });
  await drainEvents();
  assert.equal(session.snapshot().joinStatus, 'active');
  assert.equal(session.snapshot().unlocked, true);
  assert.equal(session.snapshot().phase, 'ready');
  await session.shutdown();
});

test('admission rejection refreshes the pending status without unlocking', async () => {
  let current = { status: 'pending', join_id: 'join-test' };
  const f = fixture({ queryDeviceGroupChoices: async () => JSON.stringify({ device_trust: { current_join: current } }) });
  const session = new EngineSession();
  await session.start(f.factory);
  await session.joinSpace('invite', 'Phone', 'passphrase');
  current = { status: 'rejected', join_id: 'join-test' };
  f.emit({ kind: 'refresh_required', refreshReason: 'state_invalidated' });
  await drainEvents();
  assert.equal(session.snapshot().joinStatus, 'rejected');
  assert.equal(session.snapshot().unlocked, false);
  await session.shutdown();
});

test('restart restores a pending admission and foreground reconciles its completion', async () => {
  let current = { status: 'processing', join_id: 'restart-join' };
  let ready = true;
  const f = fixture({
    queryDeviceGroupChoices: async () => JSON.stringify({ device_trust: { current_join: current } }),
    queryEncryptionState: async () => ({ initialized: true, sessionReady: ready }),
    lockEncryption: async () => { ready = false; }
  });
  const session = new EngineSession();
  await session.start(f.factory);
  assert.equal(session.snapshot().joinId, 'restart-join');
  assert.equal(session.snapshot().joinStatus, 'processing');
  await session.setForeground(false);
  current = { status: 'active', join_id: 'restart-join' };
  f.emit({ kind: 'refresh_required', refreshReason: 'state_invalidated' });
  await drainEvents();
  assert.equal(session.snapshot().phase, 'suspended');
  assert.equal(session.snapshot().unlocked, false);
  await session.setForeground(true);
  assert.equal(session.snapshot().phase, 'ready');
  await session.lock();
  f.emit({ kind: 'refresh_required', refreshReason: 'state_invalidated' });
  await drainEvents();
  assert.equal(session.snapshot().unlocked, false, 'refresh must not undo an explicit lock');
  await session.shutdown();
});

test('admission completion during join waits for the pending command response', async () => {
  const joining = deferred();
  let current = null;
  const f = fixture({
    joinSpace: () => joining.promise,
    queryDeviceGroupChoices: async () => JSON.stringify({ device_trust: { current_join: current } })
  });
  const session = new EngineSession();
  await session.start(f.factory);
  const operation = session.joinSpace('invite', 'Phone', 'passphrase');
  current = { status: 'active', join_id: 'join-test' };
  f.emit({ kind: 'refresh_required', refreshReason: 'state_invalidated' });
  await drainEvents();
  assert.equal(session.snapshot().unlocked, false);
  joining.resolve({ status: 'pending', joinId: 'join-test' });
  await operation;
  await drainEvents();
  assert.equal(session.snapshot().joinStatus, 'active');
  assert.equal(session.snapshot().phase, 'ready');
  await session.shutdown();
});

test('a failed admission query does not stop later event reconciliation', async () => {
  let fail = false;
  let current = null;
  const f = fixture({
    queryDeviceGroupChoices: async () => {
      if (fail) throw new Error('sensitive error details');
      return JSON.stringify({ device_trust: { current_join: current } });
    }
  });
  const session = new EngineSession();
  await session.start(f.factory);
  await session.joinSpace('invite', 'Phone', 'passphrase');
  fail = true;
  f.emit({ kind: 'refresh_required' });
  await drainEvents();
  assert.equal(session.snapshot().unlocked, false);
  assert.doesNotMatch(session.snapshot().message, /sensitive/);
  fail = false;
  current = { status: 'active', join_id: 'join-test' };
  f.emit({ kind: 'refresh_required' });
  await drainEvents();
  assert.equal(session.snapshot().phase, 'ready');
  await session.shutdown();
});

test('a rejected admission does not hide an existing recovered space', async () => {
  const f = fixture({
    recoverSession: async () => ({ unlocked: true, resumed: true }),
    queryDeviceGroupChoices: async () => JSON.stringify({ device_trust: {
      current_join: { status: 'rejected', join_id: 'previous-join' }
    } })
  });
  const session = new EngineSession();
  await session.start(f.factory);
  assert.equal(session.snapshot().joinStatus, 'rejected');
  assert.equal(session.snapshot().unlocked, true);
  assert.equal(session.snapshot().phase, 'ready');
  await session.shutdown();
});

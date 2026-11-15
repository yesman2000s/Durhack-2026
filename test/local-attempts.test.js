import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createLocalAttemptVault, requestPersistentStorage } from '../src/local-attempts.js';

// This small IDB adapter models request success separately from transaction
// commit, including quota aborts. No browser globals or real user data are used.
function databaseFixture() {
  let records = new Map();
  let initialized = false;
  const control = { holdCommit: false, pendingCommits: [], commitError: null };
  const database = {
    close() {},
    createObjectStore() { return { createIndex() {} }; },
    transaction() {
      const staged = new Map(records);
      let pending = 0;
      let completed = false;
      const tx = {
        abort() {
          if (completed) return;
          completed = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore() {
          const request = (operation) => {
            pending++;
            const req = {};
            queueMicrotask(() => {
              if (completed) return;
              req.result = structuredClone(operation());
              req.onsuccess?.();
              pending--;
              if (!pending) queueMicrotask(() => {
                if (completed || pending) return;
                const commit = () => {
                  if (completed) return;
                  if (control.commitError) {
                    tx.error = control.commitError;
                    control.commitError = null;
                    tx.onerror?.();
                    tx.abort();
                  } else {
                    records = staged;
                    completed = true;
                    tx.oncomplete?.();
                  }
                };
                if (control.holdCommit) control.pendingCommits.push(commit);
                else commit();
              });
            });
            return req;
          };
          return {
            get(key) { return request(() => staged.get(JSON.stringify(key))); },
            put(record) { return request(() => { staged.set(JSON.stringify([record.userId, record.attemptId]), structuredClone(record)); return record.attemptId; }); },
            delete(key) { return request(() => { staged.delete(JSON.stringify(key)); }); },
            index() { return { getAll(userId) { return request(() => [...staged.values()].filter((record) => record.userId === userId)); } }; },
          };
        },
      };
      return tx;
    },
  };
  control.indexedDB = {
    open() {
      const request = { result: database };
      queueMicrotask(() => {
        if (!initialized) { initialized = true; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    },
  };
  control.vault = createLocalAttemptVault({ indexedDB: control.indexedDB });
  return control;
}

test('local updates retain video bytes, MIME, full evidence and review feedback', async () => {
  const { vault } = databaseFixture();
  const video = new Blob(['recorded-video'], { type: 'video/webm;codecs=vp9' });
  const reps = [{ evidence: { snapshots: [{ phase: 'bottom', image: 'data:image/jpeg;base64,evidence', joints: [{ x: 0.5, y: 0.2 }] }] }, feedback: { score: 82 } }];
  const first = await vault.saveLocalAttempt('user-a', 'attempt-1', { video, reps, level: 3 });
  const saved = await vault.saveLocalAttempt('user-a', 'attempt-1', { attempt: { score: 82, completed: true }, video: undefined });
  assert.equal(saved.createdAt, first.createdAt);
  const restored = await vault.getLocalAttempt('user-a', 'attempt-1');
  assert.equal(await restored.video.text(), 'recorded-video');
  assert.equal(restored.video.type, video.type);
  assert.deepEqual(restored.reps, reps);
  assert.equal(restored.level, 3);
  assert.equal(restored.attempt.score, 82);
});

test('identical attempt IDs are isolated by account for read, list and delete', async () => {
  const { vault } = databaseFixture();
  await vault.saveLocalAttempt('user-a', 'shared-id', { userId: 'user-b', attemptId: 'wrong-id', reps: ['a'] });
  await vault.saveLocalAttempt('user-b', 'shared-id', { reps: ['b'] });
  assert.deepEqual((await vault.getLocalAttempt('user-a', 'shared-id')).reps, ['a']);
  assert.equal((await vault.listLocalAttempts('user-a')).length, 1);
  assert.equal((await vault.listLocalAttempts('user-b'))[0].userId, 'user-b');
  await vault.deleteLocalAttempt('user-a', 'shared-id');
  assert.equal(await vault.getLocalAttempt('user-a', 'shared-id'), null);
  assert.deepEqual((await vault.getLocalAttempt('user-b', 'shared-id')).reps, ['b']);
});

test('a save resolves only after the transaction commits', async () => {
  const fixture = databaseFixture();
  fixture.holdCommit = true;
  let resolved = false;
  const saving = fixture.vault.saveLocalAttempt('user', 'attempt', { reps: [] }).then(() => { resolved = true; });
  await nextTurn();
  assert.equal(fixture.pendingCommits.length, 1);
  assert.equal(resolved, false);
  fixture.pendingCommits[0]();
  await saving;
  assert.equal(resolved, true);
});

test('a quota failure rejects the save with an action and preserves the earlier recording', async () => {
  const fixture = databaseFixture();
  await fixture.vault.saveLocalAttempt('user', 'attempt', { reps: ['original'] });
  fixture.commitError = new DOMException('Quota exceeded', 'QuotaExceededError');
  await assert.rejects(fixture.vault.saveLocalAttempt('user', 'attempt', { reps: ['replacement'] }), /Delete an older local recording/);
  assert.deepEqual((await fixture.vault.getLocalAttempt('user', 'attempt')).reps, ['original']);
});

test('anonymous access and unsupported browser storage do not silently discard data', async () => {
  const { vault } = databaseFixture();
  await assert.rejects(vault.saveLocalAttempt('', 'attempt', {}), /signed-in user/);
  await assert.rejects(vault.getLocalAttempt('user', ''), /signed-in attempt/);
  await assert.rejects(vault.saveLocalAttempt('user', 'attempt', { video: 'not-a-blob' }), /video Blob/);
  const unsupported = createLocalAttemptVault({ indexedDB: null });
  await assert.rejects(unsupported.saveLocalAttempt('user', 'attempt', { reps: [] }), /IndexedDB enabled/);
});

test('persistent storage is best effort and respects existing permission', async () => {
  assert.equal(await requestPersistentStorage({ persisted: async () => true, persist: () => { throw new Error('Unnecessary request'); } }), true);
  assert.equal(await requestPersistentStorage({ persisted: async () => false, persist: async () => true }), true);
  assert.equal(await requestPersistentStorage({ persist: async () => false }), false);
  assert.equal(await requestPersistentStorage({ persist: async () => { throw new Error('Unavailable'); } }), false);
});

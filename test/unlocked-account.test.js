import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountStore } from '../server/accounts-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a provisioned music account unlocks every section without fabricated workouts or scores', async (t) => {
  const store = createAccountStore({ filename: ':memory:' });
  t.after(() => store.close());
  const { user } = await store.register({ name: 'Preview', email: 'preview@example.test', password: 'preview-password' });
  const normal = await store.register({ name: 'Normal', email: 'normal@example.test', password: 'normal-password' });
  store.unlockMusic(user.id);
  const progress = store.unlockMusic(user.id);
  assert.ok(progress.tracks.every((track) => track.completedLevels === 7 && track.bestScore === null && track.target === null && track.levels.every((level) => level.status === 'completed' && level.score === null)));
  assert.deepEqual(store.listAttempts(user.id), []);
  assert.ok(store.progress(normal.user.id).tracks.every((track) => track.completedLevels === 0));
  const attempt = store.createAttempt(user.id, { exerciseId: 'squat', level: 7, source: 'webcam', mode: 'single-rep' });
  const rep = { attemptId: attempt.id, id: 'first-real-rep', exercise: 'squat', source: 'webcam' };
  store.reserveRep(user.id, rep);
  store.recordRep(user.id, rep, { score: 75, summary: 'First workout', tips: [] });
  const result = store.finishAttempt(user.id, attempt.id);
  assert.equal(result.attempt.personalBest, true);
  assert.equal(result.attempt.passed, false);
  assert.equal(result.progress.tracks[0].bestScore, 75);
});

test('account provisioning preserves reviews running in the main server', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'compose-provision-'));
  const filename = join(directory, 'accounts.sqlite');
  const store = createAccountStore({ filename });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { user } = await store.register({ name: 'Active', email: 'active@example.test', password: 'active-password' });
  const attempt = store.createAttempt(user.id, { exerciseId: 'squat', level: 1, source: 'webcam', mode: 'single-rep' });
  const rep = { attemptId: attempt.id, id: 'pending-rep', exercise: 'squat', source: 'webcam' };
  store.reserveRep(user.id, rep);
  const provisioner = createAccountStore({ filename, recoverPendingReviews: false });
  try {
    const preview = await provisioner.register({ name: 'Preview', email: 'preview@example.test', password: 'preview-password' });
    provisioner.unlockMusic(preview.user.id);
  } finally { provisioner.close(); }
  assert.equal(store.attempt(user.id, attempt.id).reps[0].status, 'pending');
  store.recordRep(user.id, rep, { score: 80, summary: 'Review completed', tips: [] });
  assert.equal(store.finishAttempt(user.id, attempt.id).attempt.score, 80);
});

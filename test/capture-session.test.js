import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureSession, SET_IDLE_MS, SET_START_TIMEOUT_MS } from '../src/capture-session.js';

const rep = (id) => ({ id, exercise: 'push-up', variant: 'bodyweight', source: 'webcam',
  metrics: { range: 55, rangeUnit: 'degrees', outwardMs: 2000, invalid: NaN },
  snapshots: [{ imageBase64: 'private-image' }], motionTrace: { frames: ['private-poses'] } });
const observe = (session, timestampMs, options = {}) => session.observe({ timestampMs, hasPose: true, ...options });

test('counts each completed rep once and supplies bounded, image-free recent context', () => {
  const session = createCaptureSession('set', { id: 'session-a' });
  observe(session, 0);
  assert.deepEqual(session.contextForNextRep(), { id: 'session-a', mode: 'set', repNumber: 1, previousReps: [] });
  for (let i = 1; i <= 8; i++) session.addRep(rep(`r${i}`), i * 3000);
  session.addRep(rep('r8'), 24001);
  const context = session.contextForNextRep();
  assert.equal(session.snapshot().repCount, 8);
  assert.equal(context.repNumber, 9);
  assert.deepEqual(context.previousReps.map(({ id }) => id), ['r4', 'r5', 'r6', 'r7', 'r8']);
  assert.equal(context.previousReps[0].metrics.rangeUnit, 'degrees');
  assert.equal(context.previousReps[0].metrics.invalid, undefined);
  assert.ok(!JSON.stringify(session.snapshot()).includes('private-'));
  context.previousReps[0].metrics.range = -1;
  assert.equal(session.contextForNextRep().previousReps[0].metrics.range, 55);
});

test('ends a set after twelve seconds without another rep and preserves all completed summaries', () => {
  const session = createCaptureSession('set');
  observe(session, 0);
  session.addRep(rep('first'), 2000);
  assert.equal(observe(session, 2000 + SET_IDLE_MS - 1).active, true);
  const finished = observe(session, 2000 + SET_IDLE_MS);
  assert.equal(finished.active, false);
  assert.equal(finished.reason, 'inactivity');
  assert.equal(finished.repCount, 1);
  assert.equal(finished.endedAtMs, 14000);
});

test('trustworthy slow movement prevents idle timeout, including before the first completed rep', () => {
  const session = createCaptureSession('set');
  observe(session, 0);
  for (let time = 1000; time <= 60000; time += 1000) {
    assert.equal(observe(session, time, { moving: true }).active, true);
  }
  session.addRep(rep('first'), 60000);
  for (let time = 61000; time <= 80000; time += 1000) {
    assert.equal(observe(session, time, { moving: true }).active, true);
  }
  session.addRep(rep('second'), 80000);
  assert.equal(session.snapshot().repCount, 2);
});

test('brief pose loss is tolerated while stale movement without pose cannot keep a set open forever', () => {
  const session = createCaptureSession('set');
  observe(session, 0);
  session.addRep(rep('first'), 1000);
  assert.equal(observe(session, 1200, { moving: true, hasPose: false }).active, true);
  assert.equal(observe(session, 1300, { moving: true }).active, true);
  assert.equal(observe(session, 1300 + SET_IDLE_MS - 1, { moving: true, hasPose: false }).active, true);
  assert.equal(observe(session, 1300 + SET_IDLE_MS, { moving: true, hasPose: false }).reason, 'inactivity');
});

test('an interrupted attempt renews the recovery grace period without adding a rep', () => {
  const session = createCaptureSession('set');
  observe(session, 0);
  session.addRep(rep('first'), 1000);
  observe(session, 12000, { hasPose: false, discarded: true });
  assert.equal(observe(session, 13000, { hasPose: false }).active, true);
  assert.equal(observe(session, 24000, { hasPose: false }).reason, 'inactivity');
  assert.equal(session.snapshot().repCount, 1);
});

test('manual ending during a rep retains only completed reps and still accepts their pending feedback', () => {
  const session = createCaptureSession('set');
  observe(session, 0);
  session.addRep(rep('first'), 1000);
  observe(session, 1500, { moving: true });
  const finished = session.end('manual', 1600);
  assert.equal(finished.repCount, 1);
  session.addRep(rep('late'), 2000);
  assert.equal(session.snapshot().repCount, 1);
  session.updateFeedback('first', { score: 80, summary: 'Controlled movement.', tips: ['Lower steadily.'] });
  assert.equal(session.snapshot().reps[0].feedback.score, 80);
  assert.equal(session.end('idle', 5000).reason, 'manual');
});

test('times out an empty session but does not end a single-rep session before its caller queues feedback', () => {
  const empty = createCaptureSession('set');
  observe(empty, 100);
  assert.equal(observe(empty, 100 + SET_START_TIMEOUT_MS).reason, 'no-reps');
  const single = createCaptureSession('single-rep');
  observe(single, 0);
  assert.equal(single.addRep(rep('first'), 1000).active, true);
  assert.equal(single.end('complete').repCount, 1);
});

test('ignores invalid and reversed source times without changing inactivity accounting', () => {
  const session = createCaptureSession('set');
  observe(session, 1000);
  session.addRep(rep('first'), 2000);
  observe(session, 5000);
  const before = session.snapshot();
  observe(session, 4000, { moving: true });
  observe(session, NaN, { moving: true });
  assert.deepEqual(session.snapshot(), before);
  assert.equal(observe(session, 14000).reason, 'inactivity');
});

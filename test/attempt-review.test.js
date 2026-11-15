import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptOutcome, mergeAttemptReps } from '../src/attempt-review.js';

test('server reviews supersede stale local feedback while retaining local evidence and capture order', () => {
  const snapshots = [{ phase: 'bottom', url: 'data:image/jpeg;base64,fixture' }];
  const rows = mergeAttemptReps([
    { id: 'a', repNumber: 1, snapshots, feedback: { score: 54 }, review: { status: 'error' } },
    { id: 'b', repNumber: 2, review: { status: 'reviewing' } },
  ], [
    { id: 'b', status: 'scored', score: 83, feedback: { score: 83, tips: ['Keep steady.'] } },
    { id: 'a', status: 'scored', score: 81, feedback: { score: 81, tips: ['Slow the lowering.'] } },
    { id: 'c', status: 'error', score: null, error: 'Review failed.' },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
  assert.equal(rows[0].feedback.score, 81);
  assert.equal(rows[0].snapshots, snapshots);
  assert.equal(rows[0].reviewStatus, 'scored');
  assert.equal(rows[1].feedback.score, 83);
  assert.equal(rows[2].reviewError, 'Review failed.');
});

test('pending and null server scores do not resurrect stale local scores', () => {
  const [pending, uncertain] = mergeAttemptReps([
    { id: 'a', score: 90, feedback: { score: 90 } },
    { id: 'b', score: 95, feedback: { score: 95 } },
  ], [
    { id: 'a', status: 'pending', score: null, feedback: null },
    { id: 'b', status: 'scored', score: null, feedback: { score: null, tips: ['Keep your feet in frame.'] } },
  ]);
  assert.equal(pending.feedback, null);
  assert.equal(pending.score, null);
  assert.equal(uncertain.score, null);
  assert.deepEqual(uncertain.feedback.tips, ['Keep your feet in frame.']);
});

test('remote-only and local-only attempts remain reviewable without duplicate reps', () => {
  assert.deepEqual(mergeAttemptReps(undefined, [{ id: 'remote', status: 'scored', score: 78 }]).map((row) => row.id), ['remote']);
  const rows = mergeAttemptReps([{ id: 'local', review: { status: 'complete', feedback: { score: 72 } } }, { id: 'local' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feedback.score, 72);
});

test('attempt outcome distinguishes unfinished reviews, examples and cancelled practice', () => {
  assert.deepEqual(attemptOutcome({ passed: true, status: 'completed' }), { label: 'Unlocked', filter: 'unlocked' });
  assert.equal(attemptOutcome({ status: 'active' }).filter, 'active');
  assert.equal(attemptOutcome({ status: 'error' }).label, 'Review incomplete');
  assert.equal(attemptOutcome({ status: 'cancelled' }).label, 'Cancelled');
  assert.equal(attemptOutcome({ status: 'completed', source: 'simulated' }).label, 'Simulated practice');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSet } from '../src/set-feedback.js';
import { normalizeFeedback } from '../server/feedback.js';

const rep = (id, score, tips = []) => ({ id, review: { status: 'complete', feedback: { score, tips } } });

test('whole-set feedback includes every scored rep, independent of review completion order', () => {
  const reps = [rep('one', 60), rep('two', 90), rep('three', 84)];
  const result = summarizeSet(reps);
  assert.equal(result.average, 78);
  assert.equal(result.scored, 3);
  assert.match(result.summary, /60 to 90/);
  assert.deepEqual(summarizeSet([...reps].reverse()), result);
});

test('missing, unscored and failed reviews never count as zero or resurrect stale scores', () => {
  const result = summarizeSet([rep('one', 80), rep('two', null, ['Keep your feet in frame.']),
    { id: 'three', review: { status: 'error', feedback: { score: 100 } } },
    { id: 'four', review: { status: 'analyzing' } }]);
  assert.equal(result.average, 80);
  assert.equal(result.total, 4);
  assert.equal(result.reviewed, 2);
  assert.equal(result.scored, 1);
  assert.equal(result.focus[0].text, 'Keep your feet in frame.');
});

test('next-set focus prioritizes recurring tips and counts each tip once per unique rep', () => {
  const first = rep('one', 80, ['Keep steady.', 'Keep steady!', 'Lower slowly.']);
  const result = summarizeSet([first, first, rep('two', 82, ['keep steady', 'Stay in frame.'])]);
  assert.equal(result.total, 2);
  assert.equal(result.focus.length, 2);
  assert.deepEqual(result.focus[0], { text: 'Keep steady.', count: 2 });
});

test('saved server reviews produce the same summary as live coaching', () => {
  const live = [rep('one', 78, ['Keep steady.']), rep('two', 84)];
  const saved = live.map(({ id, review }) => ({ id, feedback: review.feedback, reviewStatus: 'scored' }));
  assert.deepEqual(summarizeSet(saved), summarizeSet(live));
});

test('empty, failed and entirely unscored sets have honest fallback feedback', () => {
  assert.match(summarizeSet([]).summary, /No complete reps/);
  assert.match(summarizeSet([{ id: 'failed', reviewStatus: 'error' }]).summary, /No rep feedback/);
  const result = summarizeSet([rep('one', null)]);
  assert.equal(result.average, null);
  assert.match(result.summary, /no form score/);
});

test('set summary and focus fit the existing speech endpoint contract', () => {
  const result = summarizeSet([rep('one', 78, ['Keep steady.']), rep('two', 84, ['Lower slowly.'])]);
  assert.ok(normalizeFeedback({ score: null, summary: result.summary, tips: result.focus.map((tip) => tip.text) }));
});

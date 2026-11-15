import test from 'node:test';
import assert from 'node:assert/strict';
import { instantRepFeedback } from '../src/instant-feedback.js';

test('instant feedback describes the captured rep without inventing a score', () => {
  const feedback = instantRepFeedback({ exercise: 'squat', session: { repNumber: 2 }, metrics: { durationMs: 2400, startKneeAngleDeg: 170, kneeAngleAtBottomDeg: 115 } });
  assert.equal(feedback.title, 'Rep 2 complete');
  assert.match(feedback.summary, /2.4s.*55° knee bend/);
  assert.equal('score' in feedback, false);
});
test('instant feedback ignores missing and invalid measurements', () => {
  const feedback = instantRepFeedback({ metrics: { durationMs: NaN, range: Infinity } });
  assert.doesNotMatch(feedback.summary, /NaN|Infinity|undefined/);
  assert.match(feedback.summary, /Movement captured/);
});
test('compact session rep measurements work for mobility movements', () => {
  assert.match(instantRepFeedback({ exercise: 'push-up', repNumber: 3, metrics: { range: 61, rangeUnit: 'degrees' } }).summary, /61° elbow bend/);
});

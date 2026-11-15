import test from 'node:test';
import assert from 'node:assert/strict';
import { EXERCISE_TRACKS, LEVEL_COUNT, evaluateProgression, progressionTarget } from '../src/level-progression.js';

const empty = { baseline: null, completedLevels: 0, levels: [] };
const established = (score = 80, reps = 1) => ({ baseline: 80, completedLevels: 1, levels: [{ level: 1, score, repCount: reps }] });
const result = (values = {}) => ({ level: 2, source: 'webcam', score: 80, repCount: 1, ...values });

test('four exercise lanes each unlock seven song sections', () => {
  assert.equal(LEVEL_COUNT, 7);
  assert.deepEqual(EXERCISE_TRACKS.map(({ id, instrument }) => [id, instrument]), [
    ['squat', 'Drums'], ['knee-raise', 'Bass'], ['push-up', 'Piano'], ['heel-raise', 'Guitar'],
  ]);
  assert.deepEqual(progressionTarget(empty), { level: 1, reps: 1, minScore: 0, scoreToBeat: null });
});

test('the first scored real rep establishes an independent baseline', () => {
  assert.deepEqual(evaluateProgression(empty, result({ level: 1, score: 85, baselineScore: 80, repCount: 3 })), { passed: true, baseline: 80, path: 'baseline' });
  for (const values of [{ source: 'simulated' }, { score: null }, { repCount: 0 }, { score: 101 }, { level: 2 }]) {
    assert.equal(evaluateProgression(empty, result({ level: 1, ...values })).passed, false);
  }
});

test('later levels require extra reps at baseline quality or better form', () => {
  const track = established();
  assert.deepEqual(progressionTarget(track), { level: 2, reps: 2, minScore: 77, scoreToBeat: 83 });
  assert.equal(evaluateProgression(track, result()).passed, false);
  assert.equal(evaluateProgression(track, result({ score: 82.99 })).passed, false);
  assert.equal(evaluateProgression(track, result({ score: 83 })).path, 'form');
  assert.equal(evaluateProgression(track, result({ score: 77, repCount: 2, source: 'video' })).path, 'reps');
  assert.equal(evaluateProgression(track, result({ score: 76.99, repCount: 20 })).passed, false);
});

test('targets follow the previous successful level and preserve a route at the score ceiling', () => {
  const track = established(100, 3);
  assert.deepEqual(progressionTarget(track), { level: 2, reps: 4, minScore: 77, scoreToBeat: null });
  assert.equal(evaluateProgression(track, result({ score: 100, repCount: 3 })).passed, false);
  assert.equal(evaluateProgression(track, result({ score: 100, repCount: 4 })).passed, true);
  assert.equal(progressionTarget({ completedLevels: 7 }), null);
  assert.equal(evaluateProgression({ ...track, completedLevels: 7 }, result({ level: 8 })).passed, false);
});

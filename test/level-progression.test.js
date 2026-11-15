import test from 'node:test';
import assert from 'node:assert/strict';
import { EXERCISE_TRACKS, LEVEL_COUNT, isPersonalBest, isScoredWorkout, progressionTarget } from '../src/level-progression.js';

test('four exercise lanes each unlock seven song sections', () => {
  assert.equal(LEVEL_COUNT, 7);
  assert.deepEqual(EXERCISE_TRACKS.map(({ id, instrument }) => [id, instrument]), [
    ['squat', 'Drums'], ['knee-raise', 'Bass'], ['push-up', 'Piano'], ['heel-raise', 'Guitar'],
  ]);
  assert.deepEqual(progressionTarget(), { level: 1, reps: 1, scoreToBeat: null });
  assert.deepEqual(progressionTarget({ completedLevels: 1, bestScore: 83.25 }), { level: 2, reps: 1, scoreToBeat: 83.25 });
  assert.equal(progressionTarget({ completedLevels: 7, bestScore: 100 }), null);
});

test('numeric real workouts qualify, including a first score of zero', () => {
  assert.equal(isScoredWorkout(0, 'webcam'), true);
  assert.equal(isScoredWorkout(100, 'video'), true);
  assert.equal(isScoredWorkout(70, 'simulated'), false);
  for (const score of [null, NaN, -1, 101, '90']) assert.equal(isScoredWorkout(score, 'webcam'), false);
  assert.equal(isPersonalBest(0, null), true);
  assert.equal(isPersonalBest(0, 0), false);
  assert.equal(isPersonalBest(83.26, 83.25), true);
  assert.equal(isPersonalBest(83.24, 83.25), false);
  assert.equal(isPersonalBest(100, 100), false);
});

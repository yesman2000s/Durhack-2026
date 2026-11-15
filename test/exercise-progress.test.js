import test from 'node:test';
import assert from 'node:assert/strict';
import { exerciseProgress, progressCoordinates } from '../src/exercise-progress.js';

const workout = (id, score, day, extra = {}) => ({ id, exerciseId: 'squat', variant: 'bodyweight',
  source: 'webcam', status: 'completed', score, createdAt: `2026-11-${day}T12:00:00Z`, ...extra });

test('progress sorts by workout time and retains ties and lower scores', () => {
  const attempts = [workout('last', 81.02, '15'), workout('first', 60, '11', { personalBest: true }), workout('dip', 74, '13'), workout('best', 82, '12', { personalBest: true }), workout('tie', 82, '14')];
  const result = exerciseProgress(attempts, 'squat');
  assert.deepEqual(result.points.map(({ attempt }) => attempt.id), ['first', 'best', 'dip', 'tie', 'last']);
  assert.deepEqual(result.points.map(({ personalBest }) => personalBest), [true, true, false, false, false]);
  assert.deepEqual([result.first, result.latest, result.best, result.change], [60, 81.02, 82, 21.02]);
  assert.equal(attempts[0].id, 'last', 'does not reorder account history');
});

test('only complete scored real attempts for the selected exercise and variant contribute', () => {
  const attempts = [workout('valid-zero', 0, '10'), workout('video', 75, '11', { source: 'video' }),
    workout('example', 99, '11', { source: 'simulated' }), workout('cancelled', 99, '11', { status: 'cancelled' }),
    workout('error', 99, '11', { status: 'error' }), workout('active', 99, '11', { status: 'active' }),
    workout('missing', null, '11'), workout('high', 101, '11'), workout('low', -1, '11'),
    workout('invalid-time', 99, 'XX'), workout('other-exercise', 99, '11', { exerciseId: 'push-up' }),
    workout('other-variant', 99, '11', { variant: 'barbell' })];
  assert.deepEqual(exerciseProgress(attempts, 'squat', 'bodyweight').points.map(({ attempt }) => attempt.id), ['valid-zero', 'video']);
});

test('empty and single workout histories do not claim improvement', () => {
  assert.deepEqual(exerciseProgress([], 'squat'), { points: [], first: null, latest: null, best: null, change: null });
  const result = exerciseProgress([workout('one', 80, '15')], 'squat');
  assert.equal(result.change, null);
  assert.equal(result.points[0].personalBest, false, 'does not invent a personal best when earlier history is outside the loaded window');
  assert.equal(progressCoordinates(result.points)[0].x, 390);
});

test('chart follows elapsed time on a fixed 0–100 scale and handles identical dates', () => {
  const result = exerciseProgress([workout('first', 0, '10'), workout('middle', 50, '11'), workout('last', 100, '15')], 'squat');
  const coordinates = progressCoordinates(result.points);
  assert.equal(coordinates[0].y, 200);
  assert.equal(coordinates[2].y, 22);
  assert.ok(coordinates[1].x < (coordinates[0].x + coordinates[2].x) / 2);
  const mobile = progressCoordinates(result.points, { width: 320 });
  assert.equal(mobile[0].x, 42);
  assert.equal(mobile[2].x, 298, 'latest point stays inside the measured mobile width');
  assert.equal(mobile[2].y, 22, 'the score axis keeps its fixed readable height');
  const duplicateTimes = exerciseProgress([workout('a', 50, '10'), workout('b', 60, '10')], 'squat');
  assert.ok(progressCoordinates(duplicateTimes.points).every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

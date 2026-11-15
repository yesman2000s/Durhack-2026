import test from 'node:test';
import assert from 'node:assert/strict';
import { songs } from '../src/music/songs.js';
import {
  completeExercise, demoStreaks, exercisePart, exercises, readProgress, writeProgress,
} from '../src/music/progression.js';

function createStorage(value = null) {
  let saved = value;
  return {
    getItem: () => saved,
    setItem: (key, next) => { saved = next; },
  };
}

test('keeps the home movements linked to their instruments in every genre', () => {
  assert.deepEqual(exercises.map(({ id, instrument }) => [id, instrument]), [
    ['squat', 'Drums'],
    ['knee-raise', 'Bass'],
    ['push-up', 'Piano'],
  ]);
  assert.deepEqual(exercises.map((exercise) => exercisePart(songs[2], exercise).stem), ['drums', 'bass', 'piano']);
  assert.deepEqual(exercises.map((exercise) => exercisePart(songs[0], exercise).stem), ['drums-low', 'bass', 'other']);
});

test('loads initial progress and persists each movement independently', () => {
  const storage = createStorage();
  const initial = readProgress(storage);
  assert.deepEqual(initial, demoStreaks);

  const next = completeExercise(initial, 'knee-raise');
  writeProgress(next, storage);
  assert.deepEqual(readProgress(storage), { ...demoStreaks, 'knee-raise': 2 });
  assert.equal(next.squat, demoStreaks.squat);
  assert.equal(next['push-up'], demoStreaks['push-up']);
});

test('reports malformed saved progress instead of silently resetting it', () => {
  assert.throws(() => readProgress(createStorage('{bad json')), /could not be read/);
  assert.throws(() => readProgress(createStorage('{"squat":-1}')), /is invalid/);
});

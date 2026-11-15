export const exercises = [
  { id: 'squat', name: 'Squat', instrument: 'Drums', stem: 'drums', color: '#d66b48' },
  { id: 'knee-raise', name: 'Knee Raise', instrument: 'Bass', stem: 'bass', color: '#4775ad' },
  { id: 'push-up', name: 'Push Ups', instrument: 'Piano', stem: 'piano', color: '#9c7328' },
];

export const PROGRESSION_KEY = 'compose.music-progress.v1';
export const demoStreaks = { squat: 1, 'knee-raise': 1, 'push-up': 1 };

export function exercisePart(song, exercise) {
  if (song.percussionParts && exercise.id === 'squat') return { stem: 'drums-low', name: 'Low percussion' };
  if (song.percussionParts && exercise.id === 'push-up') return { stem: 'other', name: 'Melodic stem' };
  return { stem: exercise.stem, name: exercise.instrument };
}

export function readProgress(storage) {
  const saved = storage.getItem(PROGRESSION_KEY);
  if (saved === null) return { ...demoStreaks };

  let parsed;
  try {
    parsed = JSON.parse(saved);
  } catch {
    throw new Error('Saved music progress could not be read.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Saved music progress has an invalid format.');
  }

  return Object.fromEntries(exercises.map(({ id }) => {
    const streak = parsed[id] ?? demoStreaks[id];
    if (!Number.isSafeInteger(streak) || streak < 0) {
      throw new Error(`Saved progress for ${id} is invalid.`);
    }
    return [id, streak];
  }));
}

export function writeProgress(streaks, storage) {
  const valid = exercises.every(({ id }) => Number.isSafeInteger(streaks[id]) && streaks[id] >= 0);
  if (!valid) throw new Error('Music progress must contain a non-negative whole-number streak for every movement.');
  storage.setItem(PROGRESSION_KEY, JSON.stringify(streaks));
}

export function completeExercise(streaks, exerciseId) {
  if (!exercises.some(({ id }) => id === exerciseId)) throw new Error(`Unknown movement: ${exerciseId}`);
  if (!Number.isSafeInteger(streaks[exerciseId]) || streaks[exerciseId] < 0) {
    throw new Error(`Progress for ${exerciseId} is invalid.`);
  }
  if (streaks[exerciseId] === Number.MAX_SAFE_INTEGER) throw new Error(`Progress for ${exerciseId} cannot increase further.`);
  return { ...streaks, [exerciseId]: streaks[exerciseId] + 1 };
}

export function applyExerciseResult(streaks, result) {
  if (result?.success !== true || !exercises.some(({ id }) => id === result.exerciseId)) return streaks;
  const { exerciseId, streak } = result;
  if (!Number.isSafeInteger(streak) || streak < 0 || streak === streaks[exerciseId]) return streaks;
  return { ...streaks, [exerciseId]: streak };
}

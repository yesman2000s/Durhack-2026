const segments = [[1, 'First bar'], [3, 'Second bar'], [4, 'Full phrase']];

export const exercises = [
  { id: 'squat', name: 'Squat', instrument: 'Drums', stem: 'drums', color: '#b7f5cf', segments },
  { id: 'step-up', name: 'Step-up', instrument: 'Bass', stem: 'bass', color: '#f5cb93', segments },
  { id: 'calf-raise', name: 'Calf raise', instrument: 'Guitar', stem: 'guitar', color: '#cfc5ff', segments },
  { id: 'wall-push-up', name: 'Wall push-up', instrument: 'Other instruments', stem: 'other', color: '#f6b5c3', segments },
  { id: 'lunge', name: 'Lunge', instrument: 'Piano', stem: 'piano', color: '#a8dcf5', segments },
];

export const demoStreaks = { squat: 3, 'step-up': 3, 'calf-raise': 1, 'wall-push-up': 4, lunge: 0 };

export function applyExerciseResult(streaks, result) {
  if (result?.success !== true || !exercises.some(({ id }) => id === result.exerciseId)) return streaks;
  const { exerciseId, streak } = result;
  if (!Number.isSafeInteger(streak) || streak < 0 || streak === streaks[exerciseId]) return streaks;
  return { ...streaks, [exerciseId]: streak };
}

export function earnedSegments(exercise, streak = 0) {
  return exercise.segments.filter(([days]) => streak >= days).length;
}

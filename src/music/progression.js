export const exercises = [
  { id: 'squat', name: 'Squat', instrument: 'Drums', color: '#b7f5cf',
    segments: [[1, 'Kick'], [3, 'Snare'], [4, 'Hi-hats']] },
  { id: 'step-up', name: 'Step-up', instrument: 'Bass', color: '#f5cb93',
    segments: [[1, 'Root notes'], [3, 'Passing notes'], [4, 'Octave accents']] },
  { id: 'calf-raise', name: 'Calf raise', instrument: 'Keys', color: '#cfc5ff',
    segments: [[1, 'Chords'], [3, 'Syncopation'], [4, 'High voicings']] },
  { id: 'wall-push-up', name: 'Wall push-up', instrument: 'Melody', color: '#f6b5c3',
    segments: [[1, 'Main phrase'], [3, 'Answer phrase'], [4, 'High accents']] },
];

export const demoStreaks = { squat: 3, 'step-up': 1, 'calf-raise': 0, 'wall-push-up': 0 };

// A confirmed result supplies the exercise ID and the server's current daily streak.
export function applyExerciseResult(streaks, result) {
  if (result?.success !== true || !exercises.some(({ id }) => id === result.exerciseId)) return streaks;
  const { exerciseId, streak } = result;
  if (!Number.isSafeInteger(streak) || streak < 0 || streak === streaks[exerciseId]) return streaks;
  return { ...streaks, [exerciseId]: streak };
}

export function earnedSegments(exercise, streak = 0) {
  return exercise.segments.filter(([days]) => streak >= days).length;
}

export const LEVEL_COUNT = 7;
export const EXERCISE_TRACKS = [
  { id: 'squat', name: 'Squat', instrument: 'Drums', color: '#d66b48', stem: 'drums' },
  { id: 'knee-raise', name: 'Knee Raise', instrument: 'Bass', color: '#4775ad', stem: 'bass' },
  { id: 'push-up', name: 'Push Ups', instrument: 'Piano', color: '#9c7328', stem: 'piano' },
  { id: 'heel-raise', name: 'Heel Raise', instrument: 'Guitar', color: '#6b8570', stem: 'guitar' },
];

export function progressionTarget(track) {
  const completed = track?.completedLevels ?? 0;
  if (completed >= LEVEL_COUNT) return null;
  return { level: completed + 1, reps: 1, scoreToBeat: track?.bestScore ?? null };
}

export function isScoredWorkout(score, source) {
  return (source === 'webcam' || source === 'video') && Number.isFinite(score) && score >= 0 && score <= 100;
}

export function isPersonalBest(score, bestScore) {
  return bestScore == null || score > bestScore;
}

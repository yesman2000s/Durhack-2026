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
  if (completed === 0) return { level: 1, reps: 1, minScore: 0, scoreToBeat: null };
  const previous = track.levels.find((item) => item.level === completed);
  const scoreToBeat = Math.round((previous.score + 3) * 100) / 100;
  return {
    level: completed + 1,
    reps: previous.repCount + 1,
    minScore: Math.max(0, track.baseline - 3),
    scoreToBeat: scoreToBeat <= 100 ? scoreToBeat : null,
  };
}

// This is shared presentation/domain logic. Only server-recorded coaching
// results are allowed to reach the durable progression write path.
export function evaluateProgression(track, { score, repCount, source, level, baselineScore = score }) {
  const target = progressionTarget(track);
  const eligible = ['webcam', 'video'].includes(source) && Number.isFinite(score) && score >= 0 && score <= 100 &&
    Number.isInteger(repCount) && repCount >= 1 && target?.level === level;
  if (!eligible) return { passed: false, baseline: track?.baseline ?? null, path: null };
  if (level === 1) return { passed: true, baseline: baselineScore, path: 'baseline' };
  const moreReps = repCount >= target.reps && score >= target.minScore;
  const betterForm = target.scoreToBeat !== null && score >= target.scoreToBeat;
  return { passed: moreReps || betterForm, baseline: track.baseline, path: moreReps ? 'reps' : betterForm ? 'form' : null };
}

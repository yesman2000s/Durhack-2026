import { isScoredWorkout } from './level-progression.js';

// Only settled, real workouts are comparable. Keep lower scores and ties: a
// progress view should show practice honestly, not only personal bests.
export function exerciseProgress(attempts, exerciseId, variant) {
  const points = attempts
    .filter((attempt) => attempt.exerciseId === exerciseId
      && attempt.status === 'completed'
      && isScoredWorkout(attempt.score, attempt.source)
      && (!variant || (attempt.variant ?? 'bodyweight') === variant))
    .map((attempt) => ({ attempt, score: attempt.score, time: Date.parse(attempt.endedAt ?? attempt.createdAt) }))
    .filter((point) => Number.isFinite(point.time))
    .sort((left, right) => left.time - right.time);
  let best = null;
  for (const point of points) {
    point.personalBest = point.attempt.personalBest === true;
    best = best === null ? point.score : Math.max(best, point.score);
    point.best = best;
  }
  const first = points[0]?.score ?? null;
  const latest = points.at(-1)?.score ?? null;
  return { points, first, latest, best,
    change: points.length > 1 ? Math.round((latest - first) * 100) / 100 : null };
}

export function progressCoordinates(points, { width = 760, height = 232, left = 42, right = 22, top = 22, bottom = 32 } = {}) {
  const duration = points.length > 1 ? points.at(-1).time - points[0].time : 0;
  return points.map((point, index) => ({ ...point,
    x: left + (width - left - right) * (points.length === 1 ? 0.5
      : duration > 0 ? (point.time - points[0].time) / duration : index / (points.length - 1)),
    y: top + (height - top - bottom) * (1 - point.score / 100),
  }));
}

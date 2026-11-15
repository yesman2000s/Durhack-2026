// The account owns review results; the browser owns the recorded evidence.
// A local snapshot may predate a completed/retried server review.
export function mergeAttemptReps(localReps = [], serverReps = []) {
  const remote = new Map(serverReps.filter((rep) => rep.id).map((rep) => [rep.id, rep]));
  const seen = new Set();
  const rows = [];
  for (const local of localReps) {
    if (local.id && seen.has(local.id)) continue;
    const saved = remote.get(local.id);
    if (local.id) seen.add(local.id);
    rows.push(saved ? {
      ...local, ...saved, snapshots: local.snapshots,
      feedback: saved.feedback ?? null, score: saved.score ?? null,
      reviewStatus: saved.status, reviewError: saved.error ?? '',
    } : {
      ...local, feedback: local.feedback ?? local.review?.feedback ?? null,
      reviewStatus: local.review?.status ?? 'local', reviewError: local.review?.error ?? '',
    });
  }
  for (const saved of serverReps) {
    if (saved.id && seen.has(saved.id)) continue;
    if (saved.id) seen.add(saved.id);
    rows.push({ ...saved, reviewStatus: saved.status, reviewError: saved.error ?? '' });
  }
  return rows;
}

export function attemptOutcome(attempt) {
  if (attempt.passed) return { label: 'Unlocked', filter: 'unlocked' };
  if (attempt.status === 'active') return { label: 'In progress', filter: 'active' };
  if (attempt.status === 'error') return { label: 'Review incomplete', filter: 'error' };
  if (attempt.status === 'cancelled') return { label: 'Cancelled', filter: 'practice' };
  if (attempt.source === 'simulated') return { label: 'Simulated practice', filter: 'practice' };
  return { label: 'Keep practising', filter: 'practice' };
}

// Summarize completed rep reviews, without treating missing scores as zero.
export function summarizeSet(reps = []) {
  const unique = [...new Map(reps.map((rep, index) => [rep.id ?? index, rep])).values()];
  const reviewed = unique.filter((rep) => {
    const status = rep.reviewStatus ?? rep.review?.status;
    return (!status || ['complete', 'scored', 'local'].includes(status)) && (rep.feedback ?? rep.review?.feedback);
  });
  const feedback = reviewed.map((rep) => rep.feedback ?? rep.review.feedback);
  const scores = feedback.map((item) => item.score).filter((score) => Number.isFinite(score) && score >= 0 && score <= 100);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
  const tips = new Map();
  for (const item of feedback) {
    const seen = new Set();
    for (const raw of item.tips ?? []) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const text = raw.trim();
      const key = text.toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      const tip = tips.get(key) ?? { text, count: 0 };
      tip.count++;
      tips.set(key, tip);
    }
  }
  const focus = [...tips.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)).slice(0, 2);
  const total = unique.length;
  const summary = !total ? 'No complete reps were captured in this set.'
    : !reviewed.length ? 'No rep feedback is available for this set yet.'
      : average === null ? 'Your set has coaching feedback, but no form score could be given.'
        : `Your set averaged ${average}/100 across ${scores.length} scored ${scores.length === 1 ? 'rep' : 'reps'}.${scores.length > 1 && Math.min(...scores) !== Math.max(...scores) ? ` Scores ranged from ${Math.min(...scores)} to ${Math.max(...scores)}.` : ''}`;
  return { total, reviewed: reviewed.length, scored: scores.length, average, summary, focus };
}

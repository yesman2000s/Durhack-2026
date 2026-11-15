export function normalizeFeedback(input) {
  const score = input?.score;
  const tips = input?.tips;
  const summary = input?.summary;
  if ((score !== null && (!Number.isInteger(score) || score < 0 || score > 100)) ||
      !Array.isArray(tips) || tips.length > 3 ||
      tips.some((tip) => typeof tip !== 'string' || !tip.trim() || tip.length > 120 ||
        tip.trim().split(/\s+/).length > 12) ||
      (summary !== undefined && (typeof summary !== 'string' || !summary.trim() || summary.length > 180))) return null;
  return { score, ...(summary !== undefined ? { summary: summary.trim() } : {}), tips: tips.map((tip) => tip.trim()) };
}

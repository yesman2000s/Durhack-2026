export function normalizeFeedback(input) {
  const score = input?.score;
  const tips = input?.tips;
  if ((score !== null && (!Number.isInteger(score) || score < 0 || score > 100)) ||
      !Array.isArray(tips) || tips.length > 3 ||
      tips.some((tip) => typeof tip !== 'string' || !tip.trim() || tip.length > 120 ||
        tip.trim().split(/\s+/).length > 12)) return null;
  return { score, tips: tips.map((tip) => tip.trim()) };
}

// Immediate observations come from the completed capture, never an invented
// form score. Only the server review can score a rep or award progression.
export function instantRepFeedback(rep) {
  const metrics = rep?.metrics ?? {};
  const measurements = [];
  if (Number.isFinite(metrics.durationMs) && metrics.durationMs > 0) measurements.push(`${(metrics.durationMs / 1000).toFixed(1)}s movement`);
  const bend = metrics.kneeExcursionDeg ?? (metrics.startKneeAngleDeg - metrics.kneeAngleAtBottomDeg);
  if (rep?.exercise === 'squat' && Number.isFinite(bend) && bend > 0) measurements.push(`${Math.round(bend)}° knee bend`);
  else if (Number.isFinite(metrics.range) && metrics.range > 0) {
    if (metrics.rangeUnit === 'degrees') measurements.push(`${Math.round(metrics.range)}° ${rep.exercise === 'push-up' ? 'elbow bend' : 'thigh lift'}`);
  }
  return {
    title: `Rep ${rep?.repNumber ?? rep?.session?.repNumber ?? 1} complete`,
    summary: measurements.length ? `${measurements.join(' · ')}. Returned to your starting position.` : 'Movement captured. Returned to your starting position.',
  };
}

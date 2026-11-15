const LEG_LANDMARKS = { left: [23, 25, 27], right: [24, 26, 28] };

export function measureThighToShin({ landmarks, width, height }, side) {
  const indices = LEG_LANDMARKS[side];
  if (!indices || ![width, height].every((size) => Number.isFinite(size) && size > 0)) return null;
  const [hip, knee, ankle] = indices.map((index) => landmarks?.[index]);
  if (![hip, knee, ankle].every((point) => point && Number.isFinite(point.x)
    && Number.isFinite(point.y) && [point.visibility ?? 1, point.presence ?? 1]
      .every((confidence) => Number.isFinite(confidence) && confidence >= 0.35))) return null;

  const distance = (a, b) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const thigh = distance(hip, knee);
  const shin = distance(knee, ankle);
  // Match the minimum visible segment length used by the tracker.
  if (Math.min(thigh, shin) < height * 0.035) return null;
  return +(thigh / shin).toFixed(3);
}

export function summarizeThighToShin(frames, startOffsetMs, returnOffsetMs, standingRatio) {
  const ratios = frames.filter(({ offsetMs }) => offsetMs >= startOffsetMs && offsetMs <= returnOffsetMs)
    .map(({ thighToShinRatio }) => thighToShinRatio).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ratios.length) return Number.isFinite(standingRatio) ? standingRatio : null;
  const center = Math.floor(ratios.length / 2);
  if (ratios.length % 2) return ratios[center];
  return +((ratios[center - 1] + ratios[center]) / 2).toFixed(3);
}

export const POSE_SAMPLE_INTERVAL_MS = 1000 / 12;

export function nextPoseSampleTime(deadline, now) {
  const intervals = Math.max(1, Math.floor((now - deadline) / POSE_SAMPLE_INTERVAL_MS) + 1);
  return deadline + POSE_SAMPLE_INTERVAL_MS * intervals;
}

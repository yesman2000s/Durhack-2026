function centerCrop(width, height, ratio) {
  const cropWidth = Math.max(1, Math.min(width, Math.round(height * ratio)));
  return { left: Math.floor((width - cropWidth) / 2), width: cropWidth };
}

export function centerCameraCrop(width, height) {
  return centerCrop(width, height, 0.95);
}

// Give the model more horizontal room for the hips and torso to move while
// keeping the same centered preview and full-image coordinate system.
export function poseCameraCrop(width, height) {
  return centerCrop(width, height, 1.25);
}

export function sourceLandmarks(landmarks, sourceWidth, crop) {
  if (!landmarks || crop.width === sourceWidth) return landmarks;
  return landmarks.map((point) => ({
    ...point,
    x: (crop.left + point.x * crop.width) / sourceWidth,
    z: Number.isFinite(point.z) ? point.z * crop.width / sourceWidth : point.z,
    visibility: point.x >= 0 && point.x <= 1 ? point.visibility : 0,
  }));
}

export function poseInCenter(landmarks, sourceWidth, crop) {
  if (!landmarks || !crop || crop.width === sourceWidth) return true;
  const sides = [[23, 27], [24, 28]];
  const confidence = (point) => Math.min(point.visibility ?? 1, point.presence ?? 1);
  const best = sides
    .map(([hip, ankle]) => [landmarks[hip], landmarks[ankle]])
    .filter((pair) => pair.every((point) => point && Number.isFinite(point.x)
      && [point.visibility ?? 1, point.presence ?? 1].every((confidence) => Number.isFinite(confidence) && confidence >= .55)))
    .sort(([hip, ankle], [otherHip, otherAnkle]) => confidence(otherHip) + confidence(otherAnkle) - confidence(hip) - confidence(ankle))[0];
  if (!best) return true;
  const [hip, ankle] = best;
  const midpoint = ((hip.x + ankle.x) * sourceWidth * 0.5 - crop.left) / crop.width;
  return midpoint >= 0.08 && midpoint <= 0.92;
}

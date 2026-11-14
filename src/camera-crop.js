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
  const best = sides
    .map(([hip, ankle]) => [landmarks[hip], landmarks[ankle]])
    .filter(([hip, ankle]) => hip?.visibility >= 0.55 && ankle?.visibility >= 0.55)
    .sort(([hip, ankle], [otherHip, otherAnkle]) => otherHip.visibility + otherAnkle.visibility - hip.visibility - ankle.visibility)[0];
  if (!best) return true;
  const [hip, ankle] = best;
  const midpoint = ((hip.x + ankle.x) * sourceWidth * 0.5 - crop.left) / crop.width;
  return midpoint >= 0.175 && midpoint <= 0.825;
}

export const PHASE_LABELS = {
  start: 'Standing', descent: 'Lowering', bottom: 'Bottom', ascent: 'Rising', finish: 'Standing again',
};

export const FORM_GUIDE = [
  'Start tall with your feet planted.',
  'Bend at the hips and knees together as you lower.',
  'Use a comfortable depth and keep your whole foot in contact with the floor.',
  'Stand back up in one controlled motion. For this drill, try about two seconds down and one second up.',
];

export function framePose(frame, live) {
  if (!live) return null;
  const offset = live.side === 'right' ? 1 : 0;
  const joints = Object.fromEntries(Object.entries({
    nose: 0, shoulder: 11 + offset, hip: 23 + offset, knee: 25 + offset,
    ankle: 27 + offset, heel: 29 + offset, toe: 31 + offset,
  }).flatMap(([joint, index]) => {
    const point = frame.landmarks?.[index];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
    return [[joint, { x: point.x, y: point.y, visibility: Number.isFinite(point.visibility) ? point.visibility : null }]];
  }));
  return {
    side: live.side,
    torsoLeanDeg: live.torsoLeanDeg,
    shinLeanDeg: live.shinLeanDeg,
    hipAngleDeg: live.hipAngleDeg,
    hipDropLegLengths: live.hipDropRatio,
    hipToKneeLegLengths: live.hipToKneeRatio,
    hipSpeedLegLengthsPerSec: live.hipSpeedLegLengthsPerSec,
    joints,
  };
}

export function captureImage(source, width, height) {
  const scale = Math.min(1, 960 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.84);
  if (!url.startsWith('data:image/jpeg;base64,')) return null;
  return { url, width: canvas.width, height: canvas.height };
}

export function makeEvidence({ rep, images, captureStartMs, source, camera, capturedAt, reference }) {
  const metrics = {
    ...rep.metrics,
    kneeExcursionDeg: rep.metrics.startKneeAngleDeg - rep.metrics.kneeAngleAtBottomDeg,
    returnAngleErrorDeg: Math.abs(rep.metrics.startKneeAngleDeg - rep.metrics.finishKneeAngleDeg),
  };
  const snapshots = Object.keys(PHASE_LABELS).flatMap((phase) => {
    const frame = images.get(phase);
    if (!frame) return [];
    return [{ phase, ...frame, offsetMs: Math.round(frame.timestampMs - captureStartMs) }];
  });
  return {
    schemaVersion: 1,
    id: globalThis.crypto.randomUUID(),
    exercise: 'squat', variant: 'bodyweight', captureMode: 'single-rep',
    source, capturedAt, camera, trackingSide: rep.side,
    movementStartOffsetMs: Math.round(rep.startedAtMs - captureStartMs),
    reference: reference ?? null,
    metrics,
    cue: reference?.establishedByThisRep
      ? { code: 'BASELINE_CAPTURED', text: 'This first squat is your baseline. Download it if you want to keep it for later.' }
      : { code: 'OBSERVED_CYCLE', text: 'The camera tracked a complete squat. You can compare the range with your first rep.' },
    observations: rep.cues,
    practiceGuide: {
      descentTargetMs: 2000, ascentTargetMs: 1000, guidance: FORM_GUIDE,
      depthTarget: 'comfortable personal reference', torsoAngleTarget: null,
      proportionMethod: 'Approximate ratios projected from standing, without absolute height or distance calibration.',
      measurementLimits: 'Estimates from one side in 2D. Do not infer side-to-side knee alignment, spinal loading, overall safety, or balance.',
    },
    snapshots,
  };
}

export function downloadEvidence(evidence) {
  const payload = {
    ...evidence,
    snapshots: evidence.snapshots.map(({ url, timestampMs, ...snapshot }) => ({
      ...snapshot, mimeType: 'image/jpeg', imageBase64: url.slice(url.indexOf(',') + 1),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `compose-squat-${evidence.id.slice(0, 8)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

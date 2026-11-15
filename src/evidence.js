import { measureThighToShin, summarizeThighToShin } from './leg-proportions.js';
import { exerciseInfo } from './exercises.js';

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
    nose: 0, shoulder: 11 + offset, elbow: 13 + offset, wrist: 15 + offset, hip: 23 + offset, knee: 25 + offset,
    ankle: 27 + offset, heel: 29 + offset, toe: 31 + offset,
  }).flatMap(([joint, index]) => {
    const point = frame.landmarks?.[index];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
    return [[joint, {
      x: point.x, y: point.y,
      visibility: point.visibility == null ? null : Number.isFinite(point.visibility) ? point.visibility : 0,
      ...(point.presence != null ? { presence: Number.isFinite(point.presence) ? point.presence : 0 } : {}),
    }]];
  }));
  return {
    side: live.side,
    torsoLeanDeg: live.torsoLeanDeg,
    shinLeanDeg: live.shinLeanDeg,
    hipAngleDeg: live.hipAngleDeg,
    hipDropLegLengths: live.hipDropRatio,
    hipToKneeLegLengths: live.hipToKneeRatio,
    hipSpeedLegLengthsPerSec: live.hipSpeedLegLengthsPerSec,
    ...(Number.isFinite(live.range) ? { range: live.range, rangeUnit: live.rangeUnit, movementSpeedPerSec: live.movementSpeedPerSec }
      : { thighToShinRatio: measureThighToShin(frame, live.side) }),
    joints,
  };
}

export function captureImage(source, width, height, canvas) {
  if (!source || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if ('readyState' in source && source.readyState < 2) return null;
  canvas ??= document.createElement('canvas');
  // Preserve a 720p source without enlarging smaller frames.
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const captureWidth = Math.max(1, Math.round(width * scale));
  const captureHeight = Math.max(1, Math.round(height * scale));
  if (canvas.width !== captureWidth) canvas.width = captureWidth;
  if (canvas.height !== captureHeight) canvas.height = captureHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  if (!url.startsWith('data:image/jpeg;base64,')) return null;
  return { url, width: canvas.width, height: canvas.height };
}

export function makeEvidence({ rep, images, motionTrace, captureStartMs, source, camera, capturedAt, reference, variant = 'bodyweight', trainingGuide = false }) {
  const exercise = rep.exercise ?? 'squat';
  const info = exerciseInfo(exercise);
  const movementStartOffsetMs = Math.round(rep.startedAtMs - captureStartMs);
  const returnOffsetMs = Math.round(rep.returnedAtMs - captureStartMs);
  const metrics = { ...rep.metrics };
  if (exercise === 'squat') Object.assign(metrics, {
    kneeExcursionDeg: rep.metrics.startKneeAngleDeg - rep.metrics.kneeAngleAtBottomDeg,
    returnAngleErrorDeg: Math.abs(rep.metrics.startKneeAngleDeg - rep.metrics.finishKneeAngleDeg),
    thighToShinRatio: summarizeThighToShin(motionTrace?.frames ?? [], movementStartOffsetMs, returnOffsetMs, rep.metrics.standingThighToShinRatio),
  });
  const snapshots = Object.keys(PHASE_LABELS).flatMap((phase) => {
    const frame = images.get(phase);
    if (!frame) return [];
    return [{ phase, ...frame, offsetMs: Math.round(frame.timestampMs - captureStartMs) }];
  });
  return {
    schemaVersion: 1,
    id: globalThis.crypto.randomUUID(),
    exercise, variant, captureMode: 'single-rep',
    source, capturedAt, camera, trackingSide: rep.side,
    ...(source === 'video' ? { videoStartOffsetMs: Math.round(captureStartMs) } : {}),
    movementStartOffsetMs,
    reference: reference ?? null,
    ...(trainingGuide ? { trainingGuide: true } : {}),
    metrics,
    cue: exercise !== 'squat' ? { code: 'OBSERVED_CYCLE', text: `The camera tracked one ${info.title.toLowerCase()} from the side.` } : reference?.establishedByThisRep
      ? { code: 'BASELINE_CAPTURED', text: 'This first squat is your baseline. Download it if you want to keep it for later.' }
      : { code: 'OBSERVED_CYCLE', text: 'The camera tracked a complete squat. You can compare the range with your first rep.' },
    observations: rep.cues,
    practiceGuide: exercise === 'squat' ? {
      descentTargetMs: 2000, ascentTargetMs: 1000, guidance: FORM_GUIDE,
      depthTarget: 'comfortable personal reference', torsoAngleTarget: null,
      proportionMethod: 'Projected ratios from source image pixels, without absolute height or distance calibration.',
      measurementLimits: 'Estimates from one side in 2D. Do not infer side-to-side knee alignment, spinal loading, overall safety, or balance.',
    } : { guidance: info.guidance, measurementLimits: 'Range and speed are estimated from the camera image.' },
    snapshots,
    ...(motionTrace ? { motionTrace } : {}),
  };
}

export function exportSnapshot({ url, timestampMs, ...snapshot }) {
  return { ...snapshot, mimeType: 'image/jpeg', imageBase64: url.slice(url.indexOf(',') + 1) };
}

export function downloadEvidence(evidence) {
  const payload = { ...evidence, snapshots: evidence.snapshots.map(exportSnapshot) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `compose-${evidence.exercise ?? 'squat'}-${evidence.id.slice(0, 8)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

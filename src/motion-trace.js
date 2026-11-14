import { measureThighToShin } from './leg-proportions.js';

const RECORD_INTERVAL_MS = 45;
const MAX_TRACE_FRAMES = 400;
const LEAD_IN_MS = 400;
export const PLAYBACK_GAP_MS = 200;

const JOINT_INDEX = {
  nose: 0, shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31,
};

export function traceJoints(landmarks, side) {
  const offset = side === 'right' ? 1 : 0;
  return Object.fromEntries(Object.entries(JOINT_INDEX).flatMap(([name, index]) => {
    const point = landmarks?.[index === 0 ? index : index + offset];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
    return [[name, {
      x: +point.x.toFixed(4),
      y: +point.y.toFixed(4),
      visibility: Number.isFinite(point.visibility) ? +point.visibility.toFixed(3) : null,
    }]];
  }));
}

export function recordPose(trace, frame, live, force = false) {
  if (!live || !frame.landmarks) return;
  const last = trace.at(-1);
  if (last && (frame.timestampMs <= last.timestampMs || (!force && frame.timestampMs - last.timestampMs < RECORD_INTERVAL_MS))) return;
  const joints = traceJoints(frame.landmarks, live.side);
  if (!joints.hip || !joints.knee || !joints.ankle) return;
  if (live.torsoLeanDeg === null) delete joints.shoulder;
  // The countdown sample anchors the export. The rest is bounded by the rep timeout.
  if (trace.length >= MAX_TRACE_FRAMES) trace.splice(1, 1);
  trace.push({ timestampMs: frame.timestampMs, joints, thighToShinRatio: measureThighToShin(frame, live.side) });
}

export function makeMotionTrace(trace, captureStartMs, movementStartMs) {
  if (trace.length < 2) return undefined;
  return {
    frames: trace.filter((frame, index) => index === 0 || frame.timestampMs >= movementStartMs - LEAD_IN_MS)
      .map(({ timestampMs, ...sample }) => ({ ...sample, offsetMs: Math.round(timestampMs - captureStartMs) })),
  };
}

export function poseAtTime(frames, time) {
  if (!frames?.length) return null;
  const nextIndex = frames.findIndex((frame) => frame.offsetMs >= time);
  if (nextIndex < 0) return frames.at(-1).joints;
  const next = frames[nextIndex];
  if (nextIndex === 0 || next.offsetMs === time) return next.joints;
  const previous = frames[nextIndex - 1];
  const gap = next.offsetMs - previous.offsetMs;
  if (gap > PLAYBACK_GAP_MS) {
    if (time - previous.offsetMs < 75) return previous.joints;
    if (next.offsetMs - time < 75) return next.joints;
    return null;
  }
  const fraction = (time - previous.offsetMs) / gap;
  return Object.fromEntries(Object.entries(previous.joints).flatMap(([name, point]) => {
    const target = next.joints[name];
    if (!target) return [];
    return [[name, {
      x: point.x + (target.x - point.x) * fraction,
      y: point.y + (target.y - point.y) * fraction,
      visibility: Math.min(point.visibility ?? 1, target.visibility ?? 1),
    }]];
  }));
}

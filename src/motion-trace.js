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
      visibility: point.visibility == null ? null : Number.isFinite(point.visibility) ? +point.visibility.toFixed(3) : 0,
      ...(point.presence != null ? { presence: Number.isFinite(point.presence) ? +point.presence.toFixed(3) : 0 } : {}),
    }]];
  }));
}

export function traceLandmarks(joints, side) {
  if (!joints) return null;
  const offset = side === 'right' ? 1 : 0;
  const landmarks = [];
  for (const [name, index] of Object.entries(JOINT_INDEX)) {
    if (joints[name]) landmarks[index === 0 ? index : index + offset] = joints[name];
  }
  return landmarks;
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

const coreJoints = new Set(['hip', 'knee', 'ankle', 'shoulder']);

export function isPlaybackJointVisible(name, point) {
  const cutoff = coreJoints.has(name) ? 0.35 : 0.55;
  return point && [point.visibility ?? 1, point.presence ?? 1].every((value) => Number.isFinite(value) && value >= cutoff)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

// A monotone Hermite segment matches the recorded endpoints but eases through
// changes of direction. Its tangents only use neighboring measured poses.
function blendSlope(before, after, beforeMs, afterMs) {
  if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) return 0;
  const beforeWeight = 2 * afterMs + beforeMs;
  const afterWeight = afterMs + 2 * beforeMs;
  return (beforeWeight + afterWeight) / (beforeWeight / before + afterWeight / after);
}

function smoothCoordinate(from, to, before, after, beforeMs, intervalMs, afterMs, fraction) {
  const slope = (to - from) / intervalMs;
  const entry = before === undefined ? slope
    : blendSlope((from - before) / beforeMs, slope, beforeMs, intervalMs);
  const exit = after === undefined ? slope
    : blendSlope(slope, (after - to) / afterMs, intervalMs, afterMs);
  const delta = to - from;
  const value = from + fraction * (entry * intervalMs + fraction * (
    3 * delta - (2 * entry + exit) * intervalMs + fraction * ((entry + exit) * intervalMs - 2 * delta)
  ));
  return Math.min(Math.max(from, to), Math.max(Math.min(from, to), value));
}

function nextFrameIndex(frames, time) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].offsetMs < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function poseAtTime(frames, time) {
  if (!frames?.length) return null;
  const nextIndex = nextFrameIndex(frames, time);
  if (nextIndex >= frames.length) return frames.at(-1).joints;
  const next = frames[nextIndex];
  if (nextIndex === 0 || next.offsetMs === time) return next.joints;
  const previous = frames[nextIndex - 1];
  const gap = next.offsetMs - previous.offsetMs;
  if (gap > PLAYBACK_GAP_MS) {
    if (time - previous.offsetMs < 75) return previous.joints;
    if (next.offsetMs - time < 75) return next.joints;
    return null;
  }
  const before = frames[nextIndex - 2];
  const after = frames[nextIndex + 1];
  const beforeMs = previous.offsetMs - before?.offsetMs;
  const afterMs = after?.offsetMs - next.offsetMs;
  const fraction = (time - previous.offsetMs) / gap;
  const joints = {};
  for (const [name, point] of Object.entries(previous.joints)) {
    const target = next.joints[name];
    if (!isPlaybackJointVisible(name, point) || !isPlaybackJointVisible(name, target)) continue;
    const beforePoint = beforeMs > 0 && beforeMs <= PLAYBACK_GAP_MS ? before.joints[name] : null;
    const afterPoint = afterMs > 0 && afterMs <= PLAYBACK_GAP_MS ? after.joints[name] : null;
    const prior = isPlaybackJointVisible(name, beforePoint) ? beforePoint : null;
    const following = isPlaybackJointVisible(name, afterPoint) ? afterPoint : null;
    joints[name] = {
      x: smoothCoordinate(point.x, target.x, prior?.x, following?.x, beforeMs, gap, afterMs, fraction),
      y: smoothCoordinate(point.y, target.y, prior?.y, following?.y, beforeMs, gap, afterMs, fraction),
      visibility: Math.min(point.visibility ?? 1, target.visibility ?? 1),
      ...(point.presence != null || target.presence != null
        ? { presence: Math.min(point.presence ?? 1, target.presence ?? 1) } : {}),
    };
  }
  return Object.keys(joints).length ? joints : null;
}

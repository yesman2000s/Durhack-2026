export const SET_IDLE_MS = 12_000;
export const SET_START_TIMEOUT_MS = 45_000;
export const PREVIOUS_REP_LIMIT = 5;

function compactFeedback(feedback) {
  if (!feedback || typeof feedback !== 'object') return undefined;
  return {
    score: Number.isInteger(feedback.score) ? feedback.score : null,
    ...(typeof feedback.summary === 'string' ? { summary: feedback.summary.slice(0, 180) } : {}),
    tips: Array.isArray(feedback.tips)
      ? feedback.tips.filter((tip) => typeof tip === 'string').slice(0, 3).map((tip) => tip.slice(0, 120)) : [],
  };
}

function compactRep(rep, repNumber) {
  return {
    id: rep.id,
    repNumber,
    exercise: rep.exercise,
    variant: rep.variant,
    source: rep.source,
    metrics: Object.fromEntries(Object.entries(rep.metrics ?? {}).filter(([key, value]) =>
      Number.isFinite(value) || (key === 'rangeUnit' && typeof value === 'string' && value.length <= 40))),
    ...(compactFeedback(rep.feedback) ? { feedback: compactFeedback(rep.feedback) } : {}),
  };
}

// Source timestamps also work for offline video. The caller supplies a clock
// observation during webcam stalls; this helper never creates a timer itself.
export function createCaptureSession(mode, { id = globalThis.crypto.randomUUID() } = {}) {
  if (!['single-rep', 'set'].includes(mode)) throw new RangeError(`Unknown capture mode: ${mode}`);
  let active = true;
  let reason = null;
  let startedAtMs = null;
  let endedAtMs = null;
  let lastTimestampMs = null;
  let lastActivityMs = null;
  const reps = [];
  const byId = new Map();

  function timestamp(value) {
    if (!Number.isFinite(value) || (lastTimestampMs !== null && value < lastTimestampMs)) return false;
    startedAtMs ??= value;
    lastActivityMs ??= value;
    lastTimestampMs = value;
    return true;
  }

  function snapshot() {
    const timeoutMs = reps.length ? SET_IDLE_MS : SET_START_TIMEOUT_MS;
    const idleMs = lastTimestampMs === null ? 0 : Math.max(0, lastTimestampMs - lastActivityMs);
    return {
      id, mode, active, reason, startedAtMs, endedAtMs, lastTimestampMs,
      repCount: reps.length, reps: structuredClone(reps), idleMs,
      remainingMs: active ? Math.max(0, timeoutMs - idleMs) : 0,
    };
  }

  function end(endReason = 'manual', time = lastTimestampMs) {
    if (!active) return snapshot();
    if (Number.isFinite(time)) timestamp(time);
    active = false;
    reason = endReason;
    endedAtMs = lastTimestampMs;
    return snapshot();
  }

  return {
    id,
    mode,
    snapshot,
    end,
    observe({ timestampMs, moving = false, hasPose = false, discarded = false }) {
      if (!active || !timestamp(timestampMs)) return snapshot();
      // A stale movement phase during missing camera data is not new activity.
      // A discarded attempt gets a fresh grace period to recover its setup.
      if ((moving && hasPose) || discarded) lastActivityMs = timestampMs;
      const timeoutMs = reps.length ? SET_IDLE_MS : SET_START_TIMEOUT_MS;
      if (timestampMs - lastActivityMs >= timeoutMs) return end(reps.length ? 'inactivity' : 'no-reps', timestampMs);
      return snapshot();
    },
    addRep(rep, timestampMs = lastTimestampMs) {
      if (!active || !rep?.id || byId.has(rep.id) || !timestamp(timestampMs)) return snapshot();
      const summary = compactRep(rep, reps.length + 1);
      reps.push(summary);
      byId.set(rep.id, summary);
      lastActivityMs = timestampMs;
      return snapshot();
    },
    updateFeedback(repId, feedback) {
      const summary = byId.get(repId);
      const normalized = compactFeedback(feedback);
      if (summary && normalized) summary.feedback = normalized;
      return snapshot();
    },
    contextForNextRep() {
      return { id, mode, repNumber: reps.length + 1, previousReps: structuredClone(reps.slice(-PREVIOUS_REP_LIMIT)) };
    },
  };
}

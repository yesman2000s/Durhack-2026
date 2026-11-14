const SIDES = {
  left: { shoulder: 11, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  right: { shoulder: 12, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 },
};
const PHASE_ORDER = ["start", "descent", "bottom", "ascent", "finish"];
const CALIBRATION_MS = 2000;
const MAX_FRAME_GAP_MS = 300;
const MAX_REP_MS = 20000;
const DEG_PER_RAD = 180 / Math.PI;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value, places = 0) => Number(value.toFixed(places));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function jointAngle(first, joint, last) {
  const a = { x: first.x - joint.x, y: first.y - joint.y };
  const b = { x: last.x - joint.x, y: last.y - joint.y };
  return Math.atan2(
    Math.abs(a.x * b.y - a.y * b.x),
    a.x * b.x + a.y * b.y,
  ) * DEG_PER_RAD;
}

function leanAngle(upper, lower) {
  return Math.atan2(Math.abs(upper.x - lower.x), lower.y - upper.y) * DEG_PER_RAD;
}

function pointAt(landmarks, index, width, height) {
  const point = landmarks?.[index];
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  return { x: point.x * width, y: point.y * height, visibility: point.visibility ?? 1 };
}

function readSide(landmarks, side, width, height) {
  const { shoulder, hip, knee, ankle, heel, toe } = SIDES[side];
  const joints = [shoulder, hip, knee, ankle, heel, toe].map(
    (index) => pointAt(landmarks, index, width, height),
  );
  const core = joints.slice(0, 4);
  const confidence = core.reduce((sum, point) => sum + (point?.visibility ?? 0), 0) / core.length;
  return {
    side,
    shoulder: joints[0],
    hip: joints[1],
    knee: joints[2],
    ankle: joints[3],
    heel: joints[4],
    toe: joints[5],
    confident: core.every((point) => point && point.visibility >= 0.55),
    confidence,
  };
}

function inspectPose(landmarks, width, height, fixedSide, baseline) {
  const left = readSide(landmarks, "left", width, height);
  const right = readSide(landmarks, "right", width, height);
  const selected = fixedSide === "left" ? left : fixedSide === "right" ? right :
    left.confident && (!right.confident || left.confidence >= right.confidence) ? left : right;
  if (!selected.confident) return { reason: landmarks?.length ? "joints" : "no-pose" };

  const { shoulder, hip, knee, ankle, heel, toe } = selected;
  const thighLength = distance(hip, knee);
  const shinLength = distance(knee, ankle);
  const torsoLength = distance(shoulder, hip);
  const legLength = thighLength + shinLength;
  if (Math.min(thighLength, shinLength, torsoLength) < height * 0.035) {
    return { reason: "joints" };
  }
  const nose = pointAt(landmarks, 0, width, height);
  if (!nose || nose.visibility < 0.45) return { reason: "head" };
  const feet = [heel, toe].filter((point) => point && point.visibility >= 0.5);
  if (!feet.length) return { reason: "feet" };
  const marginX = width * 0.025;
  const marginY = height * 0.025;
  const inFrame = [shoulder, hip, knee, ankle, nose, ...feet].every(
    (point) => point.x >= marginX && point.x <= width - marginX &&
      point.y >= marginY && point.y <= height - marginY,
  ) && nose.y > marginY + torsoLength * 0.16;
  if (!inFrame) return { reason: "edges" };

  const widths = [[left.shoulder, right.shoulder], [left.hip, right.hip]]
    .filter(([a, b]) => a && b && Math.min(a.visibility, b.visibility) >= 0.30)
    .map(([a, b]) => Math.abs(a.x - b.x) / legLength);
  const headInProfile = Math.abs(nose.x - shoulder.x) / legLength >= 0.09;
  const sideOn = widths.length ? Math.max(...widths) <= (baseline ? 0.22 : 0.18) : headInProfile;
  const standingHeight = Math.max(ankle.y, ...feet.map((point) => point.y)) - nose.y;
  const shiftedFoot = baseline && Math.abs(ankle.x - baseline.ankleX) / baseline.legLength > 0.15;
  return {
    sample: {
      side: selected.side,
      kneeAngle: jointAngle(hip, knee, ankle),
      hipAngle: jointAngle(shoulder, hip, knee),
      torsoLean: leanAngle(shoulder, hip),
      shinLean: leanAngle(knee, ankle),
      hipY: hip.y,
      kneeY: knee.y,
      ankleX: ankle.x,
      legLength,
      thighLength,
      shinLength,
      torsoLength,
    },
    sideOn,
    shiftedFoot,
    tooFar: !baseline && standingHeight < height * 0.38 && legLength < height * 0.24,
  };
}

function makeBaseline(samples) {
  const keys = ["hipY", "ankleX", "legLength", "kneeAngle", "thighLength", "shinLength", "torsoLength"];
  const baseline = { side: samples[0].side };
  for (const key of keys) {
    baseline[key] = samples.reduce((sum, pose) => sum + pose[key], 0) / samples.length;
  }
  baseline.proportions = {
    standingThighToShinRatio: round(baseline.thighLength / baseline.shinLength, 3),
    standingTorsoToLegRatio: round(baseline.torsoLength / baseline.legLength, 3),
  };
  return baseline;
}

function capture(rep, phase, sample, events) {
  const frame = { phase, timestampMs: sample.time };
  rep.frames[phase] = frame;
  events.push({ type: "capture", repId: rep.id, ...frame });
}

function isDeeper(sample, previous, baseline) {
  const hipChange = (sample.hipY - previous.hipY) / baseline.legLength;
  const kneeChange = previous.kneeAngle - sample.kneeAngle;
  return hipChange > 0.007 || (hipChange >= -0.007 && kneeChange > 2);
}

function formatRep(rep, finish, baseline) {
  const bottom = rep.bottom;
  const start = rep.start;
  const rise = rep.lastAtBottom ?? bottom;
  const end = rep.firstStanding;
  const descentMs = bottom.time - start.time;
  const ascentMs = end.time - rise.time;
  const drop = (bottom.hipY - start.hipY) / baseline.legLength;
  const riseDistance = (bottom.hipY - end.hipY) / baseline.legLength;
  const hipToKnee = (bottom.hipY - bottom.kneeY) / baseline.legLength;
  const depthText = hipToKnee < -0.045 ? "above" : hipToKnee > 0.045 ? "below" : "about level with";
  const metrics = {
    durationMs: round(end.time - start.time),
    descentMs: round(descentMs),
    pauseMs: round(rise.time - bottom.time),
    ascentMs: round(ascentMs),
    kneeAngleAtBottomDeg: round(bottom.kneeAngle, 1),
    hipAngleAtBottomDeg: round(bottom.hipAngle, 1),
    startKneeAngleDeg: round(start.kneeAngle, 1),
    finishKneeAngleDeg: round(finish.kneeAngle, 1),
    hipDropLegLengths: round(drop, 3),
    bottomHipToKneeLegLengths: round(hipToKnee, 3),
    torsoLeanAtBottomDeg: round(bottom.torsoLean, 1),
    shinLeanAtBottomDeg: round(bottom.shinLean, 1),
    averageDescentLegLengthsPerSec: round(Math.max(0, drop) * 1000 / Math.max(1, descentMs), 3),
    averageAscentLegLengthsPerSec: round(Math.max(0, riseDistance) * 1000 / Math.max(1, ascentMs), 3),
    peakDescentLegLengthsPerSec: round(rep.peakDown, 3),
    peakAscentLegLengthsPerSec: round(rep.peakUp, 3),
    validFrameFraction: round(rep.validFrames / rep.totalFrames, 3),
    maxTrackingGapMs: round(rep.maxGap),
    ...baseline.proportions,
  };
  return {
    id: rep.id,
    side: baseline.side,
    startedAtMs: start.time,
    returnedAtMs: end.time,
    finishedAtMs: finish.time,
    metrics,
    cues: [
      { kind: "observation", code: "depth", message: `At the bottom, your visible hip was ${depthText} your knee.` },
      { kind: "observation", code: "torso", message: `Your torso leaned about ${round(bottom.torsoLean)}° from vertical at the bottom.` },
    ],
    frames: PHASE_ORDER.flatMap((phase) => rep.frames[phase] ? [rep.frames[phase]] : []),
  };
}

export class SquatTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = "setup";
    this.calibration = [];
    this.baseline = null;
    this.previous = null;
    this.lastTime = null;
    this.lastValidTime = null;
    this.lastStanding = null;
    this.attempt = null;
    this.onsetAt = null;
    this.nextRepId = 1;
  }

  update({ landmarks, timestampMs, width, height, armed = true }) {
    const events = [];
    const checks = { inFrame: false, sideOn: false, standing: false, steady: false };
    const state = (message, live = null, progress = 0, ready = false) => ({
      phase: this.phase,
      setup: { checks, ready, message, progress },
      live,
      events,
    });
    if (!Number.isFinite(timestampMs) || timestampMs <= (this.lastTime ?? -Infinity) ||
        !(width > 0) || !(height > 0)) {
      return state("Waiting for the next camera frame.");
    }

    this.lastTime = timestampMs;
    if (!armed) {
      if (this.attempt) this.discard(events, "cancelled");
      this.onsetAt = null;
    }
    if (this.baseline && this.lastValidTime !== null && timestampMs - this.lastValidTime > MAX_FRAME_GAP_MS) {
      this.loseCalibration(events, "tracking-gap");
    }
    if (this.attempt && timestampMs - this.attempt.start.time > MAX_REP_MS) {
      this.loseCalibration(events, "timeout");
    }

    const fixedSide = this.baseline?.side ?? this.calibration[0]?.side;
    const pose = inspectPose(landmarks, width, height, fixedSide, this.baseline);
    checks.inFrame = Boolean(pose.sample) && !pose.tooFar;
    checks.sideOn = checks.inFrame && pose.sideOn;
    if (!checks.sideOn || pose.shiftedFoot) {
      this.previous = null;
      this.onsetAt = null;
      this.calibration = [];
      if (this.attempt) {
        this.attempt.totalFrames++;
        this.attempt.maxGap = Math.max(this.attempt.maxGap, timestampMs - this.lastValidTime);
        this.attempt.riseAt = null;
        this.attempt.risePeak = 0;
        this.attempt.firstStanding = null;
        if (!this.attempt.depthConfirmed) this.attempt.depthReachedAt = null;
        if (pose.shiftedFoot) this.loseCalibration(events, "foot-moved");
      } else {
        this.lastStanding = null;
        if (pose.shiftedFoot) this.loseCalibration(events, "foot-moved");
      }
      const messages = {
        "no-pose": "Step into view so the camera can see you.",
        joints: "Keep your near shoulder, hip, knee and ankle visible.",
        head: "Keep your head in frame and look straight ahead.",
        feet: "Show your whole feet, including your heels.",
        edges: "Leave a little space around your head and feet.",
      };
      let message = messages[pose.reason] ?? "Turn sideways so the camera sees your profile.";
      if (pose.tooFar) message = "Move a little closer while keeping your head and feet in frame.";
      if (pose.shiftedFoot) message = "Stand still to set your new position.";
      return state(message);
    }

    const sample = { ...pose.sample, time: timestampMs, speed: 0 };
    if (this.attempt) {
      this.attempt.maxGap = Math.max(this.attempt.maxGap, timestampMs - this.lastValidTime);
    }
    this.lastValidTime = timestampMs;
    const previous = this.previous;
    if (previous && sample.side === previous.side && timestampMs - previous.time <= MAX_FRAME_GAP_MS) {
      const interval = timestampMs - previous.time;
      const blend = 1 - Math.exp(-interval / 48);
      for (const key of ["hipY", "kneeY", "kneeAngle", "hipAngle", "torsoLean", "shinLean"]) {
        sample[key] = previous[key] + (sample[key] - previous[key]) * blend;
      }
      if (this.baseline) {
        const speed = (sample.hipY - previous.hipY) * 1000 / (interval * this.baseline.legLength);
        sample.speed = previous.speed + (clamp(speed, -4, 4) - previous.speed) * blend;
      }
    }
    this.previous = sample;

    checks.standing = sample.kneeAngle >= (this.baseline?.kneeAngle ?? 168) - 15 &&
      (!this.baseline || (sample.hipY - this.baseline.hipY) / this.baseline.legLength <= 0.09);
    if (!this.baseline) {
      checks.steady = checks.standing && this.calibrate(sample);
      if (!checks.standing) this.calibration = [];
      const first = this.calibration[0]?.time ?? timestampMs;
      const progress = clamp((timestampMs - first) / CALIBRATION_MS, 0, 1);
      if (progress === 1 && this.calibration.length >= 8) {
        this.baseline = makeBaseline(this.calibration);
        this.calibration = [];
        this.phase = "ready";
      } else {
        return state(checks.standing ? "Hold a comfortable standing position." : "Stand tall to calibrate.", null, progress);
      }
    }

    const baseline = this.baseline;
    const live = {
      side: sample.side,
      kneeAngleDeg: round(sample.kneeAngle, 1),
      hipAngleDeg: round(sample.hipAngle, 1),
      standingKneeAngleDeg: round(baseline.kneeAngle, 1),
      hipDropRatio: round((sample.hipY - baseline.hipY) / baseline.legLength, 3),
      hipToKneeRatio: round((sample.hipY - sample.kneeY) / baseline.legLength, 3),
      torsoLeanDeg: round(sample.torsoLean, 1),
      shinLeanDeg: round(sample.shinLean, 1),
      hipSpeedLegLengthsPerSec: round(sample.speed, 3),
      ...baseline.proportions,
    };
    const returnedToStanding = checks.standing;
    const startPose = returnedToStanding && baseline.kneeAngle - sample.kneeAngle <= 8 && live.hipDropRatio < 0.045;
    checks.steady = startPose && Math.abs(sample.speed) < 0.15;
    if (armed) this.trackRep(sample, live, returnedToStanding, startPose, events);
    else this.lastStanding = startPose ? sample : null;
    if (this.phase === "ready") checks.standing = startPose;
    const messages = {
      setup: "Stand tall to recalibrate.",
      ready: checks.standing ? "Side view ready." : "Stand tall before starting the next rep.",
      descending: "Lower through your comfortable range.",
      bottom: "Rise when you’re ready.",
      ascending: "Return to your standing position.",
    };
    return state(messages[this.phase], live, this.baseline ? 1 : 0,
      this.phase === "ready" && checks.steady);
  }

  calibrate(sample) {
    const first = this.calibration[0];
    const latest = this.calibration.at(-1);
    if (first && (sample.side !== first.side || sample.time - latest.time > MAX_FRAME_GAP_MS ||
        Math.abs(sample.hipY - first.hipY) > first.legLength * 0.035 ||
        Math.abs(sample.ankleX - first.ankleX) > first.legLength * 0.045 ||
        Math.abs(sample.kneeAngle - first.kneeAngle) > 7)) {
      this.calibration = [];
    }
    this.calibration.push(sample);
    return this.calibration.length > 1;
  }

  trackRep(sample, live, standing, startPose, events) {
    const kneeBend = this.baseline.kneeAngle - sample.kneeAngle;
    if (!this.attempt) {
      if (startPose) {
        this.lastStanding = sample;
        this.onsetAt = null;
      } else if (this.lastStanding && kneeBend >= 9 && live.hipDropRatio >= 0.026) {
        this.onsetAt ??= sample.time;
        if (sample.time - this.onsetAt >= 85) this.startRep(sample, events);
      } else {
        this.onsetAt = null;
      }
      return;
    }

    const rep = this.attempt;
    rep.totalFrames++;
    rep.validFrames++;
    if (this.phase === "descending" || this.phase === "bottom") {
      rep.peakDown = Math.max(rep.peakDown, sample.speed);
      if (!rep.depthConfirmed && (kneeBend < 20 || live.hipDropRatio < 0.055)) rep.depthReachedAt = null;
      if (kneeBend >= 24 && live.hipDropRatio >= 0.07) rep.depthReachedAt ??= sample.time;
      if (rep.depthReachedAt !== null && !rep.frames.descent) capture(rep, "descent", sample, events);
      if (rep.depthReachedAt !== null && sample.time - rep.depthReachedAt >= 145) rep.depthConfirmed = true;
      // Keep depth candidates while the tracker confirms sustained movement.
      if (rep.depthReachedAt !== null && sample.time > rep.frames.descent.timestampMs && !standing) {
        if (!rep.bottom || isDeeper(sample, rep.bottom, this.baseline)) {
          rep.bottom = sample;
          rep.lastAtBottom = sample;
          capture(rep, "bottom", sample, events);
        }
      }
      if (!rep.depthConfirmed && standing && sample.time - rep.onsetAt > 250) {
        this.discard(events, "incomplete-descent");
        return;
      }
      if (!rep.depthConfirmed || !rep.bottom) return;
      if (this.phase === "descending" && (Math.abs(sample.speed) < 0.09 || sample.speed < 0 ||
          sample.time - rep.bottom.time > 100)) {
        this.phase = "bottom";
      }
      const riseHip = (rep.bottom.hipY - sample.hipY) / this.baseline.legLength;
      const riseKnee = sample.kneeAngle - rep.bottom.kneeAngle;
      if (riseHip <= 0.012 && Math.abs(riseKnee) < 5) rep.lastAtBottom = sample;
      if (riseHip >= 0.018 && riseKnee >= 8) {
        rep.riseAt ??= sample.time;
        rep.risePeak = Math.max(rep.risePeak, -sample.speed);
        if (sample.time - rep.riseAt >= 180) {
          this.phase = "ascending";
          rep.peakUp = rep.risePeak;
        }
      } else {
        rep.riseAt = null;
        rep.risePeak = 0;
      }
    }

    if (this.phase !== "ascending") return;
    rep.peakUp = Math.max(rep.peakUp, -sample.speed);
    const rise = rep.bottom.hipY - sample.hipY;
    if (!rep.frames.ascent && rise >= (rep.bottom.hipY - rep.start.hipY) * 0.38) {
      capture(rep, "ascent", sample, events);
    }
    if (rise / this.baseline.legLength < -0.045) {
      this.discard(events, "second-descent");
      return;
    }
    if (!standing) {
      rep.firstStanding = null;
      return;
    }
    rep.firstStanding ??= sample;
    if (sample.time - rep.firstStanding.time < 500) return;
    if (rep.validFrames / rep.totalFrames < 0.9) {
      this.discard(events, "low-confidence");
      return;
    }
    if (!rep.frames.ascent) {
      this.discard(events, "incomplete-ascent");
      return;
    }
    capture(rep, "finish", sample, events);
    events.push({ type: "rep-complete", rep: formatRep(rep, sample, this.baseline) });
    this.attempt = null;
    this.phase = "ready";
    this.lastStanding = sample;
    this.onsetAt = null;
  }

  startRep(sample, events) {
    const rep = {
      id: this.nextRepId++,
      start: this.lastStanding,
      onsetAt: this.onsetAt,
      depthReachedAt: null,
      depthConfirmed: false,
      bottom: null,
      lastAtBottom: null,
      riseAt: null,
      risePeak: 0,
      firstStanding: null,
      validFrames: 1,
      totalFrames: 1,
      maxGap: 0,
      peakDown: Math.max(0, sample.speed),
      peakUp: 0,
      frames: {},
    };
    this.phase = "descending";
    this.attempt = rep;
    capture(rep, "start", sample, events);
  }

  discard(events, reason) {
    if (this.attempt) events.push({ type: "rep-discarded", repId: this.attempt.id, reason });
    this.attempt = null;
    this.phase = this.baseline ? "ready" : "setup";
    this.lastStanding = null;
    this.onsetAt = null;
  }

  loseCalibration(events, reason) {
    this.baseline = null;
    this.previous = null;
    this.lastValidTime = null;
    this.calibration = [];
    this.discard(events, reason);
  }
}

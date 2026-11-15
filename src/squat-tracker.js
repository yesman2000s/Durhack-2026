const SIDES = {
  left: { shoulder: 11, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  right: { shoulder: 12, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 },
};
const PHASE_ORDER = ["start", "descent", "bottom", "ascent", "finish"];
const CALIBRATION_MS = 1000;
const CALIBRATION_MIN_SAMPLES = 7;
const CALIBRATION_GAP_MS = 220;
const STANDING_REFERENCE_MS = 450;
const FINISH_HOLD_MS = 500;
const FINISH_GRACE_MS = 250;
const MAX_FRAME_GAP_MS = 300;
const MAX_CAPTURE_GAP_MS = 400;
const MAX_REACQUIRE_GAP_MS = 500;
const WEAK_CONTINUITY_MS = 250;
const TURN_CONFIRM_MS = 200;
const DESCENT_TURN_CONFIRM_MS = 320;
const MAX_REP_MS = 20000;
const DEG_PER_RAD = 180 / Math.PI;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value, places = 0) => Number(value.toFixed(places));
const roundIfMeasured = (value, places) => value === null ? null : round(value, places);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const hipHeight = (sample) => -sample.hipFromSupport / sample.legLength;

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

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
  // Visibility describes occlusion; presence separately describes whether the
  // model believes this joint exists. Both must support a measurement.
  const confidence = [point.visibility ?? 1, point.presence ?? 1];
  const visibility = confidence.every(Number.isFinite) ? clamp(Math.min(...confidence), 0, 1) : 0;
  return { x: point.x * width, y: point.y * height, visibility };
}

function readSide(landmarks, side, width, height) {
  const { shoulder, hip, knee, ankle, heel, toe } = SIDES[side];
  const joints = [shoulder, hip, knee, ankle, heel, toe].map(
    (index) => pointAt(landmarks, index, width, height),
  );
  const leg = joints.slice(1, 4);
  const confidence = leg.reduce((sum, point) => sum + (point?.visibility ?? 0), 0) / leg.length;
  return {
    side,
    shoulder: joints[0],
    hip: joints[1],
    knee: joints[2],
    ankle: joints[3],
    heel: joints[4],
    toe: joints[5],
    confident: leg.every((point) => point?.visibility >= 0.55),
    confidence,
  };
}

function inspectPose(landmarks, width, height, fixedSide, baseline, tracking) {
  const left = readSide(landmarks, "left", width, height);
  const right = readSide(landmarks, "right", width, height);
  const selected = fixedSide === "left" ? left : fixedSide === "right" ? right :
    left.confident && (!right.confident || left.confidence >= right.confidence) ? left : right;
  const legConfidence = [selected.hip, selected.knee, selected.ankle].map((point) => point?.visibility ?? 0);
  const weak = tracking && legConfidence.some((confidence) => confidence < 0.35) &&
    legConfidence.every((confidence) => confidence >= 0.25) &&
    legConfidence.filter((confidence) => confidence >= 0.55).length >= 2;
  const visibleChain = tracking ? weak || legConfidence.every((confidence) => confidence >= 0.35) : selected.confident;
  if (!visibleChain) return { reason: landmarks?.length ? "joints" : "no-pose" };

  const { hip, knee, ankle, heel, toe } = selected;
  const thighLength = distance(hip, knee);
  const shinLength = distance(knee, ankle);
  const legLength = thighLength + shinLength;
  const implausibleScale = tracking && [
    thighLength / baseline.thighLength,
    shinLength / baseline.shinLength,
  ].some((ratio) => ratio < (weak ? 0.7 : 0.5) || ratio > (weak ? 1.3 : 1.6));
  if (!tracking && Math.min(thighLength, shinLength) < height * 0.035) return { reason: "joints" };
  const marginX = tracking ? 0 : width * 0.025;
  const marginY = tracking ? 0 : height * 0.025;
  const isInFrame =
    (point) => point.x >= marginX && point.x <= width - marginX &&
      point.y >= marginY && point.y <= height - marginY;
  if (![hip, knee, ankle].every(isInFrame)) return { reason: "edges" };

  const spanConfidence = tracking ? 0.55 : 0.30;
  const span = (a, b) => a && b && Math.min(a.visibility, b.visibility) >= spanConfidence
    ? Math.abs(a.x - b.x) / (baseline?.legLength ?? legLength) : null;
  const shoulderSpan = span(left.shoulder, right.shoulder);
  const hipSpan = span(left.hip, right.hip);
  const kneeSpan = span(left.knee, right.knee);
  const narrowHips = hipSpan !== null && hipSpan <= 0.17;
  const canUseShoulder = (point, visibility) => {
    if (!(point?.visibility >= visibility) || !isInFrame(point)) return false;
    const length = distance(point, hip);
    return tracking ? length >= baseline.torsoLength * 0.5 && length <= baseline.torsoLength * 1.6
      : length >= height * 0.035 && length <= legLength * 1.25;
  };
  const nearShoulder = canUseShoulder(selected.shoulder, tracking ? 0.30 : 0.40)
    ? selected.shoulder : null;
  const other = selected.side === "left" ? right : left;
  const backupShoulder = !tracking && !nearShoulder && narrowHips && canUseShoulder(other.shoulder, 0.55)
    ? other.shoulder : null;
  const shoulder = nearShoulder ?? backupShoulder;
  const torsoLength = shoulder ? distance(shoulder, hip) : null;

  let sideOn;
  let tooFar = false;
  if (tracking) {
    sideOn = !(hipSpan > 0.39 || (hipSpan > 0.29 && (shoulderSpan > 0.38 || kneeSpan > 0.32)));
    if (implausibleScale && sideOn) {
      return { reason: legConfidence.every((confidence) => confidence >= 0.55) ? "shape" : "joints" };
    }
  } else {
    const nose = pointAt(landmarks, 0, width, height);
    const feet = [heel, toe].filter((point) => point?.visibility >= 0.5);
    if (!(nose?.visibility >= 0.45)) return { reason: "head" };
    // The heel and toe can overlap from the side. A clear ankle with room for
    // the foot under it still establishes that the leg fits in the image.
    if (!feet.length && !(ankle.visibility >= 0.65 && height - marginY - ankle.y >= legLength * 0.12)) {
      return { reason: "feet" };
    }
    if (!shoulder) return { reason: "shoulder" };
    if (![nose, ...feet].every(isInFrame) || nose.y <= marginY + torsoLength * 0.16) return { reason: "edges" };
    if (shoulderSpan !== null && hipSpan !== null) {
      sideOn = (shoulderSpan <= 0.35 && hipSpan <= 0.26) || (narrowHips && shoulderSpan <= 0.60) ||
        (shoulderSpan <= 0.39 && hipSpan <= 0.285 && kneeSpan !== null && kneeSpan <= 0.22);
    } else {
      const availableSpan = hipSpan ?? shoulderSpan;
      sideOn = availableSpan !== null ? availableSpan <= 0.20 : Math.abs(nose.x - shoulder.x) / legLength >= 0.09;
    }
    tooFar = !baseline && Math.max(ankle.y, ...feet.map((point) => point.y)) - nose.y < height * 0.38 &&
      legLength < height * 0.24;
  }
  return {
    sample: {
      side: selected.side,
      kneeAngle: jointAngle(hip, knee, ankle),
      hipAngle: nearShoulder ? jointAngle(nearShoulder, hip, knee) : null,
      torsoLean: nearShoulder ? leanAngle(nearShoulder, hip) : null,
      shinLean: leanAngle(knee, ankle),
      hipY: hip.y,
      kneeY: knee.y,
      ankleY: ankle.y,
      otherAnkleY: other.ankle?.visibility >= 0.55 && isInFrame(other.ankle) ? other.ankle.y : null,
      legLength,
      thighLength,
      shinLength,
      torsoLength,
    },
    sideOn,
    tooFar,
    weak,
    implausibleScale,
    turnCorroborated: shoulderSpan > 0.38 && hipSpan > 0.29 && kneeSpan > 0.32,
  };
}

function makeBaseline(samples) {
  const keys = ["legLength", "thighLength", "shinLength", "torsoLength"];
  const baseline = { side: samples[0].side, ...standingReference(samples) };
  for (const key of keys) {
    baseline[key] = samples.reduce((sum, pose) => sum + pose[key], 0) / samples.length;
  }
  baseline.proportions = {
    standingThighToShinRatio: round(baseline.thighLength / baseline.shinLength, 3),
    standingTorsoToLegRatio: round(baseline.torsoLength / baseline.legLength, 3),
  };
  return baseline;
}

function standingReference(samples) {
  const reference = {};
  for (const key of ["kneeAngle", "hipY", "supportY", "supportOtherY", "hipFromSupport"]) {
    const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
    reference[key] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }
  return reference;
}

function hipDropFrom(sample, reference, legLength) {
  return (sample.hipFromSupport - reference.hipFromSupport) / legLength;
}

function supportHeight(sample, reference, legLength) {
  if (!reference) return sample.ankleY;
  const nearShift = (sample.ankleY - reference.supportY) / legLength;
  const otherShift = reference.supportOtherY != null && sample.otherAnkleY !== null
    ? (sample.otherAnkleY - reference.supportOtherY) / legLength : null;
  // If one foot lifts or jumps in the pose estimate, the closer foot to
  // standing height is the better support. Coherent motion of both feet is
  // retained so translating the whole pose does not change the measured drop.
  const separateFeet = otherShift !== null &&
    Math.abs(nearShift - otherShift) > (nearShift < otherShift ? 0.02 : 0.10);
  const shift = separateFeet && Math.abs(otherShift) < Math.abs(nearShift) ? otherShift : nearShift;
  const hipShift = (sample.hipY - reference.hipY) / legLength;
  const shortenedUprightLeg = shift < -0.15 && hipShift < 0.12 &&
    sample.kneeAngle >= reference.kneeAngle - 10 && sample.legLength < legLength * 0.95;
  const raisedOnlyVisibleFoot = otherShift === null && shift < -0.02 && Math.abs(hipShift) < 0.08;
  const lowAnkleEstimate = otherShift === null && shift > 0.15 && shift < 0.29 &&
    hipShift > Math.max(0.12, shift * 1.15);
  return shortenedUprightLeg || raisedOnlyVisibleFoot || lowAnkleEstimate
    ? reference.supportY : reference.supportY + shift * legLength;
}

function capture(rep, phase, sample, events) {
  const frame = { phase, timestampMs: sample.time };
  rep.frames[phase] = frame;
  events.push({ type: "capture", repId: rep.id, ...frame });
}

function motionCandidate(rep, sample, events) {
  rep.samples.push(sample);
  events.push({
    type: "capture-candidate", repId: rep.id, timestampMs: sample.time,
    kneeAngleDeg: round(sample.kneeAngle, 1),
  });
}

function closestMiddle(samples, fromTime, toTime, target, depth, ascending = false) {
  let best = null;
  let error = Infinity;
  for (const sample of samples) {
    const progress = ascending ? 1 - sample.drop / depth : sample.drop / depth;
    if (sample.time < fromTime || sample.time >= toTime || progress < 0.12 || progress > 0.92) continue;
    const distance = Math.abs(sample.drop - target);
    if (distance + 1e-9 < error) {
      best = sample;
      error = distance;
    }
  }
  return best;
}

function finalizeCaptures(rep, finish, events) {
  const bottom = rep.bottom;
  const descent = closestMiddle(rep.samples, rep.frames.start.timestampMs, bottom.time, bottom.drop * 0.5, bottom.drop);
  const ascent = closestMiddle(rep.samples, bottom.time + 0.001, rep.firstStanding.time, bottom.drop * 0.5, bottom.drop, true);
  if (descent) capture(rep, "descent", descent, events);
  capture(rep, "bottom", bottom, events);
  if (ascent) capture(rep, "ascent", ascent, events);
  capture(rep, "finish", finish, events);
}

function formatRep(rep, finish, baseline) {
  const bottom = rep.bottom;
  const start = rep.start;
  const rise = rep.lastAtBottom ?? bottom;
  const end = rep.firstStanding;
  const descentMs = bottom.time - start.time;
  const ascentMs = end.time - rise.time;
  const drop = hipDropFrom(bottom, start, baseline.legLength);
  const riseDistance = hipDropFrom(bottom, end, baseline.legLength);
  const hipToKnee = (bottom.hipY - bottom.kneeY) / baseline.legLength;
  const depthText = hipToKnee < -0.045 ? "above" : hipToKnee > 0.045 ? "below" : "about level with";
  const metrics = {
    durationMs: round(end.time - start.time),
    descentMs: round(descentMs),
    pauseMs: round(rise.time - bottom.time),
    ascentMs: round(ascentMs),
    kneeAngleAtBottomDeg: round(bottom.kneeAngle, 1),
    hipAngleAtBottomDeg: roundIfMeasured(bottom.hipAngle, 1),
    startKneeAngleDeg: round(start.kneeAngle, 1),
    finishKneeAngleDeg: round(finish.kneeAngle, 1),
    hipDropLegLengths: round(drop, 3),
    bottomHipToKneeLegLengths: round(hipToKnee, 3),
    torsoLeanAtBottomDeg: roundIfMeasured(bottom.torsoLean, 1),
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
      ...(bottom.torsoLean === null ? [] : [
        { kind: "observation", code: "torso", message: `Your torso leaned about ${round(bottom.torsoLean)}° from vertical at the bottom.` },
      ]),
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
    this.calibrationObservedMs = 0;
    this.calibrationInterrupted = false;
    this.baseline = null;
    this.previous = null;
    this.lastTime = null;
    this.lastValidTime = null;
    this.previousWasMissing = false;
    this.weakAt = null;
    this.standingSamples = [];
    this.lockedStanding = null;
    this.lockedStandingAt = null;
    this.lastStandingAt = null;
    this.standingObservedMs = 0;
    this.standingObservedAt = null;
    this.standingInterrupted = false;
    this.captureStandingReady = false;
    this.turnAt = null;
    this.attempt = null;
    this.onsetAt = null;
    this.nextRepId = 1;
    this.continuous = false;
  }

  update({ landmarks, timestampMs, width, height, armed = true, lockStanding = armed, continuous = false }) {
    const events = [];
    const checks = { inFrame: false, sideOn: false, standing: false, steady: false };
    const state = (message, live = null, progress = 0, ready = false, continuitySide = null) => ({
      phase: this.phase,
      setup: { checks, ready, message, progress },
      live,
      events,
      continuitySide,
    });
    if (!Number.isFinite(timestampMs) || timestampMs <= (this.lastTime ?? -Infinity) ||
        !Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) {
      return state("Waiting for the next camera frame.");
    }

    const previousFrameTime = this.lastTime;
    this.continuous = continuous === true;
    this.lastTime = timestampMs;
    if (!armed) {
      if (this.attempt) this.discard(events, "cancelled");
      this.onsetAt = null;
      this.captureStandingReady = false;
    } else if (this.standingObservedMs >= CALIBRATION_MS) {
      this.captureStandingReady = true;
    }
    const maxGap = this.attempt
      ? this.weakAt !== null ? MAX_REACQUIRE_GAP_MS : MAX_CAPTURE_GAP_MS
      : MAX_FRAME_GAP_MS;
    if (this.baseline && this.lastValidTime !== null && timestampMs - this.lastValidTime > maxGap) {
      this.loseCalibration(events, "tracking-gap");
    }
    if (this.attempt && timestampMs - this.attempt.start.time > MAX_REP_MS) {
      this.loseCalibration(events, "timeout");
    }

    if (!lockStanding) {
      this.lockedStanding = null;
      this.lockedStandingAt = null;
    }
    if (lockStanding && !this.lockedStanding && this.standingSamples.length) {
      this.lockReference(this.standingSamples, previousFrameTime ?? timestampMs);
    }
    const fixedSide = this.baseline?.side ?? this.calibration[0]?.side;
    const tracking = Boolean(armed && this.baseline);
    const reference = this.attempt?.start ?? this.lockedStanding ?? this.baseline;
    const pose = inspectPose(landmarks, width, height, fixedSide, this.baseline, tracking);
    if (pose.sample) {
      pose.sample.supportY = supportHeight(pose.sample, reference, this.baseline?.legLength);
      pose.sample.supportOtherY = reference?.supportOtherY != null
        ? reference.supportOtherY + (pose.sample.supportY - reference.supportY) : pose.sample.otherAnkleY;
      pose.sample.hipFromSupport = pose.sample.hipY - pose.sample.supportY;
    }
    checks.inFrame = Boolean(pose.sample) && !pose.tooFar;
    checks.sideOn = checks.inFrame && pose.sideOn;
    // Short or unclassified front-like readings aren't enough to prove a turn.
    const clearTurn = tracking && pose.sample && !pose.weak && !pose.sideOn;
    if (clearTurn) this.turnAt ??= timestampMs;
    else this.turnAt = null;
    const sinceStrong = timestampMs - this.lastValidTime;
    const previousRaw = this.previous?.raw;
    const descentTurn = clearTurn && this.phase === "descending" && previousRaw &&
      !pose.turnCorroborated && !pose.implausibleScale &&
      sinceStrong <= MAX_CAPTURE_GAP_MS &&
      hipDropFrom(pose.sample, previousRaw, this.baseline.legLength) >= 0.012 &&
      previousRaw.kneeAngle - pose.sample.kneeAngle >= 4;
    const turnLimit = descentTurn ? DESCENT_TURN_CONFIRM_MS : TURN_CONFIRM_MS;
    const sustainedTurn = clearTurn && timestampMs - this.turnAt >= turnLimit;
    const weakContinuity = pose.weak && this.attempt && checks.sideOn &&
      this.previous && sinceStrong <= WEAK_CONTINUITY_MS &&
      Math.abs(hipDropFrom(pose.sample, this.previous.raw, this.baseline.legLength)) <= 0.05 + 2.2 * sinceStrong / 1000 &&
      Math.abs(pose.sample.kneeAngle - this.previous.raw.kneeAngle) <= 12 + 350 * sinceStrong / 1000;
    const shapeContinuity = pose.reason === "shape" && this.attempt?.depthConfirmed && sinceStrong <= WEAK_CONTINUITY_MS;
    if (clearTurn) this.weakAt = null;
    else if (weakContinuity || shapeContinuity) this.weakAt = timestampMs;
    if (!checks.sideOn || pose.weak) {
      this.previousWasMissing = true;
      if (!this.baseline) this.previous = null;
      this.onsetAt = null;
      if (!this.baseline) {
        if (pose.turnCorroborated) this.clearCalibrationSamples();
        else this.interruptCalibration(timestampMs);
      }
      else if (!this.attempt) {
        const briefMiss = !pose.sample || pose.weak;
        if (briefMiss && this.standingObservedAt !== null &&
            timestampMs - this.standingObservedAt <= CALIBRATION_GAP_MS) {
          this.standingInterrupted = true;
        } else {
          this.resetStandingObservation();
        }
      }
      if (this.attempt) {
        this.interruptStandingObservation(timestampMs);
        this.attempt.totalFrames++;
        this.attempt.maxGap = Math.max(this.attempt.maxGap, timestampMs - this.lastValidTime);
        this.attempt.riseAt = null;
        this.attempt.risePeak = 0;
        this.interruptFinish(this.attempt, timestampMs);
        if (!this.attempt.depthConfirmed) this.attempt.depthReachedAt = null;
      } else if (!tracking) {
        this.lastStandingAt = null;
        this.standingSamples = [];
      }
      if (sustainedTurn) this.loseCalibration(events, "tracking-gap");
      const messages = {
        "no-pose": "Step into view so the camera can see you.",
        joints: "Keep your near hip, knee and ankle visible.",
        shape: "Finding a clearer view of your leg.",
        shoulder: "Keep a shoulder visible while you set up.",
        head: "Keep your head in frame and look straight ahead.",
        feet: "Show your whole feet, including your heels.",
        edges: "Leave a little space around your head and feet.",
      };
      let message = messages[pose.reason] ?? "Turn sideways so the camera sees your profile.";
      if (pose.tooFar) message = "Move a little closer while keeping your head and feet in frame.";
      if (weakContinuity || descentTurn) message = "Finding a clearer view of your leg.";
      else if (pose.weak && checks.sideOn) message = messages.joints;
      return state(message, null, this.baseline ? this.standingProgress() : this.calibrationProgress(), false,
        !sustainedTurn && (weakContinuity || descentTurn) ? pose.sample.side : null);
    }

    const raw = { ...pose.sample, time: timestampMs };
    const sample = { ...raw, raw, speed: 0 };
    if (this.attempt) {
      this.attempt.maxGap = Math.max(this.attempt.maxGap, timestampMs - this.lastValidTime);
    }
    this.lastValidTime = timestampMs;
    this.weakAt = null;
    const previous = this.previous;
    if (previous && sample.side === previous.side && timestampMs - previous.time <= MAX_FRAME_GAP_MS) {
      const interval = timestampMs - previous.time;
      const legLength = this.baseline?.legLength ?? raw.legLength;
      const rawHipRate = hipDropFrom(raw, previous.raw, legLength) * 1000 / interval;
      const rawKneeRate = (previous.raw.kneeAngle - raw.kneeAngle) * 1000 / interval;
      // Change the filter only when the hip and knee agree on motion. Isolated
      // landmark jitter gets more smoothing without dragging a fast reversal.
      const motion = Math.sign(rawHipRate) === Math.sign(rawKneeRate)
        ? clamp(Math.min(Math.abs(rawHipRate) / 0.48, Math.abs(rawKneeRate) / 90), 0, 1) : 0;
      const blend = 1 - Math.exp(-interval / (88 - 74 * motion));
      for (const key of ["hipY", "kneeY", "hipFromSupport", "kneeAngle", "hipAngle", "torsoLean", "shinLean"]) {
        if (sample[key] !== null && previous[key] !== null) {
          sample[key] = previous[key] + (sample[key] - previous[key]) * blend;
        }
      }
      if (this.baseline && !this.previousWasMissing) {
        const speed = hipDropFrom(sample, previous, this.baseline.legLength) * 1000 / interval;
        sample.speed = previous.speed + (clamp(speed, -12, 12) - previous.speed) * blend;
      }
    }
    this.previous = sample;
    this.previousWasMissing = false;

    checks.standing = sample.kneeAngle >= 145 && (sample.kneeY - sample.hipY) / sample.legLength >= 0.35 &&
      (sample.torsoLean === null || sample.torsoLean <= 25);
    if (!this.baseline) {
      checks.steady = checks.standing && this.calibrate(sample);
      if (!checks.standing) this.interruptCalibration(timestampMs);
      const progress = this.calibrationProgress();
      if (checks.steady && progress === 1 && this.calibration.length >= CALIBRATION_MIN_SAMPLES) {
        this.baseline = makeBaseline(this.calibration);
        this.standingSamples = this.calibration.filter((pose) => timestampMs - pose.time <= STANDING_REFERENCE_MS);
        if (lockStanding) this.lockReference(this.standingSamples, timestampMs);
        this.clearCalibrationSamples();
        this.standingObservedMs = CALIBRATION_MS;
        this.standingObservedAt = timestampMs;
        this.phase = "ready";
      } else {
        return state(checks.standing ? "Hold a comfortable standing position." : "Stand tall to calibrate.", null, progress);
      }
    }

    const upright = checks.standing;
    const baseline = this.baseline;
    const start = this.attempt?.start ?? this.lockedStanding ?? baseline;
    const hipDrop = hipDropFrom(sample, start, baseline.legLength);
    const kneeBend = start.kneeAngle - sample.kneeAngle;
    // A different foot placement can produce a different standing knee angle.
    // Accept the recovered pelvis and upright thigh together as a full return.
    const uprightAgain = upright && Math.abs(hipDrop) <= 0.045 &&
      (sample.kneeY - sample.hipY) / sample.thighLength >= 0.91;
    const returnedToStanding = (kneeBend <= 15 && hipDrop <= 0.11) ||
      (kneeBend <= 22 && hipDrop <= 0.06) || uprightAgain;
    const sameStance = previous && Math.abs(hipDropFrom(raw, previous.raw, baseline.legLength)) < 0.03 &&
      Math.abs(raw.kneeAngle - previous.raw.kneeAngle) < 4;
    const closeToStanding = kneeBend <= 8 && hipDrop < 0.055;
    // During a slow descent the hips may still be high, but a different
    // standing knee angle is only relevant during setup and on the return.
    const settled = (closeToStanding || (uprightAgain && (!armed || this.phase === "ascending"))) &&
      (Math.abs(sample.speed) < 0.15 || sameStance);
    const eligibleForStandingHold = upright && (settled || (kneeBend <= 12 &&
      Math.abs(hipDropFrom(raw, start, baseline.legLength)) < 0.13));
    const readyPose = this.lockedStanding ? returnedToStanding : closeToStanding || uprightAgain;
    checks.standing = this.phase === "ready" ? readyPose : returnedToStanding;
    checks.steady = readyPose && Math.abs(sample.speed) < 0.15;
    if (this.attempt) {
      if (this.phase === "ascending") this.observeStanding(sample.time, eligibleForStandingHold);
    } else {
      if (!this.captureStandingReady || upright) this.observeStanding(sample.time, eligibleForStandingHold);
      if (armed && this.standingObservedMs >= CALIBRATION_MS) this.captureStandingReady = true;
    }
    if (!lockStanding && !this.attempt) this.rememberStanding(sample, settled);
    if (settled && !this.attempt) this.lastStandingAt = sample.time;
    if (!armed && !settled) this.lastStandingAt = null;
    if (armed && (this.attempt || this.captureStandingReady)) {
      const movement = { ...raw, drop: hipDropFrom(raw, start, baseline.legLength), bend: start.kneeAngle - raw.kneeAngle };
      this.trackRep(sample, movement, start, returnedToStanding, settled, previous?.raw, events);
    }

    const live = {
      side: sample.side,
      kneeAngleDeg: round(sample.kneeAngle, 1),
      hipAngleDeg: roundIfMeasured(sample.hipAngle, 1),
      standingKneeAngleDeg: round(start.kneeAngle, 1),
      hipDropRatio: round(hipDrop, 3),
      hipToKneeRatio: round((sample.hipY - sample.kneeY) / baseline.legLength, 3),
      torsoLeanDeg: roundIfMeasured(sample.torsoLean, 1),
      shinLeanDeg: round(sample.shinLean, 1),
      hipSpeedLegLengthsPerSec: round(sample.speed, 3),
      finishing: this.phase === "ascending" && Boolean(this.attempt?.firstStanding),
      ...baseline.proportions,
    };
    const messages = {
      setup: "Stand tall to recalibrate.",
      ready: !checks.standing ? "Stand tall before starting the next rep."
        : this.standingObservedMs >= CALIBRATION_MS ? "Side view ready." : "Hold a comfortable standing position.",
      descending: "Lower through your comfortable range.",
      bottom: "Rise when you’re ready.",
      ascending: "Return to your standing position.",
    };
    return state(messages[this.phase], live, this.standingProgress(),
      this.phase === "ready" && checks.steady && this.standingObservedMs >= CALIBRATION_MS);
  }

  calibrate(sample) {
    const latest = this.calibration.at(-1);
    if (latest && (sample.side !== latest.side || sample.time - latest.time > CALIBRATION_GAP_MS)) {
      this.clearCalibrationSamples();
    }
    if (this.calibration.length) {
      const recent = this.calibration.filter((pose) => sample.time - pose.time <= STANDING_REFERENCE_MS);
      if (Math.abs(hipHeight(sample) - median(recent.map(hipHeight))) > 0.065 ||
          Math.abs(sample.kneeAngle - median(recent.map((pose) => pose.kneeAngle))) > 11) {
        this.interruptCalibration(sample.time);
        return false;
      }
      if (!this.calibrationInterrupted) this.calibrationObservedMs += sample.time - latest.time;
    }
    this.calibrationInterrupted = false;
    this.calibration.push(sample);
    return this.calibration.length > 1;
  }

  calibrationProgress() {
    return Math.min(1, this.calibrationObservedMs / CALIBRATION_MS,
      this.calibration.length / CALIBRATION_MIN_SAMPLES);
  }

  clearCalibrationSamples() {
    this.calibration = [];
    this.calibrationObservedMs = 0;
    this.calibrationInterrupted = false;
  }

  interruptCalibration(time) {
    const latest = this.calibration.at(-1);
    if (latest && time - latest.time > CALIBRATION_GAP_MS) this.clearCalibrationSamples();
    else this.calibrationInterrupted = true;
  }

  standingProgress() {
    return this.attempt ? 1 : Math.min(1, this.standingObservedMs / CALIBRATION_MS);
  }

  observeStanding(time, eligible) {
    if (!eligible) {
      this.resetStandingObservation();
      return;
    }
    if (this.standingObservedAt !== null) {
      const interval = time - this.standingObservedAt;
      if (interval > CALIBRATION_GAP_MS) this.standingObservedMs = 0;
      else if (!this.standingInterrupted) this.standingObservedMs = Math.min(CALIBRATION_MS, this.standingObservedMs + interval);
    }
    this.standingObservedAt = time;
    this.standingInterrupted = false;
  }

  resetStandingObservation() {
    this.standingObservedMs = 0;
    this.standingObservedAt = null;
    this.standingInterrupted = false;
  }

  interruptStandingObservation(time) {
    if (this.standingObservedAt !== null && time - this.standingObservedAt <= CALIBRATION_GAP_MS) {
      this.standingInterrupted = true;
    } else {
      this.resetStandingObservation();
    }
  }

  rememberStanding(sample, settled) {
    this.standingSamples = this.standingSamples.filter((pose) => sample.time - pose.time <= STANDING_REFERENCE_MS);
    if (settled) this.standingSamples.push(sample);
  }

  lockReference(samples, timestampMs) {
    this.lockedStanding = standingReference(samples);
    this.lockedStandingAt = timestampMs;
  }

  trackRep(sample, movement, start, standing, settled, previousRaw, events) {
    const { bend: kneeBend, drop: hipDrop } = movement;
    if (!this.attempt) {
      if (this.lastStandingAt !== null && kneeBend >= 8 && hipDrop >= 0.022) {
        this.onsetAt ??= sample.time;
        const decisive = previousRaw && kneeBend >= 14 && hipDrop >= 0.045 &&
          previousRaw.kneeAngle - movement.kneeAngle >= 4 &&
          hipDropFrom(movement, previousRaw, this.baseline.legLength) >= 0.015;
        if (decisive || sample.time - this.onsetAt >= 35) {
          this.startRep(sample, start, events);
          motionCandidate(this.attempt, movement, events);
          this.observeDepth(this.attempt, movement);
        }
      } else {
        this.onsetAt = null;
      }
      return;
    }

    const rep = this.attempt;
    rep.totalFrames++;
    rep.validFrames++;
    if (!rep.firstStanding && (!standing || this.phase !== "ascending")) motionCandidate(rep, movement, events);
    if (this.phase === "descending" || this.phase === "bottom") {
      rep.peakDown = Math.max(rep.peakDown, sample.speed);
      this.observeDepth(rep, movement);
      if (!rep.depthConfirmed && settled && sample.time - rep.onsetAt > 250) {
        this.discard(events, "incomplete-descent");
        return;
      }
      if (!rep.depthConfirmed || !rep.bottom) return;
      const riseHip = rep.bottom.drop - hipDrop;
      const riseKnee = rep.bottom.bend - kneeBend;
      if (riseHip <= 0.012 && Math.abs(riseKnee) < 5) {
        rep.lastAtBottom = movement;
        if (sample.time - rep.bottom.time >= 85 && Math.abs(sample.speed) < 0.12) this.phase = "bottom";
      }
      if (riseHip >= 0.018 && riseKnee >= 6) {
        rep.riseAt ??= sample.time;
        rep.risePeak = Math.max(rep.risePeak, -sample.speed);
        if ((riseHip >= 0.055 && riseKnee >= 12) || sample.time - rep.riseAt >= 35) {
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
    if (rep.bottom.drop - hipDrop < -0.045 && kneeBend >= rep.bottom.bend + 5) {
      this.discard(events, "second-descent");
      return;
    }
    if (!this.confirmFinish(rep, sample, kneeBend, hipDrop, standing)) return;
    // An isolated acquisition burst can drop several callbacks at 12 Hz.
    // Longer patterns still need adequate readable coverage and true phases.
    const validFraction = rep.validFrames / rep.totalFrames;
    if (validFraction < 0.75 || (validFraction < 0.85 && rep.totalFrames - rep.validFrames > 5)) {
      this.discard(events, "low-confidence");
      return;
    }
    finalizeCaptures(rep, sample, events);
    events.push({ type: "rep-complete", rep: formatRep(rep, sample, this.baseline) });
    this.attempt = null;
    this.phase = "ready";
    // A completed rep already includes a confirmed return hold. During a set
    // keep the calibrated stance ready for the next cycle without another setup.
    this.captureStandingReady = this.continuous;
    this.lastStandingAt = settled ? sample.time : null;
    this.onsetAt = null;
  }

  observeDepth(rep, movement) {
    if (movement.bend >= 24 && movement.drop >= 0.07) {
      rep.depthReachedAt ??= movement.time;
      if (movement.time - rep.depthReachedAt >= 55) rep.depthConfirmed = true;
      if (!rep.bottom || movement.drop + 0.0015 * movement.bend >
          rep.bottom.drop + 0.0015 * rep.bottom.bend + 0.004) {
        rep.bottom = movement;
        rep.lastAtBottom = movement;
        rep.riseAt = null;
        rep.risePeak = 0;
      }
    } else if (!rep.depthConfirmed) {
      rep.depthReachedAt = null;
    }
    // A fast squat can spend one camera frame near maximum depth. Still require
    // a separate, in-motion sample alongside a clearly deep, concordant pose.
    if (!rep.depthConfirmed && rep.bottom?.bend >= 32 && rep.bottom.drop >= 0.11) {
      rep.depthConfirmed = rep.samples.some(({ time, bend, drop }) =>
        Math.abs(time - rep.bottom.time) >= 25 && Math.abs(time - rep.bottom.time) <= 250 &&
        bend >= 10 && drop >= 0.023);
    }
  }

  interruptFinish(rep, time, reset = false) {
    rep.lastFinishSampleAt = null;
    if (reset || (rep.lastFinishSeenAt !== null && time - rep.lastFinishSeenAt > FINISH_GRACE_MS)) {
      rep.firstStanding = null;
      rep.finishHoldMs = 0;
      rep.lastFinishSeenAt = null;
    }
  }

  confirmFinish(rep, sample, kneeBend, hipDrop, standing) {
    if (rep.lastFinishSeenAt !== null && sample.time - rep.lastFinishSeenAt > FINISH_GRACE_MS) {
      this.interruptFinish(rep, sample.time, true);
    }
    const nearStanding = standing || (rep.firstStanding && kneeBend <= 22 && hipDrop <= 0.15);
    if (!nearStanding) {
      this.interruptFinish(rep, sample.time, kneeBend > 30 || hipDrop > 0.22);
      return false;
    }
    rep.firstStanding ??= sample;
    if (rep.lastFinishSampleAt !== null && sample.time - rep.lastFinishSampleAt <= 150) {
      rep.finishHoldMs += sample.time - rep.lastFinishSampleAt;
    }
    rep.lastFinishSampleAt = sample.time;
    rep.lastFinishSeenAt = sample.time;
    return rep.finishHoldMs >= FINISH_HOLD_MS;
  }

  startRep(sample, start, events) {
    const rep = {
      id: this.nextRepId++,
      start: { ...start, time: Math.max(this.lastStandingAt, this.onsetAt - 350, this.lockedStandingAt ?? -Infinity) },
      onsetAt: this.onsetAt,
      depthReachedAt: null,
      depthConfirmed: false,
      bottom: null,
      lastAtBottom: null,
      riseAt: null,
      risePeak: 0,
      firstStanding: null,
      finishHoldMs: 0,
      lastFinishSampleAt: null,
      lastFinishSeenAt: null,
      validFrames: 1,
      totalFrames: 1,
      maxGap: 0,
      peakDown: Math.max(0, sample.speed),
      peakUp: 0,
      frames: {},
      samples: [],
    };
    this.phase = "descending";
    this.attempt = rep;
    this.resetStandingObservation();
    capture(rep, "start", sample, events);
  }

  discard(events, reason) {
    if (this.attempt) events.push({ type: "rep-discarded", repId: this.attempt.id, reason });
    this.attempt = null;
    this.phase = this.baseline ? "ready" : "setup";
    this.captureStandingReady = false;
    this.resetStandingObservation();
    this.lastStandingAt = null;
    this.onsetAt = null;
  }

  loseCalibration(events, reason) {
    this.baseline = null;
    this.previous = null;
    this.lastValidTime = null;
    this.previousWasMissing = false;
    this.weakAt = null;
    this.turnAt = null;
    this.clearCalibrationSamples();
    this.standingSamples = [];
    this.lockedStanding = null;
    this.lockedStandingAt = null;
    this.discard(events, reason);
  }
}

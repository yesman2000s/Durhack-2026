const JOINTS = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 };
const STANDING_MS = 1000;
const STANDING_GAP_MS = 220;
const TRACKING_GAP_MS = 400;
const FINISH_MS = 330;
const STANCE_CHANGE_MS = 160;
const MAX_REP_MS = 20000;
const TO_DEGREES = 180 / Math.PI;

const EXERCISES = {
  'push-up': {
    unit: 'degrees', start: 6, peak: 18, returnBand: 9, reversal: 6, steady: 5, jitter: 0.25,
    anchorMessage: 'Keep your hands and toes in place.',
    movement: ['Bend your elbows to lower.', 'Press back up.', 'Hold the top plank briefly.'],
  },
  'knee-raise': {
    unit: 'degrees', start: 7, peak: 21, returnBand: 6, reversal: 6, steady: 5, jitter: 0.25,
    anchorMessage: 'Keep your supporting foot planted.',
    movement: ['Lift the knee nearest the camera.', 'Lower your knee with control.', 'Return your foot to the floor.'],
  },
  'heel-raise': {
    unit: 'leg-lengths', start: 0.018, peak: 0.035, returnBand: 0.014, reversal: 0.012, steady: 0.012, jitter: 0.001,
    anchorMessage: 'Keep your toes in place.',
    movement: ['Lift your heels.', 'Lower your heels with control.', 'Return your heels to the floor.'],
  },
};

const round = (number, digits = 0) => Number(number.toFixed(digits));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function angle(a, joint, b) {
  const ax = a.x - joint.x, ay = a.y - joint.y;
  const bx = b.x - joint.x, by = b.y - joint.y;
  return Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by) * TO_DEGREES;
}

function pointAt(landmarks, index, width, height) {
  const point = landmarks?.[index];
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  const estimates = [point.visibility ?? 1, point.presence ?? 1];
  const confidence = estimates.every(Number.isFinite) ? Math.max(0, Math.min(1, ...estimates)) : 0;
  return { x: point.x * width, y: point.y * height, confidence };
}

function bodySide(landmarks, side, width, height) {
  const offset = side === 'right' ? 1 : 0;
  return { side, ...Object.fromEntries(Object.entries(JOINTS).map(([name, id]) => [name, pointAt(landmarks, id + offset, width, height)])) };
}

function inspect(landmarks, width, height, exercise, reference, preferredSide) {
  if (!landmarks?.length) return { reason: 'missing' };
  const pushUp = exercise === 'push-up';
  const left = bodySide(landmarks, 'left', width, height);
  const right = bodySide(landmarks, 'right', width, height);
  const threshold = reference ? 0.38 : 0.50;
  const necessary = ['hip', 'knee', 'ankle'];
  if (pushUp) necessary.push('elbow', 'wrist');
  if (exercise === 'heel-raise') necessary.push('heel', 'toe');
  const confidence = (pose) => necessary.reduce((sum, key) => sum + (pose[key]?.confidence ?? 0), 0);
  const viable = (pose) => necessary.every((key) => pose[key]?.confidence >= threshold) &&
    pose.shoulder?.confidence >= (pushUp ? threshold : reference ? 0.32 : 0.40);
  const selected = reference?.side ?? preferredSide;
  const side = selected === 'left' ? left : selected === 'right' ? right :
    viable(left) && (!viable(right) || confidence(left) >= confidence(right)) ? left : right;
  const far = side === left ? right : left;
  if (!viable(side)) return { reason: 'joints' };
  const { shoulder, elbow, wrist, hip, knee, ankle, heel, toe } = side;
  const thighLength = distance(hip, knee);
  const shinLength = distance(knee, ankle);
  const legLength = thighLength + shinLength;
  const torsoLength = distance(shoulder, hip);
  const armLength = pushUp ? distance(shoulder, elbow) + distance(elbow, wrist) : 0;
  const segmentLengths = [thighLength, shinLength, torsoLength];
  if (pushUp) segmentLengths.push(distance(shoulder, elbow), distance(elbow, wrist));
  if (exercise === 'heel-raise') segmentLengths.push(distance(heel, toe));
  // A displaced knee can shorten one segment and lengthen the other while
  // preserving total leg length. Only reject gross changes; projected lengths
  // naturally change with a mildly oblique view or out-of-plane movement.
  const changedShape = reference && segmentLengths.some((length, index) =>
    length < reference.segmentLengths[index] * 0.40 || length > reference.segmentLengths[index] * 1.85);
  if (Math.min(thighLength, shinLength, torsoLength) < height * 0.035 ||
      (pushUp && Math.min(distance(shoulder, elbow), distance(elbow, wrist)) < height * 0.025) ||
      (reference && (legLength < 0.60 * reference.legLength || legLength > 1.45 * reference.legLength))) {
    return { reason: 'joints' };
  }
  const nose = pointAt(landmarks, 0, width, height);
  const margin = reference ? 0 : 0.015;
  const fits = (p) => p && p.x >= width * margin && p.x <= width * (1 - margin) &&
    p.y >= height * margin && p.y <= height * (1 - margin);
  if (!necessary.every((key) => fits(side[key])) || !fits(shoulder) ||
      (!reference && (!(nose?.confidence >= 0.40) || !fits(nose) || nose.y < height * margin + torsoLength * 0.12))) {
    return { reason: 'frame' };
  }
  const bodySpan = pushUp ? Math.abs(nose?.x - ankle.x) : ankle.y - nose?.y;
  if (!reference && bodySpan < height * 0.30 && legLength < height * 0.20) return { reason: 'small' };
  const span = (key) => Math.min(side[key]?.confidence ?? 0, far[key]?.confidence ?? 0) >= 0.38
    ? Math.abs(side[key].x - far[key].x) / (reference?.legLength ?? legLength) : null;
  const shoulderSpan = span('shoulder'), hipSpan = span('hip');
  const profile = reference
    ? pushUp
      ? !(hipSpan > 0.44 || (hipSpan > 0.36 && shoulderSpan > 0.55))
      : !(hipSpan > 0.40 || (hipSpan > 0.30 && shoulderSpan > 0.40))
    : shoulderSpan !== null && hipSpan !== null
      ? shoulderSpan <= (pushUp ? 0.50 : 0.40) && hipSpan <= (pushUp ? 0.35 : 0.29)
      : (hipSpan ?? shoulderSpan ?? Infinity) <= (pushUp ? 0.30 : 0.23) ||
        (hipSpan === null && shoulderSpan === null && Math.abs(nose.x - shoulder.x) >= legLength * 0.09);
  if (!profile) return { reason: 'side', inFrame: true };
  const faceX = (nose?.confidence >= 0.40 ? nose.x - shoulder.x : 0);
  const footX = (toe?.confidence >= 0.48 && heel?.confidence >= 0.48 ? toe.x - heel.x : 0);
  const direction = reference?.direction ?? Math.sign(pushUp ? shoulder.x - ankle.x
    : Math.abs(footX) >= legLength * 0.065 ? footX : faceX);
  const kneeAngle = angle(hip, knee, ankle);
  const torsoLean = Math.atan2(Math.abs(shoulder.x - hip.x), hip.y - shoulder.y) * TO_DEGREES;
  const support = far.ankle?.confidence >= 0.45 && fits(far.ankle) ? far.ankle : null;
  const trustedToe = toe?.confidence >= 0.48 && fits(toe) && distance(toe, ankle) <= legLength * 0.38 ? toe : null;
  const pairedFoot = exercise === 'heel-raise' && [far.ankle, far.heel, far.toe].every(p => p?.confidence >= 0.55 && fits(p)) &&
    distance(far.heel, far.toe) >= legLength * 0.045 && distance(far.heel, far.toe) <= legLength * 0.40
    ? { heel: far.heel, toe: far.toe } : null;
  const observation = {
    side: side.side, shoulder, hip, knee, ankle, heel, toe, wrist, support, trustedToe, pairedFoot, direction, legLength, armLength, segmentLengths,
    kneeAngle, torsoLean, hipAngle: angle(shoulder, hip, knee),
    shinLean: Math.atan2(Math.abs(knee.x - ankle.x), ankle.y - knee.y) * TO_DEGREES,
    elbowAngle: pushUp ? angle(shoulder, elbow, wrist) : null,
    thighAngle: Math.atan2(direction * (knee.x - hip.x), knee.y - hip.y) * TO_DEGREES,
  };
  // Preserve the more useful stance-change feedback when the hand or support
  // moved; neither kind of invalid reading contributes movement evidence.
  if (changedShape && !movement(observation, reference, exercise).shifted) return { reason: 'joints' };
  return { observation, inFrame: true };
}

function pushUpPlank(pose, kneeFloor, hipFloor) {
  const { shoulder, wrist, hip, ankle, trustedToe, legLength, direction } = pose;
  const floor = trustedToe ?? ankle;
  return direction * (shoulder.x - ankle.x) >= legLength * 0.95 &&
    direction * (hip.x - ankle.x) >= legLength * 0.50 &&
    direction * (shoulder.x - hip.x) >= legLength * 0.22 &&
    Math.abs(wrist.y - floor.y) <= legLength * (trustedToe ? 0.34 : 0.43) &&
    pose.kneeAngle >= kneeFloor && pose.hipAngle >= hipFloor;
}

function startingPosition(pose, exercise) {
  if (exercise === 'push-up') {
    // Recognize a steady personal top position, not an ideal form template.
    // Soft elbows, varied hand placement and projection can change these angles.
    return pushUpPlank(pose, 140, 135) && pose.elbowAngle >= 130 &&
      pose.wrist.y - pose.shoulder.y >= pose.armLength * 0.52 &&
      Math.abs(pose.wrist.x - pose.shoulder.x) <= pose.armLength * 0.78;
  }
  if (!pose.direction || pose.kneeAngle < 145 || pose.knee.y - pose.hip.y < 0.30 * pose.legLength) return false;
  if (pose.torsoLean > 30 || Math.abs(pose.thighAngle) > 20) return false;
  if (exercise === 'heel-raise') {
    const flat = (foot) => Math.abs(foot.heel.y - foot.toe.y) <= pose.legLength * 0.13;
    return flat(pose) && (!pose.pairedFoot || flat(pose.pairedFoot));
  }
  return !pose.support || Math.abs(pose.ankle.y - pose.support.y) <= pose.legLength * 0.13;
}

function movement(pose, start, exercise) {
  const { legLength } = start;
  if (exercise === 'push-up') {
    const drop = ((start.wrist.y - start.shoulder.y) - (pose.wrist.y - pose.shoulder.y)) / start.armLength;
    const hipDrop = ((pose.hip.y - pose.ankle.y) - (start.hip.y - start.ankle.y)) / legLength;
    // Every accepted top pose must also fit the looser moving-pose envelope.
    const plank = pushUpPlank(pose, 130, 125);
    const bothToes = pose.trustedToe && start.trustedToe;
    const footMoved = bothToes ? distance(pose.trustedToe, start.trustedToe) > legLength * 0.20
      : Math.abs(pose.ankle.x - start.ankle.x) > legLength * 0.23;
    return {
      range: start.elbowAngle - pose.elbowAngle,
      started: plank && drop >= 0.04,
      corroborated: plank && drop >= 0.12 && hipDrop >= 0.035,
      shifted: distance(pose.wrist, start.wrist) > start.armLength * 0.25 || footMoved,
      returned: plank && Math.abs(drop) <= 0.10 && Math.abs(hipDrop) <= 0.12,
      invalid: !plank,
    };
  }
  if (exercise === 'knee-raise') {
    const kneeLift = ((pose.hip.y - pose.knee.y) - (start.hip.y - start.knee.y)) / legLength;
    const footLift = (start.ankle.y - pose.ankle.y) / legLength;
    return {
      range: pose.thighAngle - start.thighAngle,
      started: kneeLift >= 0.008 && footLift >= 0.012,
      corroborated: kneeLift >= 0.045 && footLift >= 0.04,
      shifted: (pose.support && start.support && distance(pose.support, start.support) > legLength * 0.18) ||
        Math.abs(pose.hip.x - start.hip.x) > legLength * 0.28,
      returned: distance(pose.ankle, start.ankle) <= legLength * 0.11,
    };
  }
  const heelLift = ((pose.toe.y - pose.heel.y) - (start.toe.y - start.heel.y)) / legLength;
  const pair = pose.pairedFoot;
  const initialPair = start.pairedFoot;
  const pairLift = pair && initialPair ? ((pair.toe.y - pair.heel.y) - (initialPair.toe.y - initialPair.heel.y)) / legLength : null;
  const pairedToeShift = pair && initialPair && distance(pair.toe, initialPair.toe) > legLength * 0.14;
  return {
    range: heelLift,
    started: start.ankle.y - pose.ankle.y >= 0.006 * legLength,
    corroborated: (start.hip.y - pose.hip.y) / legLength >= 0.016 &&
      (start.ankle.y - pose.ankle.y) / legLength >= 0.018 && pose.kneeAngle >= start.kneeAngle - 20 &&
      (pairLift === null || pairLift >= 0.012),
    shifted: distance(pose.toe, start.toe) > legLength * 0.11 || Boolean(pairedToeShift),
    returned: Math.abs(pose.ankle.y - start.ankle.y) <= legLength * 0.09 && (pairLift === null || Math.abs(pairLift) <= 0.05),
  };
}

function stable(previous, pose, exercise) {
  if (!previous) return true;
  const excursion = movement(pose, previous, exercise);
  return !excursion.shifted && Math.abs(excursion.range) <= EXERCISES[exercise].steady &&
    distance(pose.hip, previous.hip) <= previous.legLength * 0.045;
}

function stayedInStartingPosition(anchor, pose, exercise) {
  const excursion = movement(pose, anchor, exercise);
  const handDrift = exercise === 'push-up' && distance(pose.wrist, anchor.wrist) > anchor.armLength * 0.075;
  const footAnchor = exercise === 'heel-raise' ? anchor.toe : anchor.ankle;
  const foot = exercise === 'heel-raise' ? pose.toe : pose.ankle;
  return !handDrift && Math.abs(excursion.range) <= EXERCISES[exercise].steady * 1.5 &&
    distance(pose.hip, anchor.hip) <= anchor.legLength * 0.07 &&
    distance(foot, footAnchor) <= anchor.legLength * 0.07;
}

function middleFrame(samples, from, until, peak) {
  let best = null, bestError = Infinity;
  for (const sample of samples) {
    if (sample.time < from || sample.time >= until || sample.range < peak * 0.12 || sample.range > peak * 0.92) continue;
    const error = Math.abs(sample.range / peak - 0.5);
    if (error + 1e-9 < bestError) {
      best = sample;
      bestError = error;
    }
  }
  return best;
}

function capture(rep, phase, sample, events) {
  const frame = { phase, timestampMs: sample.time };
  rep.frames.push(frame);
  events.push({ type: 'capture', repId: rep.id, ...frame });
}

export class MobilityTracker {
  constructor(exercise) {
    if (!Object.hasOwn(EXERCISES, exercise)) throw new RangeError(`Unknown exercise: ${exercise}`);
    this.exercise = exercise;
    this.rules = EXERCISES[exercise];
    this.reset();
  }

  reset() {
    this.phase = 'setup';
    this.lastAt = null;
    this.lastSeenAt = null;
    this.reference = null;
    this.rep = null;
    this.nextRepId = 1;
    this.continuous = false;
    this.shiftedAt = null;
    this.onset = null;
    this.clearStanding();
  }

  clearStanding() {
    this.standing = { time: null, elapsed: 0, count: 0, missed: false, pose: null, anchor: null };
  }

  observeStanding(pose, time) {
    const current = this.standing;
    if (!startingPosition(pose, this.exercise) ||
        (current.pose && !stable(current.pose, pose, this.exercise))) {
      this.clearStanding();
      return false;
    }
    if (current.anchor && !stayedInStartingPosition(current.anchor, pose, this.exercise)) {
      this.clearStanding();
    } else if (current.time !== null && time - current.time <= STANDING_GAP_MS && !current.missed) {
      current.elapsed = Math.min(STANDING_MS, current.elapsed + time - current.time);
    } else if (current.time !== null && time - current.time > STANDING_GAP_MS) {
      this.clearStanding();
    }
    this.standing.anchor ??= pose;
    this.standing.time = time;
    this.standing.pose = pose;
    this.standing.count += 1;
    this.standing.missed = false;
    return this.standing.elapsed >= STANDING_MS && this.standing.count >= 7;
  }

  discard(events, reason) {
    if (this.rep) events.push({ type: 'rep-discarded', repId: this.rep.id, reason });
    this.reference = null;
    this.rep = null;
    this.onset = null;
    this.shiftedAt = null;
    this.lastSeenAt = null;
    this.phase = 'setup';
    this.clearStanding();
  }

  update({ landmarks, timestampMs: time, width, height, armed = true, lockStanding = armed, continuous = false }) {
    const events = [];
    const checks = { inFrame: false, sideOn: false, standing: false, steady: false };
    const state = (message, live = null, ready = false) => ({
      phase: this.phase, setup: { ready, message, checks, progress: this.reference ? 1 : Math.min(1, this.standing.elapsed / STANDING_MS, this.standing.count / 7) },
      live, events, continuitySide: null,
    });
    if (!Number.isFinite(time) || time <= (this.lastAt ?? -Infinity) ||
        !Number.isFinite(width) || !Number.isFinite(height) || !(width > 0 && height > 0)) {
      return state('Waiting for the next camera frame.');
    }
    this.lastAt = time;
    this.continuous = continuous === true;
    if (!armed && this.rep) this.discard(events, 'cancelled');
    if (!lockStanding) {
      this.reference = null;
      this.onset = null;
    }
    if (this.reference && this.lastSeenAt !== null && time - this.lastSeenAt > TRACKING_GAP_MS) {
      this.discard(events, 'tracking-gap');
    }
    if (this.rep && time - this.rep.startedAt > MAX_REP_MS) this.discard(events, 'timeout');
    // A user may begin moving just after the countdown starts. Preserve the
    // side and pose that earned readiness instead of recalibrating mid-motion.
    if (lockStanding && !this.reference && !this.standing.missed && this.standing.pose &&
        this.standing.elapsed >= STANDING_MS && this.standing.count >= 7 &&
        time - this.standing.time <= STANDING_GAP_MS) {
      this.reference = { ...this.standing.pose, time: this.standing.time };
    }

    const measured = inspect(landmarks, width, height, this.exercise, this.reference, this.standing.pose?.side);
    const pose = measured.observation;
    checks.inFrame = Boolean(measured.inFrame);
    checks.sideOn = Boolean(pose);
    if (!pose) {
      if (this.rep) this.missRep(time);
      else if (measured.reason === 'side' || (this.standing.time !== null && time - this.standing.time > STANDING_GAP_MS)) {
        this.clearStanding();
      } else {
        this.standing.missed = true;
      }
      this.shiftedAt = null;
      this.onset = null;
      const prompts = {
        missing: 'Step into view so the camera can see you.',
        frame: this.exercise === 'push-up' ? 'Keep your head, hands and toes in view.' : 'Keep your head and feet in view.',
        small: 'Move a little closer while keeping your whole body in view.',
        side: 'Turn sideways so the camera sees your profile.',
        joints: this.exercise === 'push-up' ? 'Keep your near arm and leg visible.' : 'Keep the near leg visible.',
      };
      return state(prompts[measured.reason]);
    }

    if (!this.reference) {
      checks.standing = startingPosition(pose, this.exercise);
      checks.steady = this.observeStanding(pose, time);
      if (checks.steady) {
        this.phase = 'ready';
        this.lastSeenAt = time;
        if (lockStanding) this.reference = { ...pose, time };
      } else {
        this.phase = 'setup';
      }
      return state(checks.steady ? 'Side view ready.' : checks.standing ? 'Hold your starting position.' :
        this.exercise === 'push-up' ? 'Hold your top push-up position; a slight elbow bend is okay.' : 'Move into the starting position.',
        checks.steady ? this.live(pose, 0) : null, checks.steady);
    }

    const start = this.reference;
    const sample = { ...movement(pose, start, this.exercise), pose, time };
    if (sample.shifted) {
      this.shiftedAt ??= time;
      if (this.rep) this.missRep(time);
      if (time - this.shiftedAt >= STANCE_CHANGE_MS) this.discard(events, 'foot-moved');
      this.onset = null;
      return state(this.rules.anchorMessage);
    }
    this.shiftedAt = null;
    if (sample.invalid) {
      if (this.rep) this.missRep(time);
      this.onset = null;
      return state('Keep your body in a plank.');
    }
    const gap = time - this.lastSeenAt;
    this.lastSeenAt = time;
    checks.standing = sample.returned && Math.abs(sample.range) <= this.rules.returnBand;
    checks.steady = checks.standing;
    if (armed && this.reference) {
      if (this.rep) this.track(sample, gap, checks.standing, events);
      else if (sample.range >= this.rules.start && sample.started) {
        if (this.onset) this.begin(this.onset, sample, events);
        else this.onset = sample;
      } else {
        this.onset = null;
        if (checks.standing) this.reference = { ...start, time };
      }
    }
    const index = ['descending', 'bottom', 'ascending'].indexOf(this.phase);
    const message = index < 0 ? checks.standing ? 'Side view ready.' : 'Return to your starting position.' : this.rules.movement[index];
    return state(message, this.live(pose, sample.range), this.phase === 'ready' && checks.steady && Boolean(this.reference));
  }

  live(pose, range) {
    return {
      side: pose.side, range: round(range, 3), rangeUnit: this.rules.unit,
      movementSpeedPerSec: round(this.rep?.speed ?? 0, 3), finishing: Boolean(this.rep?.returned),
      torsoLeanDeg: round(pose.torsoLean, 1), shinLeanDeg: round(pose.shinLean, 1),
      kneeAngleDeg: round(pose.kneeAngle, 1), hipAngleDeg: round(pose.hipAngle, 1),
    };
  }

  addCandidate(sample, events) {
    this.rep.samples.push(sample);
    events.push({ type: 'capture-candidate', repId: this.rep.id, timestampMs: sample.time,
      kneeAngleDeg: round(sample.pose.kneeAngle, 1), range: round(sample.range, 3) });
  }

  begin(onset, sample, events) {
    const beganAt = Math.max(this.reference.time, onset.time - 240);
    const rep = {
      id: this.nextRepId++, startedAt: beganAt, frames: [], samples: [], latest: onset,
      peak: onset, lastAtPeak: onset, depthSamples: 0, returned: null, finishAt: null,
      finishMs: 0, speed: 0, peakOut: 0, peakBack: 0, valid: 1, total: 1, maxGap: 0,
    };
    this.rep = rep;
    this.phase = 'descending';
    this.onset = null;
    capture(rep, 'start', sample, events);
    this.track(sample, sample.time - onset.time, false, events);
  }

  missRep(time) {
    this.rep.total += 1;
    this.rep.maxGap = Math.max(this.rep.maxGap, time - this.lastSeenAt);
    this.rep.finishAt = null;
    this.rep.latest = null;
  }

  track(sample, gap, standing, events) {
    const rep = this.rep;
    rep.total += 1;
    rep.valid += 1;
    rep.maxGap = Math.max(rep.maxGap, gap);
    rep.speed = rep.latest ? (sample.range - rep.latest.range) * 1000 / (sample.time - rep.latest.time) : 0;
    rep.latest = sample;
    if (!standing || this.phase !== 'ascending') this.addCandidate(sample, events);
    if (this.phase !== 'ascending') {
      rep.peakOut = Math.max(rep.peakOut, rep.speed);
      if (sample.corroborated && sample.range >= this.rules.peak) {
        rep.depthSamples += 1;
        if (sample.range > rep.peak.range + this.rules.jitter) {
          rep.peak = sample;
          rep.lastAtPeak = sample;
        }
      }
      if (sample.corroborated && rep.depthSamples && rep.peak.range - sample.range <= this.rules.reversal * 0.4 &&
          sample.time - rep.peak.time >= 65) {
        rep.lastAtPeak = sample;
        this.phase = 'bottom';
      }
      if (rep.depthSamples >= 2 && rep.peak.range - sample.range >= this.rules.reversal) {
        this.phase = 'ascending';
      } else if (standing && sample.time - rep.startedAt >= 250) {
        this.discard(events, 'incomplete-descent');
        return;
      }
    }
    if (this.phase !== 'ascending') return;
    rep.peakBack = Math.max(rep.peakBack, -rep.speed);
    if (!standing) {
      rep.returned = null;
      rep.finishAt = null;
      rep.finishMs = 0;
      return;
    }
    rep.returned ??= sample;
    if (rep.finishAt !== null && sample.time - rep.finishAt <= 190) rep.finishMs += sample.time - rep.finishAt;
    rep.finishAt = sample.time;
    if (rep.finishMs < FINISH_MS) return;
    if (rep.valid / rep.total < 0.8) {
      this.discard(events, 'low-confidence');
      return;
    }
    this.complete(sample, events);
  }

  complete(sample, events) {
    const rep = this.rep;
    const peak = rep.peak;
    const outward = middleFrame(rep.samples, rep.frames[0].timestampMs, peak.time, peak.range);
    const inward = middleFrame(rep.samples, peak.time + 0.001, rep.returned.time, peak.range);
    if (outward) capture(rep, 'descent', outward, events);
    capture(rep, 'bottom', peak, events);
    if (inward) capture(rep, 'ascent', inward, events);
    capture(rep, 'finish', sample, events);
    const outwardMs = peak.time - rep.startedAt;
    const holdMs = rep.lastAtPeak.time - peak.time;
    const returnMs = rep.returned.time - rep.lastAtPeak.time;
    const range = round(peak.range, this.rules.unit === 'degrees' ? 1 : 3);
    events.push({ type: 'rep-complete', rep: {
      id: rep.id, exercise: this.exercise, side: this.reference.side,
      startedAtMs: rep.startedAt, returnedAtMs: rep.returned.time, finishedAtMs: sample.time,
      metrics: {
        range, rangeUnit: this.rules.unit, outwardMs: round(outwardMs), holdMs: round(holdMs),
        returnMs: round(returnMs), durationMs: round(rep.returned.time - rep.startedAt),
        averageOutwardSpeedPerSec: round(peak.range * 1000 / Math.max(1, outwardMs), 3),
        averageReturnSpeedPerSec: round(Math.max(0, peak.range - rep.returned.range) * 1000 / Math.max(1, returnMs), 3),
        peakOutwardSpeedPerSec: round(rep.peakOut, 3), peakReturnSpeedPerSec: round(rep.peakBack, 3),
        validFrameFraction: round(rep.valid / rep.total, 3), maxTrackingGapMs: round(rep.maxGap),
      },
      cues: [], frames: rep.frames,
    } });
    // The finish hold has already confirmed this personal top position. Keep
    // its geometry for the next rep of a set instead of recalibrating for 1s.
    this.reference = this.continuous ? { ...this.reference, time: sample.time } : null;
    this.rep = null;
    this.phase = 'ready';
    this.clearStanding();
    this.observeStanding(sample.pose, sample.time);
  }
}

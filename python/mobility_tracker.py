"""Side-view repetition tracking for floor push-ups and standing raises."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from math import atan2, degrees, hypot, inf, isfinite


JOINTS = dict(shoulder=11, elbow=13, wrist=15, hip=23, knee=25, ankle=27, heel=29, toe=31)
STANDING_MS = 1000
STANDING_GAP_MS = 220
TRACKING_GAP_MS = 400
FINISH_MS = 330
FINISH_GRACE_MS = 240
STANCE_CHANGE_MS = 160
MAX_REP_MS = 20000


@dataclass(frozen=True)
class Rules:
    unit: str
    start: float
    peak: float
    return_band: float
    reversal: float
    steady: float
    jitter: float
    anchor_message: str
    movement: tuple[str, str, str]


EXERCISES = {
    "push-up": Rules("degrees", 6, 18, 9, 6, 5, 0.25, "Keep your hands and toes in place.",
                     ("Bend your elbows to lower.", "Press back up.", "Hold the top plank briefly.")),
    "knee-raise": Rules("degrees", 7, 21, 6, 6, 5, 0.25, "Keep your supporting foot planted.",
                        ("Lift the knee nearest the camera.", "Lower your knee with control.", "Return your foot to the floor.")),
    "heel-raise": Rules("leg-lengths", 0.018, 0.035, 0.014, 0.012, 0.012, 0.001, "Keep your toes in place.",
                        ("Lift your heels.", "Lower your heels with control.", "Return your heels to the floor.")),
}


@dataclass(frozen=True)
class Point:
    x: float
    y: float
    confidence: float


@dataclass(frozen=True)
class Foot:
    heel: Point
    toe: Point


@dataclass(frozen=True)
class Pose:
    side: str
    shoulder: Point
    hip: Point
    knee: Point
    ankle: Point
    heel: Point | None
    toe: Point | None
    wrist: Point | None
    support: Point | None
    direction: int
    leg_length: float
    arm_length: float
    knee_angle: float
    torso_lean: float
    hip_angle: float
    shin_lean: float
    elbow_angle: float | None
    thigh_angle: float
    trusted_toe: Point | None
    paired_foot: Foot | None
    segment_lengths: tuple[float, ...]
    time: float = 0


@dataclass(frozen=True)
class Sample:
    range: float
    started: bool
    corroborated: bool
    shifted: bool
    returned: bool
    pose: Pose
    time: float
    invalid: bool = False


@dataclass
class Standing:
    time: float | None = None
    elapsed: float = 0
    count: int = 0
    missed: bool = False
    pose: Pose | None = None
    anchor: Pose | None = None


@dataclass
class Rep:
    id: int
    started_at: float
    latest: Sample | None
    peak: Sample
    last_at_peak: Sample
    frames: list = field(default_factory=list)
    samples: list = field(default_factory=list)
    depth_samples: int = 0
    returned: Sample | None = None
    finish_at: float | None = None
    finish_seen_at: float | None = None
    finish_ms: float = 0
    speed: float = 0
    peak_out: float = 0
    peak_back: float = 0
    valid: int = 1
    total: int = 1
    max_gap: float = 0


def _distance(a, b):
    return hypot(a.x - b.x, a.y - b.y)


def _angle(a, joint, b):
    ax, ay = a.x - joint.x, a.y - joint.y
    bx, by = b.x - joint.x, b.y - joint.y
    return degrees(atan2(abs(ax * by - ay * bx), ax * bx + ay * by))


def _point_at(landmarks, index, width, height):
    point = landmarks[index] if index < len(landmarks) else None
    if point is None:
        return None
    get = point.get if isinstance(point, dict) else lambda name, default=None: getattr(point, name, default)
    x, y = get("x"), get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not isfinite(x) or not isfinite(y):
        return None
    estimates = [get(name) for name in ("visibility", "presence")]
    estimates = [1 if value is None else value for value in estimates]
    confidence = (max(0, min(1, *estimates))
                  if all(isinstance(value, (int, float)) and isfinite(value) for value in estimates) else 0)
    return Point(x * width, y * height, confidence)


def _body_side(landmarks, offset, width, height):
    return {name: _point_at(landmarks, index + offset, width, height) for name, index in JOINTS.items()}


def _confidence(point):
    return point.confidence if point is not None else 0


def _inspect(landmarks, width, height, exercise, reference, preferred_side):
    if not landmarks:
        return None, "missing", False
    push_up = exercise == "push-up"
    left = _body_side(landmarks, 0, width, height)
    right = _body_side(landmarks, 1, width, height)
    threshold = 0.38 if reference else 0.50
    necessary = ["hip", "knee", "ankle"]
    if push_up:
        necessary.extend(("elbow", "wrist"))
    if exercise == "heel-raise":
        necessary.extend(("heel", "toe"))
    shoulder_threshold = threshold if push_up else 0.32 if reference else 0.40

    def viable(side):
        return (all(_confidence(side[key]) >= threshold for key in necessary)
                and _confidence(side["shoulder"]) >= shoulder_threshold)

    side_name = reference.side if reference else preferred_side
    if side_name is None:
        left_confidence = sum(_confidence(left[key]) for key in necessary)
        right_confidence = sum(_confidence(right[key]) for key in necessary)
        side_name = "left" if viable(left) and (not viable(right) or left_confidence >= right_confidence) else "right"
    side, far = (left, right) if side_name == "left" else (right, left)
    if not viable(side):
        return None, "joints", False
    shoulder, elbow, wrist, hip, knee, ankle, heel, toe = (side[key] for key in JOINTS)
    thigh_length = _distance(hip, knee)
    shin_length = _distance(knee, ankle)
    leg_length = thigh_length + shin_length
    torso_length = _distance(shoulder, hip)
    arm_length = 0
    segment_lengths = [thigh_length, shin_length, torso_length]
    if push_up:
        upper_arm, forearm = _distance(shoulder, elbow), _distance(elbow, wrist)
        arm_length = upper_arm + forearm
        segment_lengths.extend((upper_arm, forearm))
        if min(upper_arm, forearm) < height * 0.025:
            return None, "joints", False
    if exercise == "heel-raise":
        segment_lengths.append(_distance(heel, toe))
    changed_shape = reference and any(
        not 0.40 * initial <= length <= 1.85 * initial
        for length, initial in zip(segment_lengths, reference.segment_lengths, strict=True)
    )
    if (min(thigh_length, shin_length, torso_length) < height * 0.035
            or (reference and not 0.60 * reference.leg_length <= leg_length <= 1.45 * reference.leg_length)):
        return None, "joints", False
    nose = _point_at(landmarks, 0, width, height)
    margin = 0 if reference else 0.015

    def fits(point):
        return (point is not None and width * margin <= point.x <= width * (1 - margin)
                and height * margin <= point.y <= height * (1 - margin))

    if (not all(fits(side[key]) for key in necessary) or not fits(shoulder)
            or (not reference and (_confidence(nose) < 0.40 or not fits(nose)
                                  or nose.y < height * margin + torso_length * 0.12))):
        return None, "frame", False
    if not reference:
        body_span = abs(nose.x - ankle.x) if push_up else ankle.y - nose.y
        if body_span < height * 0.30 and leg_length < height * 0.20:
            return None, "small", False

    def span(key):
        if min(_confidence(side[key]), _confidence(far[key])) < 0.38:
            return None
        return abs(side[key].x - far[key].x) / (reference.leg_length if reference else leg_length)

    shoulder_span, hip_span = span("shoulder"), span("hip")
    if reference:
        profile = (not ((hip_span or 0) > 0.44 or ((hip_span or 0) > 0.36 and (shoulder_span or 0) > 0.55))
                   if push_up else not ((hip_span or 0) > 0.40 or ((hip_span or 0) > 0.30 and (shoulder_span or 0) > 0.40)))
    elif shoulder_span is not None and hip_span is not None:
        profile = shoulder_span <= (0.50 if push_up else 0.40) and hip_span <= (0.35 if push_up else 0.29)
    elif shoulder_span is not None or hip_span is not None:
        profile = (hip_span if hip_span is not None else shoulder_span) <= (0.30 if push_up else 0.23)
    else:
        profile = abs(nose.x - shoulder.x) >= leg_length * 0.09
    if not profile:
        return None, "side", True

    if reference:
        direction = reference.direction
    else:
        face_x = nose.x - shoulder.x if _confidence(nose) >= 0.40 else 0
        foot_x = toe.x - heel.x if min(_confidence(toe), _confidence(heel)) >= 0.48 else 0
        delta = shoulder.x - ankle.x if push_up else foot_x if abs(foot_x) >= leg_length * 0.065 else face_x
        direction = (delta > 0) - (delta < 0)
    support = far["ankle"] if _confidence(far["ankle"]) >= 0.45 and fits(far["ankle"]) else None
    trusted_toe = toe if _confidence(toe) >= 0.48 and fits(toe) and _distance(toe, ankle) <= leg_length * 0.38 else None
    paired_foot = None
    if exercise == "heel-raise" and all(_confidence(far[key]) >= 0.55 and fits(far[key]) for key in ("ankle", "heel", "toe")):
        if leg_length * 0.045 <= _distance(far["heel"], far["toe"]) <= leg_length * 0.40:
            paired_foot = Foot(far["heel"], far["toe"])
    observation = Pose(side_name, shoulder, hip, knee, ankle, heel, toe, wrist, support, direction, leg_length, arm_length,
                _angle(hip, knee, ankle), degrees(atan2(abs(shoulder.x - hip.x), hip.y - shoulder.y)),
                _angle(shoulder, hip, knee), degrees(atan2(abs(knee.x - ankle.x), ankle.y - knee.y)),
                _angle(shoulder, elbow, wrist) if push_up else None,
                degrees(atan2(direction * (knee.x - hip.x), knee.y - hip.y)),
                trusted_toe, paired_foot, tuple(segment_lengths))
    if changed_shape and not _movement(observation, reference, exercise, 0).shifted:
        return None, "joints", False
    return observation, None, True


def _push_up_plank(pose, knee_floor, hip_floor):
    leg = pose.leg_length
    floor = pose.trusted_toe or pose.ankle
    return (pose.direction * (pose.shoulder.x - pose.ankle.x) >= leg * 0.95
            and pose.direction * (pose.hip.x - pose.ankle.x) >= leg * 0.50
            and pose.direction * (pose.shoulder.x - pose.hip.x) >= leg * 0.22
            and abs(pose.wrist.y - floor.y) <= leg * (0.34 if pose.trusted_toe else 0.43)
            and pose.knee_angle >= knee_floor and pose.hip_angle >= hip_floor)


def _starting_position(pose, exercise):
    if exercise == "push-up":
        # Calibrate to a steady personal top, allowing soft elbows and projection.
        return (_push_up_plank(pose, 140, 135) and pose.elbow_angle >= 130
                and pose.wrist.y - pose.shoulder.y >= pose.arm_length * 0.52
                and abs(pose.wrist.x - pose.shoulder.x) <= pose.arm_length * 0.78)
    if not pose.direction or pose.knee_angle < 145 or pose.knee.y - pose.hip.y < 0.30 * pose.leg_length:
        return False
    if pose.torso_lean > 30 or abs(pose.thigh_angle) > 20:
        return False
    if exercise == "heel-raise":
        def flat(foot):
            return abs(foot.heel.y - foot.toe.y) <= pose.leg_length * 0.13
        return flat(pose) and (not pose.paired_foot or flat(pose.paired_foot))
    return not pose.support or abs(pose.ankle.y - pose.support.y) <= pose.leg_length * 0.13


def _movement(pose, start, exercise, timestamp):
    leg = start.leg_length
    if exercise == "push-up":
        drop = ((start.wrist.y - start.shoulder.y) - (pose.wrist.y - pose.shoulder.y)) / start.arm_length
        hip_drop = ((pose.hip.y - pose.ankle.y) - (start.hip.y - start.ankle.y)) / leg
        plank = _push_up_plank(pose, 130, 125)
        foot_moved = (_distance(pose.trusted_toe, start.trusted_toe) > leg * 0.20
                      if pose.trusted_toe and start.trusted_toe
                      else abs(pose.ankle.x - start.ankle.x) > leg * 0.23)
        return Sample(start.elbow_angle - pose.elbow_angle, plank and drop >= 0.04,
                      plank and drop >= 0.12 and hip_drop >= 0.035,
                      _distance(pose.wrist, start.wrist) > start.arm_length * 0.25 or foot_moved,
                      plank and abs(drop) <= 0.10 and abs(hip_drop) <= 0.12, pose, timestamp, invalid=not plank)
    if exercise == "knee-raise":
        knee_lift = ((pose.hip.y - pose.knee.y) - (start.hip.y - start.knee.y)) / leg
        foot_lift = (start.ankle.y - pose.ankle.y) / leg
        support_shift = pose.support and start.support and _distance(pose.support, start.support) > leg * 0.18
        return Sample(pose.thigh_angle - start.thigh_angle, knee_lift >= 0.008 and foot_lift >= 0.012,
                      knee_lift >= 0.045 and foot_lift >= 0.04,
                      bool(support_shift or abs(pose.hip.x - start.hip.x) > leg * 0.28),
                      _distance(pose.ankle, start.ankle) <= leg * 0.11, pose, timestamp)
    heel_lift = ((pose.toe.y - pose.heel.y) - (start.toe.y - start.heel.y)) / leg
    ankle_lift = start.ankle.y - pose.ankle.y
    pair, initial_pair = pose.paired_foot, start.paired_foot
    pair_lift = None
    pair_shifted = False
    if pair and initial_pair:
        pair_lift = ((pair.toe.y - pair.heel.y) - (initial_pair.toe.y - initial_pair.heel.y)) / leg
        pair_shifted = _distance(pair.toe, initial_pair.toe) > leg * 0.14
    return Sample(heel_lift, ankle_lift >= 0.006 * leg,
                  (start.hip.y - pose.hip.y) / leg >= 0.016 and ankle_lift / leg >= 0.018
                  and pose.knee_angle >= start.knee_angle - 20 and (pair_lift is None or pair_lift >= 0.012),
                  _distance(pose.toe, start.toe) > leg * 0.11 or pair_shifted,
                  abs(ankle_lift) <= leg * 0.09 and (pair_lift is None or abs(pair_lift) <= 0.05), pose, timestamp)


def _stable(previous, pose, exercise):
    if previous is None:
        return True
    excursion = _movement(pose, previous, exercise, 0)
    return (not excursion.shifted and abs(excursion.range) <= EXERCISES[exercise].steady
            and _distance(pose.hip, previous.hip) <= previous.leg_length * 0.045)


def _stayed_in_starting_position(anchor, pose, exercise):
    change = _movement(pose, anchor, exercise, 0)
    hand_drift = exercise == "push-up" and _distance(pose.wrist, anchor.wrist) > anchor.arm_length * 0.075
    foot, foot_anchor = (pose.toe, anchor.toe) if exercise == "heel-raise" else (pose.ankle, anchor.ankle)
    return (not hand_drift and abs(change.range) <= EXERCISES[exercise].steady * 1.5
            and _distance(pose.hip, anchor.hip) <= anchor.leg_length * 0.07
            and _distance(foot, foot_anchor) <= anchor.leg_length * 0.07)


def _middle_frame(samples, start, end, peak):
    best, best_error = None, inf
    for sample in samples:
        if not start <= sample.time < end or not peak * 0.12 <= sample.range <= peak * 0.92:
            continue
        error = abs(sample.range / peak - 0.5)
        if error + 1e-9 < best_error:
            best, best_error = sample, error
    return best


def _capture(rep, phase, sample, events):
    frame = {"phase": phase, "timestampMs": sample.time}
    rep.frames.append(frame)
    events.append({"type": "capture", "repId": rep.id, **frame})


class MobilityTracker:
    def __init__(self, exercise):
        if exercise not in EXERCISES:
            raise ValueError(f"Unknown exercise: {exercise}")
        self.exercise = exercise
        self.rules = EXERCISES[exercise]
        self.reset()

    def reset(self):
        self.last_at = None
        self.next_rep_id = 1
        self._clear_tracking()

    def _observe_standing(self, pose, timestamp):
        current = self.standing
        if not _starting_position(pose, self.exercise) or not _stable(current.pose, pose, self.exercise):
            self.standing = Standing()
            return False
        if current.anchor and not _stayed_in_starting_position(current.anchor, pose, self.exercise):
            self.standing = current = Standing()
        elif current.time is not None:
            gap = timestamp - current.time
            if gap > STANDING_GAP_MS:
                self.standing = current = Standing()
            elif not current.missed:
                current.elapsed = min(STANDING_MS, current.elapsed + gap)
        current.time = timestamp
        current.pose = pose
        if current.anchor is None:
            current.anchor = pose
        current.count += 1
        current.missed = False
        return current.elapsed >= STANDING_MS and current.count >= 7

    def _discard(self, events, reason):
        if self.rep:
            events.append({"type": "rep-discarded", "repId": self.rep.id, "reason": reason})
        self._clear_tracking()

    def _clear_tracking(self):
        self.reference = None
        self.rep = None
        self.onset = None
        self.shifted_at = None
        self.last_seen_at = None
        self.phase = "setup"
        self.standing = Standing()

    def update(self, landmarks, timestamp_ms, width, height, armed=True, lock_standing=None):
        timestamp = timestamp_ms
        if lock_standing is None:
            lock_standing = armed
        events = []
        checks = dict(inFrame=False, sideOn=False, standing=False, steady=False)

        def state(message, live=None, ready=False):
            progress = 1 if self.reference else min(1, self.standing.elapsed / STANDING_MS, self.standing.count / 7)
            return {"phase": self.phase, "setup": {"ready": ready, "message": message, "checks": checks, "progress": progress},
                    "live": live, "events": events, "continuitySide": None}

        last_at = self.last_at if self.last_at is not None else -inf
        if (not isfinite(timestamp) or timestamp <= last_at or not isfinite(width) or not isfinite(height)
                or not (width > 0 and height > 0)):
            return state("Waiting for the next camera frame.")
        self.last_at = timestamp
        if not armed and self.rep:
            self._discard(events, "cancelled")
        if not lock_standing:
            self.reference = None
            self.onset = None
        if self.reference and self.last_seen_at is not None and timestamp - self.last_seen_at > TRACKING_GAP_MS:
            self._discard(events, "tracking-gap")
        if self.rep and timestamp - self.rep.started_at > MAX_REP_MS:
            self._discard(events, "timeout")
        standing = self.standing
        if (lock_standing and not self.reference and not standing.missed and standing.pose
                and standing.elapsed >= STANDING_MS and standing.count >= 7 and timestamp - standing.time <= STANDING_GAP_MS):
            # Preserve the qualified reference if the user moves as the countdown begins.
            self.reference = replace(standing.pose, time=standing.time)

        preferred_side = standing.pose.side if standing.pose else None
        pose, reason, checks["inFrame"] = _inspect(landmarks, width, height, self.exercise, self.reference, preferred_side)
        checks["sideOn"] = pose is not None
        if pose is None:
            if self.rep:
                self._miss_rep(timestamp)
            elif reason == "side" or (standing.time is not None and timestamp - standing.time > STANDING_GAP_MS):
                self.standing = Standing()
            else:
                standing.missed = True
            self.shifted_at = None
            self.onset = None
            prompts = {
                "missing": "Step into view so the camera can see you.",
                "frame": ("Keep your head, hands and toes in view." if self.exercise == "push-up"
                          else "Keep your head and feet in view."),
                "small": "Move a little closer while keeping your whole body in view.",
                "side": "Turn sideways so the camera sees your profile.",
                "joints": "Keep your near arm and leg visible." if self.exercise == "push-up" else "Keep the near leg visible.",
            }
            return state(prompts[reason])

        if self.reference is None:
            checks["standing"] = _starting_position(pose, self.exercise)
            checks["steady"] = self._observe_standing(pose, timestamp)
            if checks["steady"]:
                self.phase = "ready"
                self.last_seen_at = timestamp
                if lock_standing:
                    self.reference = replace(pose, time=timestamp)
                return state("Side view ready.", self._live(pose, 0), True)
            self.phase = "setup"
            return state("Hold your starting position." if checks["standing"] else
                         "Hold your top push-up position; a slight elbow bend is okay." if self.exercise == "push-up" else
                         "Move into the starting position.")

        start = self.reference
        sample = _movement(pose, start, self.exercise, timestamp)
        if sample.shifted:
            if self.shifted_at is None:
                self.shifted_at = timestamp
            if self.rep:
                self._miss_rep(timestamp)
            if timestamp - self.shifted_at >= STANCE_CHANGE_MS:
                self._discard(events, "foot-moved")
            self.onset = None
            return state(self.rules.anchor_message)
        self.shifted_at = None
        if sample.invalid:
            if self.rep:
                self._miss_rep(timestamp)
            self.onset = None
            return state("Keep your body in a plank.")
        gap = timestamp - self.last_seen_at
        self.last_seen_at = timestamp
        checks["standing"] = checks["steady"] = sample.returned and abs(sample.range) <= self.rules.return_band
        if armed:
            if self.rep:
                self._track(sample, gap, checks["standing"], events)
            elif sample.range >= self.rules.start and sample.started:
                if self.onset:
                    self._begin(self.onset, sample, events)
                else:
                    self.onset = sample
            else:
                self.onset = None
                if checks["standing"]:
                    self.reference = replace(start, time=timestamp)
        active_messages = dict(zip(("descending", "bottom", "ascending"), self.rules.movement))
        message = active_messages.get(self.phase, "Side view ready." if checks["standing"] else "Return to your starting position.")
        return state(message, self._live(pose, sample.range), self.phase == "ready" and checks["steady"] and self.reference is not None)

    def _live(self, pose, movement_range):
        return {
            "side": pose.side, "range": round(movement_range, 3), "rangeUnit": self.rules.unit,
            "movementSpeedPerSec": round(self.rep.speed if self.rep else 0, 3),
            "finishing": bool(self.rep and self.rep.returned),
            "torsoLeanDeg": round(pose.torso_lean, 1), "shinLeanDeg": round(pose.shin_lean, 1),
            "kneeAngleDeg": round(pose.knee_angle, 1), "hipAngleDeg": round(pose.hip_angle, 1),
        }

    def _add_candidate(self, sample, events):
        self.rep.samples.append(sample)
        events.append({"type": "capture-candidate", "repId": self.rep.id, "timestampMs": sample.time,
                       "kneeAngleDeg": round(sample.pose.knee_angle, 1), "range": round(sample.range, 3)})

    def _begin(self, onset, sample, events):
        started = max(self.reference.time, onset.time - 240)
        self.rep = Rep(self.next_rep_id, started, latest=onset, peak=onset, last_at_peak=onset)
        self.next_rep_id += 1
        self.phase = "descending"
        self.onset = None
        _capture(self.rep, "start", sample, events)
        self._track(sample, sample.time - onset.time, False, events)

    def _miss_rep(self, timestamp):
        self.rep.total += 1
        self.rep.max_gap = max(self.rep.max_gap, timestamp - self.last_seen_at)
        self._interrupt_finish(timestamp)
        self.rep.latest = None

    def _interrupt_finish(self, timestamp, reset=False):
        rep = self.rep
        rep.finish_at = None
        if reset or (rep.finish_seen_at is not None and timestamp - rep.finish_seen_at > FINISH_GRACE_MS):
            rep.returned = None
            rep.finish_ms = 0
            rep.finish_seen_at = None

    def _confirmed_fast_turn(self, sample):
        rep = self.rep

        def near_peak(candidate, before):
            interval = rep.peak.time - candidate.time if before else candidate.time - rep.peak.time
            return (candidate.started and candidate.range >= max(self.rules.start, rep.peak.range * 0.3)
                    and candidate.range <= rep.peak.range - self.rules.reversal and 35 <= interval <= 250)

        return (rep.depth_samples == 1 and rep.peak.range >= self.rules.peak * 1.35
                and near_peak(sample, False) and any(near_peak(candidate, True) for candidate in rep.samples))

    def _track(self, sample, gap, standing, events):
        rep = self.rep
        rep.total += 1
        rep.valid += 1
        rep.max_gap = max(rep.max_gap, gap)
        rep.speed = (sample.range - rep.latest.range) * 1000 / (sample.time - rep.latest.time) if rep.latest else 0
        rep.latest = sample
        if not standing or self.phase != "ascending":
            self._add_candidate(sample, events)
        if self.phase != "ascending":
            rep.peak_out = max(rep.peak_out, rep.speed)
            if sample.corroborated and sample.range >= self.rules.peak:
                rep.depth_samples += 1
                if sample.range > rep.peak.range + self.rules.jitter:
                    rep.peak = rep.last_at_peak = sample
            if (sample.corroborated and rep.depth_samples and rep.peak.range - sample.range <= self.rules.reversal * 0.4
                    and sample.time - rep.peak.time >= 65):
                rep.last_at_peak = sample
                self.phase = "bottom"
            if (rep.depth_samples >= 2 or self._confirmed_fast_turn(sample)) and rep.peak.range - sample.range >= self.rules.reversal:
                self.phase = "ascending"
            elif standing and sample.time - rep.started_at >= 250:
                self._discard(events, "incomplete-descent")
                return
        if self.phase != "ascending":
            return
        rep.peak_back = max(rep.peak_back, -rep.speed)
        if rep.finish_seen_at is not None and sample.time - rep.finish_seen_at > FINISH_GRACE_MS:
            self._interrupt_finish(sample.time, True)
        if not standing:
            self._interrupt_finish(sample.time, not sample.returned or abs(sample.range) > self.rules.return_band * 2)
            return
        if rep.returned is None:
            rep.returned = sample
        if rep.finish_at is not None and sample.time - rep.finish_at <= 190:
            rep.finish_ms += sample.time - rep.finish_at
        rep.finish_at = sample.time
        rep.finish_seen_at = sample.time
        if rep.finish_ms < FINISH_MS:
            return
        if rep.valid / rep.total < 0.8:
            self._discard(events, "low-confidence")
            return
        self._complete(sample, events)

    def _complete(self, sample, events):
        rep = self.rep
        peak = rep.peak
        outward = _middle_frame(rep.samples, rep.frames[0]["timestampMs"], peak.time, peak.range)
        inward = _middle_frame(rep.samples, peak.time + 0.001, rep.returned.time, peak.range)
        if outward:
            _capture(rep, "descent", outward, events)
        _capture(rep, "bottom", peak, events)
        if inward:
            _capture(rep, "ascent", inward, events)
        _capture(rep, "finish", sample, events)
        outward_ms = peak.time - rep.started_at
        hold_ms = rep.last_at_peak.time - peak.time
        return_ms = rep.returned.time - rep.last_at_peak.time
        metrics = {
            "range": round(peak.range, 1 if self.rules.unit == "degrees" else 3),
            "rangeUnit": self.rules.unit, "outwardMs": round(outward_ms), "holdMs": round(hold_ms),
            "returnMs": round(return_ms), "durationMs": round(rep.returned.time - rep.started_at),
            "averageOutwardSpeedPerSec": round(peak.range * 1000 / max(1, outward_ms), 3),
            "averageReturnSpeedPerSec": round(max(0, peak.range - rep.returned.range) * 1000 / max(1, return_ms), 3),
            "peakOutwardSpeedPerSec": round(rep.peak_out, 3), "peakReturnSpeedPerSec": round(rep.peak_back, 3),
            "validFrameFraction": round(rep.valid / rep.total, 3), "maxTrackingGapMs": round(rep.max_gap),
        }
        events.append({"type": "rep-complete", "rep": {
            "id": rep.id, "exercise": self.exercise, "side": self.reference.side,
            "startedAtMs": rep.started_at, "returnedAtMs": rep.returned.time, "finishedAtMs": sample.time,
            "metrics": metrics, "cues": [], "frames": rep.frames,
        }})
        self.reference = None
        self.rep = None
        self.phase = "ready"
        self.standing = Standing()
        self._observe_standing(sample.pose, sample.time)

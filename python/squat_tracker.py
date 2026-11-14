"""Side-view squat tracking from normalized MediaPipe pose landmarks."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from math import atan2, degrees, exp, hypot, isfinite
from statistics import median


SIDES = {
    "left": (11, 23, 25, 27, 29, 31),
    "right": (12, 24, 26, 28, 30, 32),
}
PHASE_ORDER = ("start", "descent", "bottom", "ascent", "finish")
CALIBRATION_MS = 2000
CALIBRATION_GAP_MS = 220
STANDING_REFERENCE_MS = 450
FINISH_HOLD_MS = 500
FINISH_GRACE_MS = 250
MAX_FRAME_GAP_MS = 300
MAX_CAPTURE_GAP_MS = 400
FOOT_SHIFT_MS = 150
MAX_REP_MS = 20000


@dataclass
class Point:
    x: float
    y: float
    visibility: float


@dataclass
class Sample:
    side: str
    knee_angle: float
    hip_angle: float | None
    torso_lean: float | None
    shin_lean: float
    hip_y: float
    knee_y: float
    ankle_x: float
    ankle_y: float
    leg_length: float
    thigh_length: float
    shin_length: float
    torso_length: float | None
    heel_x: float | None = None
    heel_y: float | None = None
    toe_x: float | None = None
    toe_y: float | None = None
    time: float = 0
    speed: float = 0
    raw: Sample | None = None
    drop: float = 0
    bend: float = 0


@dataclass
class Baseline:
    side: str
    hip_y: float
    ankle_x: float
    ankle_y: float
    leg_length: float
    knee_angle: float
    thigh_length: float
    shin_length: float
    torso_length: float
    proportions: dict


@dataclass
class StandingReference:
    knee_angle: float
    hip_y: float
    ankle_x: float
    ankle_y: float
    heel_x: float | None = None
    heel_y: float | None = None
    toe_x: float | None = None
    toe_y: float | None = None
    time: float = 0


@dataclass
class Pose:
    sample: Sample | None = None
    side_on: bool = False
    shifted_foot: bool = False
    too_far: bool = False
    reason: str | None = None


@dataclass
class Rep:
    id: int
    start: StandingReference
    onset_at: float
    peak_down: float
    depth_reached_at: float | None = None
    depth_confirmed: bool = False
    bottom: Sample | None = None
    last_at_bottom: Sample | None = None
    rise_at: float | None = None
    rise_peak: float = 0
    first_standing: Sample | None = None
    finish_hold_ms: float = 0
    last_finish_sample_at: float | None = None
    last_finish_seen_at: float | None = None
    valid_frames: int = 1
    total_frames: int = 1
    max_gap: float = 0
    peak_up: float = 0
    frames: dict = field(default_factory=dict)
    samples: list = field(default_factory=list)


def _clamp(value, low, high):
    return min(high, max(low, value))


def _distance(a, b):
    return hypot(a.x - b.x, a.y - b.y)


def _joint_angle(first, joint, last):
    ax, ay = first.x - joint.x, first.y - joint.y
    bx, by = last.x - joint.x, last.y - joint.y
    cross = abs(ax * by - ay * bx)
    dot = ax * bx + ay * by
    return degrees(atan2(cross, dot))


def _lean_angle(upper, lower):
    return degrees(atan2(abs(upper.x - lower.x), lower.y - upper.y))


def _round_if_measured(value, places):
    return round(value, places) if value is not None else None


def _point_at(landmarks, index, width, height):
    if not landmarks or len(landmarks) <= index:
        return None
    point = landmarks[index]
    getter = point.get if isinstance(point, dict) else lambda name, default: getattr(point, name, default)
    x, y = getter("x", None), getter("y", None)
    visibility = getter("visibility", 1)
    if x is None or y is None or not isfinite(x) or not isfinite(y):
        return None
    return Point(x * width, y * height, 1 if visibility is None else visibility)


def _inspect_pose(landmarks, width, height, fixed_side, baseline, tracking=False, foot_anchor=None):
    joints = {
        side: [_point_at(landmarks, index, width, height) for index in indices]
        for side, indices in SIDES.items()
    }
    minimum_visibility = 0.35 if tracking else 0.55
    valid = [
        side for side, points in joints.items()
        if all(point and point.visibility >= minimum_visibility for point in points[1:4])
    ]
    if not valid or (fixed_side and fixed_side not in valid):
        return Pose(reason="joints" if landmarks else "no-pose")
    side = fixed_side or max(valid, key=lambda choice: sum(point.visibility for point in joints[choice][1:4]))
    shoulder, hip, knee, ankle, heel, toe = joints[side]
    thigh, shank = _distance(hip, knee), _distance(knee, ankle)
    if min(thigh, shank) < height * 0.035:
        return Pose(reason="joints")
    if tracking and any(not 0.5 <= ratio <= 1.6 for ratio in (
        thigh / baseline.thigh_length, shank / baseline.shin_length,
    )):
        return Pose(reason="joints")
    leg_length = thigh + shank
    margin_x = 0 if tracking else width * 0.025
    margin_y = 0 if tracking else height * 0.025

    def in_frame(point):
        return margin_x <= point.x <= width - margin_x and margin_y <= point.y <= height - margin_y

    if not all(in_frame(point) for point in (hip, knee, ankle)):
        return Pose(reason="edges")
    span_confidence = 0.55 if tracking else 0.30

    def span(joint_index):
        left, right = joints["left"][joint_index], joints["right"][joint_index]
        if left and right and min(left.visibility, right.visibility) >= span_confidence:
            return abs(left.x - right.x) / (baseline.leg_length if baseline else leg_length)
        return None

    shoulder_span, hip_span, knee_span = span(0), span(1), span(2)
    narrow_hips = hip_span is not None and hip_span <= 0.17

    def usable_shoulder(point, visibility):
        if not point or point.visibility < visibility or not in_frame(point):
            return False
        length = _distance(point, hip)
        if tracking:
            return baseline.torso_length * 0.5 <= length <= baseline.torso_length * 1.6
        return height * 0.035 <= length <= leg_length * 1.25

    near_shoulder = shoulder if usable_shoulder(shoulder, 0.30 if tracking else 0.40) else None
    other_shoulder = joints["right" if side == "left" else "left"][0]
    backup_shoulder = other_shoulder if not tracking and not near_shoulder and narrow_hips and usable_shoulder(other_shoulder, 0.55) else None
    shoulder = near_shoulder or backup_shoulder
    torso = _distance(shoulder, hip) if shoulder else None
    too_far = False
    if tracking:
        side_on = not ((hip_span or 0) > 0.39 or ((hip_span or 0) > 0.29 and ((shoulder_span or 0) > 0.38 or (knee_span or 0) > 0.32)))
    else:
        nose = _point_at(landmarks, 0, width, height)
        feet = [point for point in (heel, toe) if point and point.visibility >= 0.5]
        if not nose or nose.visibility < 0.45:
            return Pose(reason="head")
        if not feet:
            return Pose(reason="feet")
        if not shoulder:
            return Pose(reason="shoulder")
        if nose.y <= margin_y + torso * 0.16 or not all(in_frame(point) for point in (nose, *feet)):
            return Pose(reason="edges")
        if shoulder_span is not None and hip_span is not None:
            side_on = (
                (shoulder_span <= 0.35 and hip_span <= 0.26) or (narrow_hips and shoulder_span <= 0.60)
                or (shoulder_span <= 0.39 and hip_span <= 0.285 and knee_span is not None and knee_span <= 0.22)
            )
        else:
            available_span = hip_span if hip_span is not None else shoulder_span
            side_on = available_span <= 0.20 if available_span is not None else abs(nose.x - shoulder.x) / leg_length >= 0.09
        standing_height = max(ankle.y, *(point.y for point in feet)) - nose.y
        too_far = not baseline and standing_height < height * 0.38 and leg_length < height * 0.24

    heel_x, heel_y = (heel.x, heel.y) if heel and heel.visibility >= 0.55 else (None, None)
    toe_x, toe_y = (toe.x, toe.y) if toe and toe.visibility >= 0.55 else (None, None)
    shifted_foot = False
    if baseline:
        anchor = foot_anchor or baseline
        dx = (ankle.x - anchor.ankle_x) / baseline.leg_length
        dy = (ankle.y - anchor.ankle_y) / baseline.leg_length

        def corroborates_shift(current, name, shift):
            previous = getattr(anchor, name, None)
            direction = 1 if shift > 0 else -1
            return previous is not None and current is not None and (current - previous) * direction > baseline.leg_length * 0.14

        shifted_foot = (
            abs(dx) > (0.34 if tracking else 0.22)
            or (tracking and abs(dx) > 0.22 and (corroborates_shift(heel_x, "heel_x", dx) or corroborates_shift(toe_x, "toe_x", dx)))
            or abs(dy) > (0.32 if tracking else 0.15)
            or (tracking and abs(dy) > 0.18 and (corroborates_shift(heel_y, "heel_y", dy) or corroborates_shift(toe_y, "toe_y", dy)))
        )
    sample = Sample(
        side, _joint_angle(hip, knee, ankle), _joint_angle(near_shoulder, hip, knee) if near_shoulder else None,
        _lean_angle(near_shoulder, hip) if near_shoulder else None, _lean_angle(knee, ankle),
        hip.y, knee.y, ankle.x, ankle.y, leg_length, thigh, shank, torso, heel_x, heel_y, toe_x, toe_y,
    )
    return Pose(sample=sample, side_on=side_on, shifted_foot=shifted_foot, too_far=too_far)


def _make_baseline(samples):
    def mean(key):
        return sum(getattr(sample, key) for sample in samples) / len(samples)

    leg_length = mean("leg_length")
    thigh_length, shin_length, torso_length = mean("thigh_length"), mean("shin_length"), mean("torso_length")
    proportions = {
        "standingThighToShinRatio": round(thigh_length / shin_length, 3),
        "standingTorsoToLegRatio": round(torso_length / leg_length, 3),
    }
    return Baseline(
        samples[0].side, mean("hip_y"), mean("ankle_x"), mean("ankle_y"), leg_length, mean("knee_angle"),
        thigh_length, shin_length, torso_length, proportions,
    )


def _capture(rep, phase, sample, events):
    frame = {"phase": phase, "timestampMs": sample.time}
    rep.frames[phase] = frame
    events.append({"type": "capture", "repId": rep.id, **frame})


def _standing_reference(samples):
    def mean(key):
        values = [getattr(sample, key) for sample in samples if getattr(sample, key) is not None and isfinite(getattr(sample, key))]
        return sum(values) / len(values) if values else None

    keys = ("knee_angle", "hip_y", "ankle_x", "ankle_y", "heel_x", "heel_y", "toe_x", "toe_y")
    return StandingReference(*(mean(key) for key in keys))


def _hip_drop_from(sample, reference, leg_length):
    return ((sample.hip_y - sample.ankle_y) - (reference.hip_y - reference.ankle_y)) / leg_length


def _motion_candidate(rep, sample, events):
    rep.samples.append(sample)
    events.append({
        "type": "capture-candidate", "repId": rep.id, "timestampMs": sample.time,
        "kneeAngleDeg": round(sample.knee_angle, 1),
    })


def _closest_middle(samples, from_time, to_time, depth, ascending=False):
    best, error = None, float("inf")
    for sample in samples:
        progress = 1 - sample.drop / depth if ascending else sample.drop / depth
        if not from_time <= sample.time < to_time or not 0.12 <= progress <= 0.92:
            continue
        distance = abs(sample.drop - depth * 0.5)
        if distance + 1e-9 < error:
            best, error = sample, distance
    return best


def _finalize_captures(rep, finish, events):
    bottom = rep.bottom
    descent = _closest_middle(rep.samples, rep.frames["start"]["timestampMs"], bottom.time, bottom.drop)
    ascent = _closest_middle(rep.samples, bottom.time + 0.001, rep.first_standing.time, bottom.drop, ascending=True)
    if descent:
        _capture(rep, "descent", descent, events)
    _capture(rep, "bottom", bottom, events)
    if ascent:
        _capture(rep, "ascent", ascent, events)
    _capture(rep, "finish", finish, events)


def _format_rep(rep, finish, baseline):
    bottom, start = rep.bottom, rep.start
    rise = rep.last_at_bottom or bottom
    end = rep.first_standing
    descent_ms = bottom.time - start.time
    ascent_ms = end.time - rise.time
    drop = (bottom.hip_y - start.hip_y) / baseline.leg_length
    rise_distance = (bottom.hip_y - end.hip_y) / baseline.leg_length
    hip_to_knee = (bottom.hip_y - bottom.knee_y) / baseline.leg_length
    depth_label = "about level with"
    if hip_to_knee < -0.045:
        depth_label = "above"
    elif hip_to_knee > 0.045:
        depth_label = "below"
    cues = [{"kind": "observation", "code": "depth", "message": f"At the bottom, your visible hip was {depth_label} your knee."}]
    if bottom.torso_lean is not None:
        cues.append({"kind": "observation", "code": "torso", "message": f"Your torso leaned about {round(bottom.torso_lean)}° from vertical at the bottom."})
    return {
        "id": rep.id,
        "side": baseline.side,
        "startedAtMs": start.time,
        "returnedAtMs": end.time,
        "finishedAtMs": finish.time,
        "metrics": {
            "durationMs": round(end.time - start.time),
            "descentMs": round(descent_ms),
            "pauseMs": round(rise.time - bottom.time),
            "ascentMs": round(ascent_ms),
            "kneeAngleAtBottomDeg": round(bottom.knee_angle, 1),
            "hipAngleAtBottomDeg": _round_if_measured(bottom.hip_angle, 1),
            "startKneeAngleDeg": round(start.knee_angle, 1),
            "finishKneeAngleDeg": round(finish.knee_angle, 1),
            "hipDropLegLengths": round(drop, 3),
            "bottomHipToKneeLegLengths": round(hip_to_knee, 3),
            "torsoLeanAtBottomDeg": _round_if_measured(bottom.torso_lean, 1),
            "shinLeanAtBottomDeg": round(bottom.shin_lean, 1),
            "averageDescentLegLengthsPerSec": round(max(0, drop) * 1000 / max(1, descent_ms), 3),
            "averageAscentLegLengthsPerSec": round(max(0, rise_distance) * 1000 / max(1, ascent_ms), 3),
            "peakDescentLegLengthsPerSec": round(rep.peak_down, 3),
            "peakAscentLegLengthsPerSec": round(rep.peak_up, 3),
            "validFrameFraction": round(rep.valid_frames / rep.total_frames, 3),
            "maxTrackingGapMs": round(rep.max_gap),
            **baseline.proportions,
        },
        "cues": cues,
        "frames": [rep.frames[phase] for phase in PHASE_ORDER if phase in rep.frames],
    }


class SquatTracker:
    def __init__(self):
        self.reset()

    def reset(self):
        self.phase = "setup"
        self._clear_calibration_samples()
        self.baseline = None
        self.previous = None
        self.last_time = None
        self.last_valid_time = None
        self.standing_samples = []
        self.locked_standing = None
        self.locked_standing_at = None
        self.last_standing_at = None
        self.attempt = None
        self.onset_at = None
        self.ankle_shift_at = None
        self.turn_at = None
        self.next_rep_id = 1

    def update(self, landmarks, timestamp_ms, width, height, armed=True, lock_standing=None):
        if lock_standing is None:
            lock_standing = armed
        events = []
        checks = {"inFrame": False, "sideOn": False, "standing": False, "steady": False}

        def state(message, live=None, progress=0, ready=False):
            return {
                "phase": self.phase,
                "setup": {"checks": checks, "ready": ready, "message": message, "progress": progress},
                "live": live,
                "events": events,
            }

        if (not isfinite(timestamp_ms) or (self.last_time is not None and timestamp_ms <= self.last_time)
                or width <= 0 or height <= 0):
            return state("Waiting for the next camera frame.")
        previous_frame_time = self.last_time
        self.last_time = timestamp_ms
        if not armed:
            if self.attempt:
                self._discard(events, "cancelled")
            self.onset_at = None
        if self.baseline and self.last_valid_time is not None:
            max_gap = MAX_CAPTURE_GAP_MS if self.attempt and self.turn_at is None else MAX_FRAME_GAP_MS
            if timestamp_ms - self.last_valid_time > max_gap:
                self._lose_calibration(events, "tracking-gap")
        if self.attempt and timestamp_ms - self.attempt.start.time > MAX_REP_MS:
            self._lose_calibration(events, "timeout")

        if not lock_standing:
            self.locked_standing = None
            self.locked_standing_at = None
        if lock_standing and not self.locked_standing and self.standing_samples:
            self._lock_reference(previous_frame_time if previous_frame_time is not None else timestamp_ms)
        side = self.baseline.side if self.baseline else self.calibration[0].side if self.calibration else None
        tracking = bool(armed and self.baseline)
        foot_anchor = (self.attempt.start if self.attempt else self.locked_standing) if tracking else self.baseline
        pose = _inspect_pose(landmarks, width, height, side, self.baseline, tracking, foot_anchor)
        checks["inFrame"] = pose.sample is not None and not pose.too_far
        checks["sideOn"] = checks["inFrame"] and pose.side_on
        if pose.shifted_foot:
            if self.ankle_shift_at is None:
                self.ankle_shift_at = timestamp_ms
        else:
            self.ankle_shift_at = None
        # A confirmed turn cannot use the extra recovery time for hidden landmarks.
        if not tracking or checks["sideOn"]:
            self.turn_at = None
        elif pose.sample and self.turn_at is None:
            self.turn_at = timestamp_ms
        sustained_foot_shift = self.ankle_shift_at is not None and timestamp_ms - self.ankle_shift_at >= FOOT_SHIFT_MS
        if not checks["sideOn"] or pose.shifted_foot:
            message = self._invalid_pose(pose, timestamp_ms, events, tracking, sustained_foot_shift)
            return state(message, progress=1 if self.baseline else self._calibration_progress())

        raw = pose.sample
        raw.time = timestamp_ms
        sample = replace(raw, raw=raw)
        if self.attempt:
            self.attempt.max_gap = max(self.attempt.max_gap, timestamp_ms - self.last_valid_time)
        self.last_valid_time = timestamp_ms
        previous = self.previous
        self._smooth(sample)
        self.previous = sample
        if not self.baseline:
            checks["standing"] = (
                sample.knee_angle >= 145 and (sample.knee_y - sample.hip_y) / sample.leg_length >= 0.35
                and (sample.torso_lean is None or sample.torso_lean <= 25)
            )
            if checks["standing"]:
                checks["steady"] = self._calibrate(sample)
            else:
                self._interrupt_calibration(timestamp_ms)
            progress = self._calibration_progress()
            if not checks["steady"] or progress < 1 or len(self.calibration) < 8:
                message = "Hold a comfortable standing position." if checks["standing"] else "Stand tall to calibrate."
                return state(message, progress=progress)
            self.baseline = _make_baseline(self.calibration)
            self.standing_samples = [pose for pose in self.calibration if timestamp_ms - pose.time <= STANDING_REFERENCE_MS]
            if lock_standing:
                self._lock_reference(timestamp_ms)
            self._clear_calibration_samples()
            self.phase = "ready"

        baseline = self.baseline
        start = self.attempt.start if self.attempt else self.locked_standing or baseline
        hip_drop = _hip_drop_from(sample, start, baseline.leg_length)
        knee_bend = start.knee_angle - sample.knee_angle
        returned_to_standing = (knee_bend <= 15 and hip_drop <= 0.11) or (knee_bend <= 22 and hip_drop <= 0.06)
        settled = knee_bend <= 8 and hip_drop < 0.055 and abs(sample.speed) < 0.15
        ready_pose = returned_to_standing if self.locked_standing else knee_bend <= 8 and hip_drop < 0.055
        checks["standing"] = ready_pose if self.phase == "ready" else returned_to_standing
        checks["steady"] = ready_pose and abs(sample.speed) < 0.15
        if not lock_standing and not self.attempt:
            self._remember_standing(sample, settled)
        if settled and not self.attempt:
            self.last_standing_at = sample.time
        if not armed and not settled:
            self.last_standing_at = None
        if armed:
            movement = replace(raw, drop=_hip_drop_from(raw, start, baseline.leg_length), bend=start.knee_angle - raw.knee_angle)
            self._track_rep(sample, movement, start, returned_to_standing, settled, previous.raw if previous else None, events)

        live = {
            "side": sample.side,
            "kneeAngleDeg": round(sample.knee_angle, 1),
            "hipAngleDeg": _round_if_measured(sample.hip_angle, 1),
            "standingKneeAngleDeg": round(start.knee_angle, 1),
            "hipDropRatio": round(hip_drop, 3),
            "hipToKneeRatio": round((sample.hip_y - sample.knee_y) / baseline.leg_length, 3),
            "torsoLeanDeg": _round_if_measured(sample.torso_lean, 1),
            "shinLeanDeg": round(sample.shin_lean, 1),
            "hipSpeedLegLengthsPerSec": round(sample.speed, 3),
            "finishing": self.phase == "ascending" and bool(self.attempt and self.attempt.first_standing),
            **baseline.proportions,
        }
        messages = {
            "setup": "Stand tall to recalibrate.",
            "ready": "Side view ready." if checks["standing"] else "Stand tall before starting the next rep.",
            "descending": "Lower through your comfortable range.",
            "bottom": "Rise when you’re ready.",
            "ascending": "Return to your standing position.",
        }
        return state(messages[self.phase], live, 1 if self.baseline else 0, self.phase == "ready" and checks["steady"])

    def _invalid_pose(self, pose, timestamp_ms, events, tracking, sustained_foot_shift):
        self.previous = None
        self.onset_at = None
        if not self.baseline:
            self._interrupt_calibration(timestamp_ms)
        if self.attempt:
            self.attempt.total_frames += 1
            self.attempt.max_gap = max(self.attempt.max_gap, timestamp_ms - self.last_valid_time)
            self.attempt.rise_at = None
            self.attempt.rise_peak = 0
            self._interrupt_finish(self.attempt, timestamp_ms)
            if not self.attempt.depth_confirmed:
                self.attempt.depth_reached_at = None
        elif not tracking:
            self.last_standing_at = None
            self.standing_samples = []
        if sustained_foot_shift:
            self._lose_calibration(events, "foot-moved")
            return "Stand still to set your new position."
        if pose.shifted_foot:
            return "Keep your foot position steady."
        if pose.too_far:
            return "Move a little closer while keeping your head and feet in frame."
        messages = {
            "no-pose": "Step into view so the camera can see you.",
            "joints": "Keep your near hip, knee and ankle visible.",
            "shoulder": "Keep a shoulder visible while you set up.",
            "head": "Keep your head in frame and look straight ahead.",
            "feet": "Show your whole feet, including your heels.",
            "edges": "Leave a little space around your head and feet.",
        }
        return messages.get(pose.reason, "Turn sideways so the camera sees your profile.")

    def _smooth(self, sample):
        previous = self.previous
        if not previous or sample.side != previous.side or sample.time - previous.time > MAX_FRAME_GAP_MS:
            return
        interval = sample.time - previous.time
        raw = sample.raw
        leg_length = self.baseline.leg_length if self.baseline else raw.leg_length
        raw_hip_rate = _hip_drop_from(raw, previous.raw, leg_length) * 1000 / interval
        raw_knee_rate = (previous.raw.knee_angle - raw.knee_angle) * 1000 / interval
        agrees = raw_hip_rate * raw_knee_rate > 0
        motion = _clamp(min(abs(raw_hip_rate) / 0.48, abs(raw_knee_rate) / 90), 0, 1) if agrees else 0
        blend = 1 - exp(-interval / (88 - 74 * motion))
        for key in ("hip_y", "knee_y", "knee_angle", "hip_angle", "torso_lean", "shin_lean"):
            value, old = getattr(sample, key), getattr(previous, key)
            if value is not None and old is not None:
                setattr(sample, key, old + (value - old) * blend)
        if self.baseline:
            speed = (sample.hip_y - previous.hip_y) * 1000 / (interval * self.baseline.leg_length)
            sample.speed = previous.speed + (_clamp(speed, -12, 12) - previous.speed) * blend

    def _calibrate(self, sample):
        latest = self.calibration[-1] if self.calibration else None
        if latest and (sample.side != latest.side or sample.time - latest.time > CALIBRATION_GAP_MS):
            self._clear_calibration_samples()
        if self.calibration:
            recent = [pose for pose in self.calibration if sample.time - pose.time <= STANDING_REFERENCE_MS]
            hip_height = sample.ankle_y - sample.hip_y
            if (abs(hip_height - median(pose.ankle_y - pose.hip_y for pose in recent)) > sample.leg_length * 0.065
                    or abs(sample.ankle_x - median(pose.ankle_x for pose in recent)) > sample.leg_length * 0.075
                    or abs(sample.knee_angle - median(pose.knee_angle for pose in recent)) > 11):
                self._interrupt_calibration(sample.time)
                return False
            if not self.calibration_interrupted:
                self.calibration_observed_ms += sample.time - latest.time
        self.calibration_interrupted = False
        self.calibration.append(sample)
        return len(self.calibration) > 1

    def _calibration_progress(self):
        return min(1, self.calibration_observed_ms / CALIBRATION_MS)

    def _clear_calibration_samples(self):
        self.calibration = []
        self.calibration_observed_ms = 0
        self.calibration_interrupted = False

    def _interrupt_calibration(self, timestamp_ms):
        if self.calibration and timestamp_ms - self.calibration[-1].time > CALIBRATION_GAP_MS:
            self._clear_calibration_samples()
        else:
            self.calibration_interrupted = True

    def _remember_standing(self, sample, settled):
        self.standing_samples = [pose for pose in self.standing_samples if sample.time - pose.time <= STANDING_REFERENCE_MS]
        if settled:
            self.standing_samples.append(sample)

    def _lock_reference(self, timestamp_ms):
        self.locked_standing = _standing_reference(self.standing_samples)
        self.locked_standing_at = timestamp_ms

    def _track_rep(self, sample, movement, start, standing, settled, previous_raw, events):
        knee_bend, hip_drop = movement.bend, movement.drop
        if not self.attempt:
            if self.last_standing_at is not None and knee_bend >= 8 and hip_drop >= 0.022:
                if self.onset_at is None:
                    self.onset_at = sample.time
                decisive = (
                    previous_raw and knee_bend >= 14 and hip_drop >= 0.045
                    and previous_raw.knee_angle - movement.knee_angle >= 4
                    and _hip_drop_from(movement, previous_raw, self.baseline.leg_length) >= 0.015
                )
                if decisive or sample.time - self.onset_at >= 35:
                    self._start_rep(sample, start, events)
                    _motion_candidate(self.attempt, movement, events)
                    self._observe_depth(self.attempt, movement)
            else:
                self.onset_at = None
            return

        rep = self.attempt
        rep.total_frames += 1
        rep.valid_frames += 1
        if not rep.first_standing and (not standing or self.phase != "ascending"):
            _motion_candidate(rep, movement, events)
        if self.phase in ("descending", "bottom"):
            rep.peak_down = max(rep.peak_down, sample.speed)
            self._observe_depth(rep, movement)
            if not rep.depth_confirmed and settled and sample.time - rep.onset_at > 250:
                self._discard(events, "incomplete-descent")
                return
            if not rep.depth_confirmed or not rep.bottom:
                return
            rise_hip, rise_knee = rep.bottom.drop - hip_drop, rep.bottom.bend - knee_bend
            if rise_hip <= 0.012 and abs(rise_knee) < 5:
                rep.last_at_bottom = movement
                if sample.time - rep.bottom.time >= 85 and abs(sample.speed) < 0.12:
                    self.phase = "bottom"
            if rise_hip >= 0.018 and rise_knee >= 6:
                if rep.rise_at is None:
                    rep.rise_at = sample.time
                rep.rise_peak = max(rep.rise_peak, -sample.speed)
                if (rise_hip >= 0.055 and rise_knee >= 12) or sample.time - rep.rise_at >= 35:
                    self.phase = "ascending"
                    rep.peak_up = rep.rise_peak
            else:
                rep.rise_at = None
                rep.rise_peak = 0
        if self.phase != "ascending":
            return

        rep.peak_up = max(rep.peak_up, -sample.speed)
        if rep.bottom.drop - hip_drop < -0.045:
            self._discard(events, "second-descent")
            return
        if not self._confirm_finish(rep, sample, knee_bend, hip_drop, standing):
            return
        if rep.valid_frames / rep.total_frames < 0.85:
            self._discard(events, "low-confidence")
            return
        _finalize_captures(rep, sample, events)
        events.append({"type": "rep-complete", "rep": _format_rep(rep, sample, self.baseline)})
        self.attempt = None
        self.phase = "ready"
        self.last_standing_at = sample.time if settled else None
        self.onset_at = None

    def _observe_depth(self, rep, movement):
        if movement.bend >= 24 and movement.drop >= 0.07:
            if rep.depth_reached_at is None:
                rep.depth_reached_at = movement.time
            if movement.time - rep.depth_reached_at >= 55:
                rep.depth_confirmed = True
            if not rep.bottom or movement.drop + 0.0015 * movement.bend > rep.bottom.drop + 0.0015 * rep.bottom.bend + 0.004:
                rep.bottom = rep.last_at_bottom = movement
                rep.rise_at = None
                rep.rise_peak = 0
        elif not rep.depth_confirmed:
            rep.depth_reached_at = None
        # A brief bottom can occupy one sample, but neighboring motion must agree.
        if not rep.depth_confirmed and rep.bottom and rep.bottom.bend >= 32 and rep.bottom.drop >= 0.11:
            rep.depth_confirmed = any(
                25 <= abs(candidate.time - rep.bottom.time) <= 250
                and candidate.bend >= 10 and candidate.drop >= 0.023
                for candidate in rep.samples
            )

    def _interrupt_finish(self, rep, timestamp_ms, reset=False):
        rep.last_finish_sample_at = None
        if reset or (rep.last_finish_seen_at is not None and timestamp_ms - rep.last_finish_seen_at > FINISH_GRACE_MS):
            rep.first_standing = None
            rep.finish_hold_ms = 0
            rep.last_finish_seen_at = None

    def _confirm_finish(self, rep, sample, knee_bend, hip_drop, standing):
        if rep.last_finish_seen_at is not None and sample.time - rep.last_finish_seen_at > FINISH_GRACE_MS:
            self._interrupt_finish(rep, sample.time, reset=True)
        near_standing = standing or (rep.first_standing and knee_bend <= 22 and hip_drop <= 0.15)
        if not near_standing:
            self._interrupt_finish(rep, sample.time, reset=knee_bend > 30 or hip_drop > 0.22)
            return False
        if rep.first_standing is None:
            rep.first_standing = sample
        if rep.last_finish_sample_at is not None and sample.time - rep.last_finish_sample_at <= 150:
            rep.finish_hold_ms += sample.time - rep.last_finish_sample_at
        rep.last_finish_sample_at = sample.time
        rep.last_finish_seen_at = sample.time
        return rep.finish_hold_ms >= FINISH_HOLD_MS

    def _start_rep(self, sample, start, events):
        locked_at = self.locked_standing_at if self.locked_standing_at is not None else float("-inf")
        time = max(self.last_standing_at, self.onset_at - 350, locked_at)
        if isinstance(start, StandingReference):
            reference = replace(start, time=time)
        else:
            reference = StandingReference(start.knee_angle, start.hip_y, start.ankle_x, start.ankle_y, time=time)
        rep = Rep(self.next_rep_id, reference, self.onset_at, max(0, sample.speed))
        self.next_rep_id += 1
        self.phase = "descending"
        self.attempt = rep
        _capture(rep, "start", sample, events)

    def _discard(self, events, reason):
        if self.attempt:
            events.append({"type": "rep-discarded", "repId": self.attempt.id, "reason": reason})
        self.attempt = None
        self.phase = "ready" if self.baseline else "setup"
        self.last_standing_at = None
        self.onset_at = None

    def _lose_calibration(self, events, reason):
        self.baseline = None
        self.previous = None
        self.last_valid_time = None
        self._clear_calibration_samples()
        self.standing_samples = []
        self.locked_standing = None
        self.locked_standing_at = None
        self.ankle_shift_at = None
        self.turn_at = None
        self._discard(events, reason)

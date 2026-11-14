"""Side-view squat tracking from normalized MediaPipe pose landmarks."""

from dataclasses import dataclass, field
from math import atan2, degrees, exp, hypot, isfinite


SIDES = {
    "left": (11, 23, 25, 27, 29, 31),
    "right": (12, 24, 26, 28, 30, 32),
}
PHASE_ORDER = ("start", "descent", "bottom", "ascent", "finish")
CALIBRATION_MS = 2000
MAX_FRAME_GAP_MS = 300
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
    hip_angle: float
    torso_lean: float
    shin_lean: float
    hip_y: float
    knee_y: float
    ankle_x: float
    leg_length: float
    thigh_length: float
    shin_length: float
    torso_length: float
    time: float = 0
    speed: float = 0


@dataclass
class Baseline:
    side: str
    hip_y: float
    ankle_x: float
    leg_length: float
    knee_angle: float
    proportions: dict


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
    start: Sample
    onset_at: float
    peak_down: float
    depth_reached_at: float | None = None
    depth_confirmed: bool = False
    bottom: Sample | None = None
    last_at_bottom: Sample | None = None
    rise_at: float | None = None
    rise_peak: float = 0
    first_standing: Sample | None = None
    valid_frames: int = 1
    total_frames: int = 1
    max_gap: float = 0
    peak_up: float = 0
    frames: dict = field(default_factory=dict)


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


def _inspect_pose(landmarks, width, height, fixed_side, baseline):
    joints = {
        side: [_point_at(landmarks, index, width, height) for index in indices]
        for side, indices in SIDES.items()
    }
    valid = [
        side for side, points in joints.items()
        if all(point and point.visibility >= 0.55 for point in points[:4])
    ]
    if not valid or (fixed_side and fixed_side not in valid):
        return Pose(reason="joints" if landmarks else "no-pose")
    side = fixed_side or max(valid, key=lambda choice: sum(point.visibility for point in joints[choice][:4]))
    shoulder, hip, knee, ankle, heel, toe = joints[side]
    thigh, shank, torso = _distance(hip, knee), _distance(knee, ankle), _distance(shoulder, hip)
    if min(thigh, shank, torso) < height * 0.035:
        return Pose(reason="joints")
    leg_length = thigh + shank
    nose = _point_at(landmarks, 0, width, height)
    if not nose or nose.visibility < 0.45:
        return Pose(reason="head")
    feet = [point for point in (heel, toe) if point and point.visibility >= 0.5]
    if not feet:
        return Pose(reason="feet")

    margin_x, margin_y = width * 0.025, height * 0.025
    if nose.y <= margin_y + torso * 0.16 or any(
        not (margin_x <= point.x <= width - margin_x and margin_y <= point.y <= height - margin_y)
        for point in (shoulder, hip, knee, ankle, nose, *feet)
    ):
        return Pose(reason="edges")

    spans = []
    for joint_index in (0, 1):
        left, right = joints["left"][joint_index], joints["right"][joint_index]
        if left and right and min(left.visibility, right.visibility) >= 0.30:
            spans.append(abs(left.x - right.x) / leg_length)
    head_in_profile = abs(nose.x - shoulder.x) / leg_length >= 0.09
    side_on = max(spans) <= (0.22 if baseline else 0.18) if spans else head_in_profile
    standing_height = max(ankle.y, *(point.y for point in feet)) - nose.y
    shifted_foot = bool(baseline and abs(ankle.x - baseline.ankle_x) / baseline.leg_length > 0.15)
    return Pose(
        sample=Sample(
            side, _joint_angle(hip, knee, ankle), _joint_angle(shoulder, hip, knee), _lean_angle(shoulder, hip),
            _lean_angle(knee, ankle), hip.y, knee.y, ankle.x, leg_length, thigh, shank, torso,
        ),
        side_on=side_on,
        shifted_foot=shifted_foot,
        too_far=not baseline and standing_height < height * 0.38 and leg_length < height * 0.24,
    )


def _make_baseline(samples):
    def mean(key):
        return sum(getattr(sample, key) for sample in samples) / len(samples)

    leg_length = mean("leg_length")
    proportions = {
        "standingThighToShinRatio": round(mean("thigh_length") / mean("shin_length"), 3),
        "standingTorsoToLegRatio": round(mean("torso_length") / leg_length, 3),
    }
    return Baseline(samples[0].side, mean("hip_y"), mean("ankle_x"), leg_length, mean("knee_angle"), proportions)


def _capture(rep, phase, sample, events):
    frame = {"phase": phase, "timestampMs": sample.time}
    rep.frames[phase] = frame
    events.append({"type": "capture", "repId": rep.id, **frame})


def _is_deeper(sample, previous, baseline):
    hip_change = (sample.hip_y - previous.hip_y) / baseline.leg_length
    knee_change = previous.knee_angle - sample.knee_angle
    return hip_change > 0.007 or (hip_change >= -0.007 and knee_change > 2)


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
            "hipAngleAtBottomDeg": round(bottom.hip_angle, 1),
            "startKneeAngleDeg": round(start.knee_angle, 1),
            "finishKneeAngleDeg": round(finish.knee_angle, 1),
            "hipDropLegLengths": round(drop, 3),
            "bottomHipToKneeLegLengths": round(hip_to_knee, 3),
            "torsoLeanAtBottomDeg": round(bottom.torso_lean, 1),
            "shinLeanAtBottomDeg": round(bottom.shin_lean, 1),
            "averageDescentLegLengthsPerSec": round(max(0, drop) * 1000 / max(1, descent_ms), 3),
            "averageAscentLegLengthsPerSec": round(max(0, rise_distance) * 1000 / max(1, ascent_ms), 3),
            "peakDescentLegLengthsPerSec": round(rep.peak_down, 3),
            "peakAscentLegLengthsPerSec": round(rep.peak_up, 3),
            "validFrameFraction": round(rep.valid_frames / rep.total_frames, 3),
            "maxTrackingGapMs": round(rep.max_gap),
            **baseline.proportions,
        },
        "cues": [
            {"kind": "observation", "code": "depth", "message": f"At the bottom, your visible hip was {depth_label} your knee."},
            {"kind": "observation", "code": "torso", "message": f"Your torso leaned about {round(bottom.torso_lean)}° from vertical at the bottom."},
        ],
        "frames": [rep.frames[phase] for phase in PHASE_ORDER if phase in rep.frames],
    }


class SquatTracker:
    def __init__(self):
        self.reset()

    def reset(self):
        self.phase = "setup"
        self.calibration = []
        self.baseline = None
        self.previous = None
        self.last_time = None
        self.last_valid_time = None
        self.last_standing = None
        self.attempt = None
        self.onset_at = None
        self.next_rep_id = 1

    def update(self, landmarks, timestamp_ms, width, height, armed=True):
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
        self.last_time = timestamp_ms
        if not armed:
            if self.attempt:
                self._discard(events, "cancelled")
            self.onset_at = None
        if self.baseline and self.last_valid_time is not None and timestamp_ms - self.last_valid_time > MAX_FRAME_GAP_MS:
            self._lose_calibration(events, "tracking-gap")
        if self.attempt and timestamp_ms - self.attempt.start.time > MAX_REP_MS:
            self._lose_calibration(events, "timeout")

        side = self.baseline.side if self.baseline else self.calibration[0].side if self.calibration else None
        pose = _inspect_pose(landmarks, width, height, side, self.baseline)
        checks["inFrame"] = pose.sample is not None and not pose.too_far
        checks["sideOn"] = checks["inFrame"] and pose.side_on
        if not checks["sideOn"] or pose.shifted_foot:
            return state(self._invalid_pose(pose, timestamp_ms, events))

        sample = pose.sample
        sample.time = timestamp_ms
        if self.attempt:
            self.attempt.max_gap = max(self.attempt.max_gap, timestamp_ms - self.last_valid_time)
        self.last_valid_time = timestamp_ms
        self._smooth(sample)
        self.previous = sample
        checks["standing"] = sample.knee_angle >= (self.baseline.knee_angle if self.baseline else 168) - 15 and (
            not self.baseline or (sample.hip_y - self.baseline.hip_y) / self.baseline.leg_length <= 0.09
        )
        if not self.baseline:
            if checks["standing"]:
                checks["steady"] = self._calibrate(sample)
            else:
                self.calibration = []
            first = self.calibration[0].time if self.calibration else timestamp_ms
            progress = _clamp((timestamp_ms - first) / CALIBRATION_MS, 0, 1)
            if progress < 1 or len(self.calibration) < 8:
                message = "Hold a comfortable standing position." if checks["standing"] else "Stand tall to calibrate."
                return state(message, progress=progress)
            self.baseline = _make_baseline(self.calibration)
            self.calibration = []
            self.phase = "ready"

        baseline = self.baseline
        live = {
            "side": sample.side,
            "kneeAngleDeg": round(sample.knee_angle, 1),
            "hipAngleDeg": round(sample.hip_angle, 1),
            "standingKneeAngleDeg": round(baseline.knee_angle, 1),
            "hipDropRatio": round((sample.hip_y - baseline.hip_y) / baseline.leg_length, 3),
            "hipToKneeRatio": round((sample.hip_y - sample.knee_y) / baseline.leg_length, 3),
            "torsoLeanDeg": round(sample.torso_lean, 1),
            "shinLeanDeg": round(sample.shin_lean, 1),
            "hipSpeedLegLengthsPerSec": round(sample.speed, 3),
            **baseline.proportions,
        }
        returned_to_standing = checks["standing"]
        start_pose = returned_to_standing and baseline.knee_angle - sample.knee_angle <= 8 and live["hipDropRatio"] < 0.045
        checks["steady"] = start_pose and abs(sample.speed) < 0.15
        if armed:
            self._track_rep(sample, live, returned_to_standing, start_pose, events)
        else:
            self.last_standing = sample if start_pose else None
        if self.phase == "ready":
            checks["standing"] = start_pose
        messages = {
            "setup": "Stand tall to recalibrate.",
            "ready": "Side view ready." if checks["standing"] else "Stand tall before starting the next rep.",
            "descending": "Lower through your comfortable range.",
            "bottom": "Rise when you’re ready.",
            "ascending": "Return to your standing position.",
        }
        return state(messages[self.phase], live, 1 if self.baseline else 0, self.phase == "ready" and checks["steady"])

    def _invalid_pose(self, pose, timestamp_ms, events):
        self.previous = None
        self.onset_at = None
        self.calibration = []
        if self.attempt:
            self.attempt.total_frames += 1
            self.attempt.max_gap = max(self.attempt.max_gap, timestamp_ms - self.last_valid_time)
            self.attempt.rise_at = None
            self.attempt.rise_peak = 0
            self.attempt.first_standing = None
            if not self.attempt.depth_confirmed:
                self.attempt.depth_reached_at = None
        else:
            self.last_standing = None
        if pose.shifted_foot:
            self._lose_calibration(events, "foot-moved")
            return "Stand still to set your new position."
        if pose.too_far:
            return "Move a little closer while keeping your head and feet in frame."
        messages = {
            "no-pose": "Step into view so the camera can see you.",
            "joints": "Keep your near shoulder, hip, knee and ankle visible.",
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
        blend = 1 - exp(-interval / 48)
        for key in ("hip_y", "knee_y", "knee_angle", "hip_angle", "torso_lean", "shin_lean"):
            old = getattr(previous, key)
            setattr(sample, key, old + (getattr(sample, key) - old) * blend)
        if self.baseline:
            speed = (sample.hip_y - previous.hip_y) * 1000 / (interval * self.baseline.leg_length)
            sample.speed = previous.speed + (_clamp(speed, -4, 4) - previous.speed) * blend

    def _calibrate(self, sample):
        if self.calibration:
            first, latest = self.calibration[0], self.calibration[-1]
            if (sample.side != first.side or sample.time - latest.time > MAX_FRAME_GAP_MS
                    or abs(sample.hip_y - first.hip_y) > first.leg_length * 0.035
                    or abs(sample.ankle_x - first.ankle_x) > first.leg_length * 0.045
                    or abs(sample.knee_angle - first.knee_angle) > 7):
                self.calibration = []
        self.calibration.append(sample)
        return len(self.calibration) > 1

    def _track_rep(self, sample, live, standing, start_pose, events):
        knee_bend = self.baseline.knee_angle - sample.knee_angle
        hip_drop = live["hipDropRatio"]
        if not self.attempt:
            if start_pose:
                self.last_standing = sample
                self.onset_at = None
            elif self.last_standing and knee_bend >= 9 and hip_drop >= 0.026:
                if self.onset_at is None:
                    self.onset_at = sample.time
                if sample.time - self.onset_at >= 85:
                    self._start_rep(sample, events)
            else:
                self.onset_at = None
            return

        rep = self.attempt
        rep.total_frames += 1
        rep.valid_frames += 1
        if self.phase in ("descending", "bottom"):
            self._track_bottom(rep, sample, knee_bend, hip_drop, standing, events)
        if self.phase != "ascending":
            return

        rep.peak_up = max(rep.peak_up, -sample.speed)
        rise = rep.bottom.hip_y - sample.hip_y
        if "ascent" not in rep.frames and rise >= (rep.bottom.hip_y - rep.start.hip_y) * 0.38:
            _capture(rep, "ascent", sample, events)
        if rise / self.baseline.leg_length < -0.045:
            self._discard(events, "second-descent")
            return
        if not standing:
            rep.first_standing = None
            return
        if rep.first_standing is None:
            rep.first_standing = sample
        if sample.time - rep.first_standing.time < 500:
            return
        if rep.valid_frames / rep.total_frames < 0.9:
            self._discard(events, "low-confidence")
            return
        if "ascent" not in rep.frames:
            self._discard(events, "incomplete-ascent")
            return
        _capture(rep, "finish", sample, events)
        events.append({"type": "rep-complete", "rep": _format_rep(rep, sample, self.baseline)})
        self.attempt = None
        self.phase = "ready"
        self.last_standing = sample
        self.onset_at = None

    def _track_bottom(self, rep, sample, knee_bend, hip_drop, standing, events):
        rep.peak_down = max(rep.peak_down, sample.speed)
        if not rep.depth_confirmed and (knee_bend < 20 or hip_drop < 0.055):
            rep.depth_reached_at = None
        if knee_bend >= 24 and hip_drop >= 0.07 and rep.depth_reached_at is None:
            rep.depth_reached_at = sample.time
        if rep.depth_reached_at is not None and "descent" not in rep.frames:
            _capture(rep, "descent", sample, events)
        if rep.depth_reached_at is not None and sample.time - rep.depth_reached_at >= 145:
            rep.depth_confirmed = True
        # Keep depth candidates while the tracker confirms sustained movement.
        if rep.depth_reached_at is not None and sample.time > rep.frames["descent"]["timestampMs"] and not standing:
            if not rep.bottom or _is_deeper(sample, rep.bottom, self.baseline):
                rep.bottom = sample
                rep.last_at_bottom = sample
                _capture(rep, "bottom", sample, events)
        if not rep.depth_confirmed or not rep.bottom:
            if standing and sample.time - rep.onset_at > 250:
                self._discard(events, "incomplete-descent")
            return
        if self.phase == "descending" and (sample.speed < 0.09 or sample.time - rep.bottom.time > 100):
            self.phase = "bottom"
        rise_hip = (rep.bottom.hip_y - sample.hip_y) / self.baseline.leg_length
        rise_knee = sample.knee_angle - rep.bottom.knee_angle
        if rise_hip <= 0.012 and abs(rise_knee) < 5:
            rep.last_at_bottom = sample
        if rise_hip >= 0.018 and rise_knee >= 8:
            if rep.rise_at is None:
                rep.rise_at = sample.time
            rep.rise_peak = max(rep.rise_peak, -sample.speed)
            if sample.time - rep.rise_at >= 180:
                self.phase = "ascending"
                rep.peak_up = rep.rise_peak
        else:
            rep.rise_at = None
            rep.rise_peak = 0

    def _start_rep(self, sample, events):
        rep = Rep(self.next_rep_id, self.last_standing, self.onset_at, max(0, sample.speed))
        self.next_rep_id += 1
        self.phase = "descending"
        self.attempt = rep
        _capture(rep, "start", sample, events)

    def _discard(self, events, reason):
        if self.attempt:
            events.append({"type": "rep-discarded", "repId": self.attempt.id, "reason": reason})
        self.attempt = None
        self.phase = "ready" if self.baseline else "setup"
        self.last_standing = None
        self.onset_at = None

    def _lose_calibration(self, events, reason):
        self.baseline = None
        self.previous = None
        self.last_valid_time = None
        self.calibration = []
        self._discard(events, reason)

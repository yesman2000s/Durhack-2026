"""Illustrative side-view poses for the desktop guide and optional training overlay."""

from dataclasses import dataclass
from functools import cache
from math import cos, exp, hypot, isfinite, pi, radians, sin, sqrt
from statistics import median


CONNECTIONS = (
    ("nose", "shoulder"), ("shoulder", "elbow"), ("elbow", "wrist"), ("wrist", "hand"),
    ("shoulder", "hip"), ("hip", "knee"), ("knee", "ankle"),
    ("ankle", "heel"), ("heel", "toe"),
    ("hip", "farKnee"), ("farKnee", "farAnkle"),
    ("farAnkle", "farHeel"), ("farHeel", "farToe"),
)
OUTWARD_MS = 2100
HOLD_MS = 300
RETURN_MS = 1650
END_HOLD_MS = 600
FOOT_X_INDICES = (27, 29, 31)


def _from_vertical(point, length, radians):
    return point[0] + length * sin(radians), point[1] - length * cos(radians)


def _standing_raise(exercise, progress):
    heel_raise = exercise == "heel-raise"
    rise = progress if heel_raise else 0
    lift = 0 if heel_raise else progress
    origin = (-32, -13) if heel_raise else (0, 0)
    stance_ankle = ((origin[0] + 7 * rise) / 198, (origin[1] - 29 * rise) / 198)
    stance_knee = _from_vertical(stance_ankle, 94 / 198, radians(1))
    hip = _from_vertical(stance_knee, 104 / 198, radians(-1))
    shoulder = _from_vertical(hip, 114 / 198, radians(4))
    nose = _from_vertical(shoulder, 46 / 198, radians(4))
    elbow = _from_vertical(shoulder, 62 / 198, radians(181 + 20 * lift))
    wrist = _from_vertical(elbow, 56 / 198, radians(172 + 20 * lift))
    knee = _from_vertical(hip, 104 / 198, radians(179 - 81 * lift))
    ankle = _from_vertical(knee, 94 / 198, radians(181 + 19 * lift))
    heel = (ankle[0] - 12 / 198, ankle[1] + (13 - 4 * rise) / 198)
    toe = (0, 0) if heel_raise else (ankle[0] + 32 / 198, ankle[1] + (13 + 4 * lift) / 198)
    far_ankle, far_knee = (ankle, knee) if heel_raise else (stance_ankle, stance_knee)
    far_heel = heel if heel_raise else (far_ankle[0] - 12 / 198, far_ankle[1] + 13 / 198)
    far_toe = toe if heel_raise else (far_ankle[0] + 32 / 198, far_ankle[1] + 13 / 198)
    return {
        "nose": nose, "shoulder": shoulder, "elbow": elbow, "wrist": wrist, "hip": hip,
        "knee": knee, "ankle": ankle, "heel": heel, "toe": toe,
        "farKnee": (far_knee[0] - 8 / 198, far_knee[1]),
        "farAnkle": (far_ankle[0] - 8 / 198, far_ankle[1]),
        "farHeel": (far_heel[0] - 8 / 198, far_heel[1]),
        "farToe": (far_toe[0] - 8 / 198, far_toe[1]),
    }


def guide_joints(exercise, progress, variant="bodyweight"):
    """Return local, pixel-isotropic joints measured in projected leg lengths."""
    if exercise in ("knee-raise", "heel-raise"):
        return _standing_raise(exercise, progress)
    if exercise == "push-up":
        toe = (0, 0)
        ankle, heel, wrist = (-13 / 198, -18 / 198), (-27 / 198, -24 / 198), (276 / 198, -11 / 198)
        lean = (22 - 14 * progress) * pi / 180
        body_angle = pi / 2 - lean
        knee = _from_vertical(ankle, 94 / 198, body_angle)
        hip = _from_vertical(knee, 104 / 198, body_angle)
        shoulder = _from_vertical(hip, 114 / 198, body_angle)
        dx, dy = wrist[0] - shoulder[0], wrist[1] - shoulder[1]
        reach = hypot(dx, dy)
        upper_arm, forearm = 65 / 198, 60 / 198
        projected = (upper_arm ** 2 - forearm ** 2 + reach ** 2) / (2 * reach)
        offset = sqrt(max(0, upper_arm ** 2 - projected ** 2))
        elbow = (shoulder[0] + (dx * projected - dy * offset) / reach,
                 shoulder[1] + (dy * projected + dx * offset) / reach)
        nose = _from_vertical(shoulder, 47 / 198, body_angle - 2 * pi / 180)
    else:
        ankle = (0.0, 0.0)
        knee = _from_vertical(ankle, 0.48, (2 + 20 * progress) * pi / 180)
        hip = _from_vertical(knee, 0.52, -progress * pi * 0.44)
        shoulder = _from_vertical(hip, 0.60, (2 + 35 * progress) * pi / 180)
        nose = _from_vertical(shoulder, 0.22, 0.30)
        elbow, wrist = (shoulder[0] + 0.21, shoulder[1] + 0.10), (shoulder[0] + 0.42, shoulder[1] + 0.12)
        if variant == "barbell":
            elbow = (shoulder[0] - 0.18, shoulder[1] + 0.19)
            wrist = (shoulder[0] + 0.05, shoulder[1])
        heel, toe = (-0.06, 0.07), (0.17, 0.07)

    pose = dict(nose=nose, shoulder=shoulder, elbow=elbow, wrist=wrist, hip=hip, knee=knee,
                ankle=ankle, heel=heel, toe=toe)
    if exercise == "push-up":
        pose["hand"] = (wrist[0] + 22 / 198, wrist[1] + 12 / 198)
    if exercise == "squat" and variant == "barbell":
        pose["bar"] = (shoulder[0] - 0.07, shoulder[1] + 0.04)
    return pose


def guide_progress(elapsed_ms):
    movement_ms = OUTWARD_MS + HOLD_MS + RETURN_MS
    if elapsed_ms < 0 or elapsed_ms > movement_ms + END_HOLD_MS:
        return None
    if elapsed_ms >= movement_ms:
        return 0
    if elapsed_ms < OUTWARD_MS:
        return (1 - cos(pi * elapsed_ms / OUTWARD_MS)) / 2
    if elapsed_ms < OUTWARD_MS + HOLD_MS:
        return 1
    return (1 + cos(pi * (elapsed_ms - OUTWARD_MS - HOLD_MS) / RETURN_MS)) / 2


def training_range(exercise):
    return 0.72 if exercise == "push-up" else 0.60


@cache
def guide_body_bounds(exercise, variant):
    extent = training_range(exercise)
    positions = [point for progress in (0, extent / 4, extent / 2, extent * 0.75, extent)
                 for point in guide_joints(exercise, progress, variant).values()]
    # Include the head, tapered limbs, offset far side and barbell plates, not only joints.
    body_margin = 0.14
    return (min(x for x, _ in positions) - body_margin, max(x for x, _ in positions) + body_margin,
            min(y for _, y in positions) - body_margin, max(y for _, y in positions) + body_margin)


def guide_horizontal_bounds(exercise, variant):
    return guide_body_bounds(exercise, variant)[:2]


def _confidence(point):
    if point is None:
        return 0
    return min(1 if (value := getattr(point, name, None)) is None else value if isfinite(value) else 0
               for name in ("visibility", "presence"))


def _foot_positions(landmarks, offset, width, confidence=0.50):
    return {
        index: point.x * width for index in FOOT_X_INDICES
        if (point := landmarks[index + offset]) is not None
        and _confidence(point) >= confidence
        and 0 <= point.x <= 1 and 0 <= point.y <= 1
    }


@dataclass
class GuideAnchor:
    origin_x: float
    y: float
    leg: float
    direction: int
    side: str
    feet: dict[int, float]
    updated_at: int
    base_shift: float
    min_shift: float
    max_shift: float
    shift_x: float = 0.0

    @property
    def x(self):
        return self.origin_x + self.base_shift + self.shift_x

    def follow_squat_stance(self, landmarks, side, width, timestamp_ms):
        if side != self.side or not landmarks or len(landmarks) < 33 or timestamp_ms <= self.updated_at:
            return
        offset = int(side == "right")
        if self.feet.keys() == {27}:
            feet = _foot_positions(landmarks, offset, width, confidence=0.65)
            if 27 not in feet:
                return
            change = feet[27] - self.feet[27]
        else:
            feet = _foot_positions(landmarks, offset, width)
            deltas = [x - self.feet[index] for index, x in feet.items() if index in self.feet]
            if len(deltas) < 2 or (len(deltas) == 2 and abs(deltas[0] - deltas[1]) > 0.10 * self.leg):
                return
            change = median(deltas)
        limit = 0.24 * self.leg
        desired = 0.0 if abs(change) < 0.015 * self.leg else change
        target = min(self.max_shift, limit, max(self.min_shift, -limit, desired))
        elapsed = min(120, timestamp_ms - self.updated_at)
        self.shift_x += (target - self.shift_x) * (1 - exp(-elapsed / 180))
        self.updated_at = timestamp_ms


def starting_guide_anchor(landmarks, live, width, height, exercise, timestamp_ms, crop=None, variant="bodyweight"):
    if not landmarks or not live or len(landmarks) < 33:
        return None
    offset = int(live["side"] == "right")
    nose = landmarks[0]
    shoulder, hip, knee, ankle, heel, toe = (landmarks[index + offset] for index in (11, 23, 25, 27, 29, 31))
    if not all(p is not None and _confidence(p) >= 0.35 and isfinite(p.x) and isfinite(p.y) for p in (hip, knee, ankle)):
        return None
    leg = hypot((hip.x - knee.x) * width, (hip.y - knee.y) * height) + \
        hypot((knee.x - ankle.x) * width, (knee.y - ankle.y) * height)
    if leg <= 0:
        return None
    def visible(point):
        return _confidence(point) >= 0.35 and 0 <= point.x <= 1 and 0 <= point.y <= 1

    toe_visible = visible(toe)
    if exercise == "push-up":
        wrist = landmarks[15 + offset]
        if not toe_visible or not visible(wrist):
            return None
        direction_candidates = ((wrist, toe),)
        hand_to_toe = abs(wrist.x - toe.x) * width
        model_span = guide_joints(exercise, 0)["wrist"][0]
        leg = min(1.2 * leg, max(0.8 * leg, hand_to_toe / model_span))
    else:
        direction_candidates = ((toe, heel), (nose, shoulder))
    direction = None
    for front, back in direction_candidates:
        if not visible(front) or not visible(back):
            continue
        separation = (front.x - back.x) * width
        if abs(separation) >= leg * 0.045:
            direction = 1 if separation > 0 else -1
            break
    if direction is None:
        return None
    crop_left, crop_width = crop if crop is not None else (0, width)
    min_x, max_x, min_y, max_y = guide_body_bounds(exercise, variant)
    padding = min(max(13, leg * 0.04), crop_width / 4, height / 4)
    leg = min(leg, (crop_width - 2 * padding) / (max_x - min_x),
              (height - 2 * padding) / (max_y - min_y))
    if leg <= 0:
        return None
    origin = toe if exercise in ("push-up", "heel-raise") and toe_visible else ankle
    x, y = origin.x * width, origin.y * height
    if origin is ankle and exercise == "heel-raise":
        model_ankle = guide_joints(exercise, 0)["ankle"]
        x -= direction * model_ankle[0] * leg
        y -= model_ankle[1] * leg
    y = min(height - padding - max_y * leg, max(padding - min_y * leg, y))
    model_x = [x + direction * leg * dx for dx in (min_x, max_x)]
    minimum = crop_left + padding - min(model_x)
    maximum = crop_left + crop_width - padding - max(model_x)
    rear = 0 if exercise == "push-up" else -direction * leg * 0.18
    shift = min(maximum, max(minimum, rear)) if minimum <= maximum else rear
    min_shift = minimum - shift if minimum <= maximum else 0
    max_shift = maximum - shift if minimum <= maximum else 0
    feet = _foot_positions(landmarks, offset, width) if exercise == "squat" else {}
    return GuideAnchor(x, y, leg, direction, live["side"], feet, timestamp_ms, shift, min_shift, max_shift)

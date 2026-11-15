"""Run the Motif side-view movement camera as a local desktop app."""

from __future__ import annotations

import argparse
import base64
from bisect import bisect_right
from dataclasses import replace
from datetime import datetime, timezone
import json
from math import acos, cos, degrees, hypot, isfinite, pi, radians, sin
from pathlib import Path
from statistics import median
import sys
import textwrap
import time
from types import SimpleNamespace
import uuid

try:
    import winsound
except ImportError:
    winsound = None

import cv2
import mediapipe as mp
import numpy as np

from squat_tracker import SquatTracker
from mobility_tracker import MobilityTracker
from movement_guides import (
    CONNECTIONS as GUIDE_CONNECTIONS,
    guide_joints,
    guide_progress,
    starting_guide_anchor,
    training_range,
)


MODEL_PATH = Path(__file__).resolve().parents[1] / "public" / "models" / "pose_landmarker_lite.task"
WINDOW = "Motif - Movement Camera"
PREVIEW_CROP_WIDTH_PER_HEIGHT = 0.95
POSE_CROP_WIDTH_PER_HEIGHT = 1.25
CENTERED_BODY_MARGIN = 0.08
COUNTDOWN_MS = 2000
POSE_INTERVAL_MS = 1000 / 12
OVERLAY_LOSS_MS = 240
MAX_CAPTURE_CANDIDATES = 330
MAX_CANDIDATE_IMAGE_EDGE = 800
MAX_MOTION_SAMPLES = 400
MOTION_SAMPLE_INTERVAL_MS = 45
MOTION_SAMPLE_GAP_MS = 200
PHASES = ("start", "descent", "bottom", "ascent", "finish")
PHASE_LABELS = {"start": "Start", "descent": "Down", "bottom": "Bottom", "ascent": "Up", "finish": "Finish"}
PRACTICE_GUIDE = {
    "descentTargetMs": 2000,
    "ascentTargetMs": 1000,
    "guidance": [
        "Start tall with your feet planted.",
        "Bend at the hips and knees together as you lower.",
        "Use a comfortable depth and keep your whole foot in contact with the floor.",
        "Stand back up in one controlled motion. For this drill, try about two seconds down and one second up.",
    ],
    "depthTarget": "comfortable personal reference",
    "torsoAngleTarget": None,
    "proportionMethod": "Projected ratios from source image pixels, without absolute height or distance calibration.",
    "measurementLimits": "Estimates from one side in 2D. Do not infer side-to-side knee alignment, spinal loading, overall safety, or balance.",
}
SIDE_CONNECTIONS = {
    "left": ((11, 13), (13, 15), (11, 23), (23, 25), (25, 27), (27, 29), (29, 31)),
    "right": ((12, 14), (14, 16), (12, 24), (24, 26), (26, 28), (28, 30), (30, 32)),
}
POSE_JOINTS = {"nose": 0, "shoulder": 11, "hip": 23, "knee": 25, "ankle": 27, "heel": 29, "toe": 31}
MOTION_JOINTS = {**POSE_JOINTS, "elbow": 13, "wrist": 15}
REPLAY_CONNECTIONS = (
    ("nose", "shoulder"), ("shoulder", "hip"), ("hip", "knee"), ("knee", "ankle"),
    ("ankle", "heel"), ("heel", "toe"), ("ankle", "toe"),
    ("shoulder", "elbow"), ("elbow", "wrist"),
)
INK = (240, 246, 244)
MUTED = (169, 191, 183)
ACCENT = (144, 243, 194)
BG = (31, 37, 32)
POSE_OUTLINE = (15, 21, 17)
GUIDE_BAR = (135, 211, 249)
VARIANT_LABELS = {"bodyweight": "Bodyweight", "barbell": "Barbell"}
EXERCISES = {
    "squat": {"title": "Squat", "short": "Squat", "setup": "Stand sideways in the center so your whole body fits.",
              "cue": "Lower into a comfortable squat, then stand tall.", "out": "Lower", "peak": "Bottom", "return": "Rise"},
    "push-up": {"title": "Push-up", "short": "Push-up", "setup": "Set up in a high plank side-on. Keep your head, hands and toes in view.",
                "cue": "Bend your elbows to lower toward the floor, then press back up.",
                "out": "Lower", "peak": "Bottom", "return": "Press", "range_label": "Elbow bend"},
    "knee-raise": {"title": "Knee raise", "short": "Knee raise", "setup": "Stand upright and side-on with both feet in view.",
                   "cue": "Lift the knee nearest the camera in front of you, then lower your foot.",
                   "out": "Lift", "peak": "Peak", "return": "Lower", "range_label": "Thigh lift"},
    "heel-raise": {"title": "Heel raise", "short": "Heel raise", "setup": "Stand upright and side-on with both feet flat. Keep your heels and toes in view.",
                   "cue": "Lift both heels with your toes planted, then lower your heels to the floor.",
                   "out": "Lift", "peak": "Peak", "return": "Lower", "range_label": "Heel lift"},
}
DISCARD_MESSAGES = {
    "tracking-gap": "Tracking was lost. Keep your near hip, knee and ankle visible throughout the squat.",
    "timeout": "No complete rep was detected in time. Press Space to try again.",
    "incomplete-descent": "The camera saw a small bend. Try one continuous squat through your comfortable range.",
    "incomplete-ascent": "The camera missed part of the rise. Stand tall briefly at the end of your next rep.",
    "low-confidence": "Part of the squat was obscured. Improve the lighting and keep your near side visible.",
    "second-descent": "The camera saw a second lowering motion. Finish one rep before starting again.",
}
MOBILITY_DISCARD_MESSAGES = {
    "tracking-gap": "Tracking was lost. Keep the moving joints visible throughout the rep.",
    "foot-moved": "Your starting position shifted. Reset and try again.",
    "incomplete-descent": "The movement ended before the camera saw a full rep. Try one continuous rep.",
    "low-confidence": "Part of the movement was obscured. Keep your near side visible in good light.",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def play_go_sound():
    if winsound is None:
        return
    try:
        winsound.MessageBeep()
    except (OSError, RuntimeError):
        pass


def center_crop_bounds(width: int, height: int, ratio=PREVIEW_CROP_WIDTH_PER_HEIGHT, exercise="squat") -> tuple[int, int]:
    if exercise == "push-up":
        return 0, width
    crop_width = min(width, max(1, int(height * ratio + 0.5)))
    return (width - crop_width) // 2, crop_width


def detect_centered_pose(detector, frame: np.ndarray, timestamp_ms: int, exercise="squat", *, full_frame=False):
    height, width = frame.shape[:2]
    left, crop_width = (0, width) if full_frame else center_crop_bounds(width, height, POSE_CROP_WIDTH_PER_HEIGHT, exercise)
    rgb = cv2.cvtColor(frame[:, left:left + crop_width], cv2.COLOR_BGR2RGB)
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = detector.detect_for_video(image, timestamp_ms)
    if not result.pose_landmarks:
        return None
    landmarks = result.pose_landmarks[0]
    if crop_width == width:
        return landmarks
    for point in landmarks:
        if not 0 <= point.x <= 1:
            point.visibility = 0
        point.x = (left + point.x * crop_width) / width
        if point.z is not None:
            point.z *= crop_width / width
    return landmarks


def _confidence_value(value):
    return 1 if value is None else value if isinstance(value, (int, float)) and isfinite(value) else 0


def _point_confidence(point):
    if point is None:
        return 0
    values = (point.get(name) if isinstance(point, dict) else getattr(point, name, None)
              for name in ("visibility", "presence"))
    return min(_confidence_value(value) for value in values)


def pose_within_center(landmarks, width: int, height: int, exercise="squat") -> bool:
    left, crop_width = center_crop_bounds(width, height, exercise=exercise)
    if crop_width == width or not landmarks:
        return True

    pairs = ((landmarks[23], landmarks[27]), (landmarks[24], landmarks[28]))
    candidates = [
        (_point_confidence(hip) + _point_confidence(ankle), (hip.x + ankle.x) / 2)
        for hip, ankle in pairs
        if _point_confidence(hip) >= 0.55 and _point_confidence(ankle) >= 0.55 and isfinite(hip.x) and isfinite(ankle.x)
    ]
    if not candidates:
        return True
    _, midpoint = max(candidates, key=lambda item: item[0])
    cropped_x = (midpoint * width - left) / crop_width
    return CENTERED_BODY_MARGIN <= cropped_x <= 1 - CENTERED_BODY_MARGIN


def pose_joints(landmarks, side, indices=POSE_JOINTS):
    offset = int(side == "right")
    return {
        name: {
            "x": point.x,
            "y": point.y,
            "visibility": _confidence_value(point.visibility) if point.visibility is not None else None,
            **({"presence": _confidence_value(point.presence)} if getattr(point, "presence", None) is not None else {}),
        }
        for name, index in indices.items()
        if isfinite((point := landmarks[index + (offset if index else 0)]).x) and isfinite(point.y)
    }


def thigh_to_shin_ratio(joints, width, height):
    leg = [joints.get(name) for name in ("hip", "knee", "ankle")]
    if not all(_point_confidence(point) >= 0.35 for point in leg):
        return None
    hip, knee, ankle = leg

    def length(point):
        return hypot((knee["x"] - point["x"]) * width, (knee["y"] - point["y"]) * height)

    thigh, shin = length(hip), length(ankle)
    if not isfinite(thigh) or not isfinite(shin) or height <= 0 or width <= 0 or min(thigh, shin) < height * 0.035:
        return None
    return round(thigh / shin, 3)


def motion_sample(landmarks, live, timestamp_ms, width, height, exercise="squat"):
    if not live or not landmarks:
        return None
    joints = pose_joints(landmarks, live["side"], MOTION_JOINTS)
    if live.get("torsoLeanDeg") is None:
        joints.pop("shoulder", None)
    if not all(name in joints for name in ("hip", "knee", "ankle")):
        return None
    sample = {
        "timestampMs": timestamp_ms,
        "joints": {
            name: {
                "x": round(point["x"], 4), "y": round(point["y"], 4),
                "visibility": round(point["visibility"], 3) if point["visibility"] is not None else None,
                **({"presence": round(point["presence"], 3)} if "presence" in point else {}),
            }
            for name, point in joints.items()
        },
    }
    if exercise == "squat":
        sample["thighToShinRatio"] = thigh_to_shin_ratio(joints, width, height)
    return sample


def make_motion_trace(samples, start_ms, movement_start_ms):
    frames = [
        {
            "offsetMs": round(sample["timestampMs"] - start_ms), "joints": sample["joints"],
            **({"thighToShinRatio": sample["thighToShinRatio"]} if "thighToShinRatio" in sample else {}),
        }
        for i, sample in enumerate(samples)
        if i == 0 or sample["timestampMs"] >= movement_start_ms - 400
    ]
    return {"frames": frames}


def visible_motion_joints(joints):
    thresholds = {"hip": 0.35, "knee": 0.35, "ankle": 0.35, "shoulder": 0.35}
    return {
        name: point for name, point in joints.items()
        if 0 <= point["x"] <= 1 and 0 <= point["y"] <= 1
        and _point_confidence(point) >= thresholds.get(name, 0.55)
    }


def _replay_slope(adjacent, adjacent_ms, central, central_ms):
    if adjacent is None:
        return central
    if adjacent * central <= 0:
        return 0
    outer_weight = 2 * central_ms + adjacent_ms
    inner_weight = central_ms + 2 * adjacent_ms
    return (outer_weight + inner_weight) / (outer_weight / adjacent + inner_weight / central)


def _replay_coordinate(first, second, previous, following, gap, previous_gap, following_gap, t):
    central = (second - first) / gap
    earlier = (first - previous) / previous_gap if previous is not None else None
    later = (following - second) / following_gap if following is not None else None
    start_slope = _replay_slope(earlier, previous_gap, central, gap)
    end_slope = _replay_slope(later, following_gap, central, gap)
    square, cube = t * t, t * t * t
    value = ((2 * cube - 3 * square + 1) * first + (cube - 2 * square + t) * gap * start_slope
             + (-2 * cube + 3 * square) * second + (cube - square) * gap * end_slope)
    return min(max(value, min(first, second)), max(first, second))


def replay_joints_at(frames, offset_ms):
    if not frames:
        return {}
    right_index = bisect_right(frames, offset_ms, key=lambda sample: sample["offsetMs"])
    if right_index == 0:
        return visible_motion_joints(frames[0]["joints"])
    before = frames[right_index - 1]
    if right_index == len(frames) or offset_ms == before["offsetMs"]:
        return visible_motion_joints(before["joints"])
    after = frames[right_index]
    gap = after["offsetMs"] - before["offsetMs"]
    if gap > MOTION_SAMPLE_GAP_MS:
        if offset_ms - before["offsetMs"] < 75:
            return visible_motion_joints(before["joints"])
        if after["offsetMs"] - offset_ms < 75:
            return visible_motion_joints(after["joints"])
        return {}
    t = (offset_ms - before["offsetMs"]) / gap
    first, second = visible_motion_joints(before["joints"]), visible_motion_joints(after["joints"])
    previous = frames[right_index - 2] if right_index >= 2 else None
    following = frames[right_index + 1] if right_index + 1 < len(frames) else None
    previous_gap = before["offsetMs"] - previous["offsetMs"] if previous is not None else 0
    following_gap = following["offsetMs"] - after["offsetMs"] if following is not None else 0
    earlier = visible_motion_joints(previous["joints"]) if 0 < previous_gap <= MOTION_SAMPLE_GAP_MS else {}
    later = visible_motion_joints(following["joints"]) if 0 < following_gap <= MOTION_SAMPLE_GAP_MS else {}
    return {
        name: {
            **{axis: _replay_coordinate(point[axis], second[name][axis], earlier.get(name, {}).get(axis),
                                     later.get(name, {}).get(axis), gap, previous_gap, following_gap, t)
               for axis in ("x", "y")},
            "visibility": min(_confidence_value(point.get("visibility")), _confidence_value(second[name].get("visibility"))),
            **({"presence": min(_confidence_value(point.get("presence")), _confidence_value(second[name].get("presence")))}
               if "presence" in point or "presence" in second[name] else {}),
        }
        for name, point in first.items() if name in second
    }


class LiveOverlay:
    """Render between accepted camera samples without changing tracker input."""

    def __init__(self):
        self.origin = None
        self.target = None
        self.target_at = None
        self.side = None
        self.duration = 0

    def update(self, landmarks, side, timestamp_ms):
        if not landmarks or side is None:
            return
        points = tuple(
            SimpleNamespace(x=point.x, y=point.y, visibility=point.visibility, presence=getattr(point, "presence", None))
            for point in landmarks
        )
        rendered, previous_side = self.at(timestamp_ms)
        self.origin = rendered if previous_side == side else None
        self.target, self.target_at, self.side = points, timestamp_ms, side
        if self.origin:
            offset = int(side == "right")
            motion = max(hypot(self.origin[index + offset].x - points[index + offset].x,
                               self.origin[index + offset].y - points[index + offset].y) for index in (23, 25, 27))
            self.duration = max(44, 90 - motion * 620)

    def at(self, timestamp_ms):
        if self.target_at is None or timestamp_ms - self.target_at > OVERLAY_LOSS_MS:
            return None, None
        if not self.origin or timestamp_ms >= self.target_at + self.duration:
            return self.target, self.side
        alpha = max(0, timestamp_ms - self.target_at) / self.duration
        alpha = alpha * (2 - alpha)
        points = tuple(
            SimpleNamespace(x=before.x + (after.x - before.x) * alpha,
                            y=before.y + (after.y - before.y) * alpha,
                            visibility=min(_confidence_value(before.visibility), _confidence_value(after.visibility)),
                            presence=min(_confidence_value(before.presence), _confidence_value(after.presence)))
            for before, after in zip(self.origin, self.target)
        )
        return points, self.side


def capture_snapshot(frame: np.ndarray, timestamp_ms: float, landmarks, live: dict | None,
                     max_edge=1280, exercise="squat") -> dict | None:
    source_height, source_width = frame.shape[:2]
    height, width = source_height, source_width
    scale = min(1, max_edge / max(width, height))
    try:
        if scale < 1:
            width, height = max(1, round(width * scale)), max(1, round(height * scale))
            frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
        ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    except cv2.error:
        return None
    if not ok:
        return None
    snapshot = {
        "timestampMs": timestamp_ms,
        "width": width,
        "height": height,
        "mimeType": "image/jpeg",
        "imageBase64": base64.b64encode(encoded).decode("ascii"),
        "kneeAngleDeg": live.get("kneeAngleDeg") if live else None,
    }
    if live and landmarks:
        joints = pose_joints(landmarks, live["side"], MOTION_JOINTS if exercise != "squat" else POSE_JOINTS)
        pose = {
            "side": live["side"],
            "hipAngleDeg": live.get("hipAngleDeg"),
            "torsoLeanDeg": live.get("torsoLeanDeg"),
            "shinLeanDeg": live.get("shinLeanDeg"),
            "joints": joints,
        }
        if exercise == "squat":
            pose.update({
                "hipDropLegLengths": live["hipDropRatio"],
                "hipToKneeLegLengths": live["hipToKneeRatio"],
                "hipSpeedLegLengthsPerSec": live["hipSpeedLegLengthsPerSec"],
                "thighToShinRatio": thigh_to_shin_ratio(joints, source_width, source_height),
            })
        else:
            pose.update(range=live.get("range"), rangeUnit=live.get("rangeUnit"),
                        movementSpeedPerSec=live.get("movementSpeedPerSec"))
        snapshot["pose"] = pose
    return snapshot


def make_evidence(rep: dict, frames: dict, camera: dict, reference: dict, captured_at: str,
                  capture_start_ms: int, motion_samples=(), variant="bodyweight", exercise="squat", training_guide=False,
                  source="webcam") -> dict:
    metrics = dict(rep["metrics"])
    if exercise == "squat":
        metrics["kneeExcursionDeg"] = metrics["startKneeAngleDeg"] - metrics["kneeAngleAtBottomDeg"]
        metrics["returnAngleErrorDeg"] = abs(metrics["startKneeAngleDeg"] - metrics["finishKneeAngleDeg"])
        ratios = [sample["thighToShinRatio"] for sample in motion_samples
                  if rep["startedAtMs"] <= sample["timestampMs"] <= rep["returnedAtMs"]
                  and sample.get("thighToShinRatio") is not None]
        metrics["thighToShinRatio"] = round(median(ratios), 3) if ratios else metrics.get("standingThighToShinRatio")
    snapshots = []
    for phase in PHASES:
        if phase in frames:
            image = dict(frames[phase])
            offset = round(image.pop("timestampMs") - capture_start_ms)
            snapshots.append({"phase": phase, "offsetMs": offset, **image})
    if exercise != "squat":
        cue = {"code": "OBSERVED_CYCLE", "text": f"The camera tracked one {EXERCISES[exercise]['short'].lower()} from the side."}
    elif reference["establishedByThisRep"]:
        cue = {"code": "BASELINE_CAPTURED", "text": "This rep established your personal range reference for this camera setup."}
    else:
        cue = {"code": "OBSERVED_CYCLE", "text": "Captured one complete rep from the same side view."}
    return {
        "schemaVersion": 1,
        "id": str(uuid.uuid4()),
        "exercise": exercise,
        "variant": variant if exercise == "squat" else "bodyweight",
        "captureMode": "single-rep",
        "source": source,
        **({"videoStartOffsetMs": round(capture_start_ms)} if source == "video" else {}),
        "capturedAt": captured_at,
        "camera": camera,
        "trackingSide": rep["side"],
        "movementStartOffsetMs": round(rep["startedAtMs"] - capture_start_ms),
        "reference": reference,
        "metrics": metrics,
        "cue": cue,
        "observations": rep["cues"],
        "practiceGuide": PRACTICE_GUIDE if exercise == "squat" else {
            "guidance": [EXERCISES[exercise]["setup"], EXERCISES[exercise]["cue"]],
            "measurementLimits": "Range and speed are estimated from one side in 2D.",
        },
        "snapshots": snapshots,
        "motionTrace": make_motion_trace(motion_samples, capture_start_ms, rep["startedAtMs"]),
        **({"trainingGuide": True} if training_guide else {}),
    }


class CaptureSession:
    def __init__(self, output: Path, variant="bodyweight", exercise="squat", training=False, source="webcam"):
        self.output = output
        self.variant = variant
        self.exercise = exercise
        self.source = source
        self.training_next = training
        self.training_active = False
        self.training_anchor = None
        self.review_training_anchor = None
        self.review_training_visible = False
        self.tracker = SquatTracker() if exercise == "squat" else MobilityTracker(exercise)
        self.profile_id = str(uuid.uuid4())
        self.frame_size = None
        self.reference = None
        self.latest = None
        self.thumbnails = []
        self.show_guide = False
        self.guide_depth = 1
        self.snapshots = {}
        self.capture_candidates = {}
        self.motion_samples = []
        self.replay_open = False
        self.replay_offset = 0
        self.replay_clock = None
        self.wait_until = None
        self.countdown_until = None
        self.armed_at = None
        self.go_at = None
        self.countdown_started_at = None
        self.active_since = None
        self.capture_timestamp = None
        self.rep_started = False
        self.state = {"phase": "setup", "setup": {"ready": False, "checks": {}}, "live": None}
        self.notice = ""

    def start(self, timestamp_ms: int):
        if self.armed or self.wait_until is not None:
            return
        self.cancel()
        self.notice = ""
        self.training_active = self.training_next
        self.training_next = False
        self.wait_until = float("inf") if self.source == "video" else timestamp_ms + 45000

    def cancel(self):
        self.wait_until = None
        self.armed_at = None
        self.go_at = None
        self.active_since = None
        self.training_active = False
        self.clear_countdown()
        self.rep_started = False
        self.close_replay()

    def clear_countdown(self):
        self.countdown_until = None
        self.countdown_started_at = None
        self.capture_timestamp = None
        self.snapshots.clear()
        self.capture_candidates.clear()
        self.motion_samples = []
        self.training_anchor = None

    def keep_motion_sample(self, landmarks, live, timestamp_ms, width, height, force=False):
        if self.motion_samples:
            elapsed = timestamp_ms - self.motion_samples[-1]["timestampMs"]
            if elapsed <= 0 or (not force and elapsed < MOTION_SAMPLE_INTERVAL_MS):
                return
        sample = motion_sample(landmarks, live, timestamp_ms, width, height, self.exercise)
        if sample is None:
            return
        if len(self.motion_samples) >= MAX_MOTION_SAMPLES:
            # Leave space for the end without dropping the original standing reference.
            del self.motion_samples[1]
        self.motion_samples.append(sample)

    def close_replay(self):
        self.replay_open = False
        self.replay_clock = None

    def replay_position(self, timestamp_ms):
        end = self.latest["motionTrace"]["frames"][-1]["offsetMs"]
        offset = self.replay_offset
        if self.replay_clock is not None:
            offset += timestamp_ms - self.replay_clock
            if offset >= end:
                self.replay_offset = end
                self.replay_clock = None
        return min(offset, end)

    def toggle_replay(self, timestamp_ms):
        if self.armed or self.wait_until is not None:
            self.notice = "Finish or cancel this capture before playing a rep."
            return
        frames = self.latest["motionTrace"]["frames"] if self.latest else []
        if len(frames) < 2:
            self.notice = "Capture a rep before playing it back."
            return
        if self.replay_clock is not None:
            self.replay_offset = self.replay_position(timestamp_ms)
            self.replay_clock = None
            return
        if not self.replay_open or self.replay_offset >= frames[-1]["offsetMs"]:
            self.replay_offset = max(0, self.latest["movementStartOffsetMs"] - 250)
        self.replay_open = True
        self.replay_clock = timestamp_ms

    def begin_capture(self, timestamp_ms: int, early=False):
        self.countdown_until = None
        self.armed_at = self.countdown_started_at
        self.active_since = timestamp_ms
        if not early:
            self.go_at = timestamp_ms

    def return_to_positioning(self):
        self.armed_at = None
        self.active_since = None
        self.go_at = None
        self.clear_countdown()

    @property
    def armed(self):
        return self.armed_at is not None

    def recalibrate(self):
        self.cancel()
        self.tracker.reset()
        self.profile_id = str(uuid.uuid4())
        self.reference = None
        self.state = {"phase": "setup", "setup": {"ready": False, "checks": {}}, "live": None}
        self.notice = "Setup reset. Check your framing and hold your starting position."

    def toggle_variant(self):
        if self.exercise != "squat":
            self.notice = "Bodyweight and barbell options apply to Squat."
            return
        if self.armed or self.wait_until is not None:
            self.notice = "Finish or cancel this capture before changing the squat type."
            return
        self.variant = "barbell" if self.variant == "bodyweight" else "bodyweight"
        self.recalibrate()
        self.notice = f"{VARIANT_LABELS[self.variant]} selected. Press Space to arm a rep."

    def cycle_exercise(self):
        if self.armed or self.wait_until is not None:
            self.notice = "Finish or cancel this capture to choose a different exercise."
            return
        catalog = tuple(EXERCISES)
        self.exercise = catalog[(catalog.index(self.exercise) + 1) % len(catalog)]
        self.tracker = SquatTracker() if self.exercise == "squat" else MobilityTracker(self.exercise)
        self.recalibrate()
        self.notice = f"{EXERCISES[self.exercise]['title']} selected. Press Space to arm a rep."

    def toggle_training(self):
        if self.armed or self.wait_until is not None:
            self.notice = "Finish or cancel this capture to change the training overlay."
            return
        self.training_next = not self.training_next
        self.notice = f"Training overlay {'on' if self.training_next else 'off'} for the next rep."

    def save(self):
        if not self.latest:
            self.notice = "Capture an assessed rep before saving."
            return
        try:
            self.output.mkdir(parents=True, exist_ok=True)
            path = self.output / f"motif-{self.latest['exercise']}-{self.latest['id']}.json"
            path.write_text(json.dumps(self.latest, indent=2, allow_nan=False), encoding="utf-8")
        except (OSError, ValueError) as error:
            self.notice = "Could not save the rep. Check the output folder."
            print(f"Save failed: {error}", file=sys.stderr)
            return
        self.notice = "Saved the rep and snapshots."
        print(f"Saved {path.resolve()}")
        return path

    def clear_result(self):
        self.latest = None
        self.thumbnails = []
        self.review_training_anchor = None
        self.review_training_visible = False
        self.close_replay()
        self.notice = "Rep result cleared."

    def update(self, frame: np.ndarray, landmarks, timestamp_ms: int):
        height, width = frame.shape[:2]
        if self.frame_size and self.frame_size != (width, height):
            self.recalibrate()
            self.notice = "Camera frame changed. Press Space to arm a new capture."
        self.frame_size = (width, height)
        standby = self.countdown_until is not None
        tracking_motion = self.armed or standby
        recorded = self.source == "video"
        centered = recorded or pose_within_center(landmarks, width, height, self.exercise)
        self.state = self.tracker.update(
            landmarks if centered or tracking_motion else None,
            timestamp_ms, width, height, armed=tracking_motion, lock_standing=tracking_motion,
        )
        if (not recorded and not tracking_motion
                and (not centered or (not landmarks and center_crop_bounds(width, height, exercise=self.exercise)[1] < width))):
            self.state["setup"]["message"] = "Step into the center with your head and feet visible."
        live = self.state["live"]
        ready = centered and self.state["setup"]["ready"] and self.state["phase"] == "ready"
        if self.reference and not tracking_motion and ready and live and live["side"] != self.reference["trackingSide"]:
            self.reference = None
            self.profile_id = str(uuid.uuid4())

        if tracking_motion:
            if self.exercise == "squat" and self.training_anchor is not None and live:
                self.training_anchor.follow_squat_stance(landmarks, live["side"], width, timestamp_ms)
            finished = any(event["type"] == "rep-complete" for event in self.state["events"])
            self.keep_motion_sample(landmarks, live, timestamp_ms, width, height, force=finished)
        if not self.armed and self.wait_until is not None:
            movement_started = standby and (
                self.state["phase"] in ("descending", "bottom", "ascending")
                or any(event["type"] == "capture" for event in self.state["events"])
            )
            if timestamp_ms > self.wait_until:
                self.cancel()
                self.notice = "Setup timed out. Press Space to try again."
            elif movement_started:
                self.begin_capture(timestamp_ms, early=True)
            elif standby:
                if self.state["phase"] == "setup":
                    self.clear_countdown()
                elif live is not None:
                    checks = self.state["setup"]["checks"]
                    if (timestamp_ms >= self.countdown_until and (centered or self.exercise == "squat")
                            and checks["sideOn"] and checks["standing"]):
                        self.begin_capture(timestamp_ms)
            elif ready:
                self.countdown_started_at = timestamp_ms
                self.capture_timestamp = now_iso()
                start_image = capture_snapshot(frame, timestamp_ms, landmarks, live, exercise=self.exercise)
                if start_image is not None:
                    self.snapshots["start"] = start_image
                if self.training_active or recorded:
                    crop = (0, width) if recorded else center_crop_bounds(width, height, exercise=self.exercise)
                    self.training_anchor = starting_guide_anchor(
                        landmarks, live, width, height, self.exercise, timestamp_ms, crop, self.variant,
                    )
                self.keep_motion_sample(landmarks, live, timestamp_ms, width, height)
                if recorded:
                    self.begin_capture(timestamp_ms, early=True)
                else:
                    self.countdown_until = timestamp_ms + COUNTDOWN_MS
            if not movement_started or not self.armed:
                return

        if not self.armed:
            return
        if not self.rep_started and self.state["phase"] == "setup":
            self.return_to_positioning()
            self.notice = "Return to your side-on starting position. The countdown will restart when you're ready."
            return
        if timestamp_ms - self.active_since > 20000:
            self.cancel()
            self.tracker.reset()
            self.notice = "No complete rep was detected in time. Return to the start and try again."
            return
        if not self.state["events"] and self.state["phase"] == "setup" and timestamp_ms - self.active_since > 800:
            self.cancel()
            self.notice = "Your pose left the setup area. Check the framing and try again."
            return

        for event in self.state["events"]:
            if event["type"] == "capture-candidate":
                candidate = capture_snapshot(
                    frame, event["timestampMs"], landmarks, live, max_edge=MAX_CANDIDATE_IMAGE_EDGE, exercise=self.exercise,
                )
                if candidate is not None:
                    if "kneeAngleDeg" in event:
                        candidate["kneeAngleDeg"] = event["kneeAngleDeg"]
                    if "range" in event and candidate.get("pose") is not None:
                        candidate["pose"]["range"] = event["range"]
                    if len(self.capture_candidates) >= MAX_CAPTURE_CANDIDATES:
                        del self.capture_candidates[next(iter(self.capture_candidates))]
                    self.capture_candidates[event["timestampMs"]] = candidate
            elif event["type"] == "capture":
                phase = event["phase"]
                if phase == "start":
                    self.rep_started = True
                if phase != "start" or "start" not in self.snapshots:
                    image = self.capture_candidates.get(event["timestampMs"])
                    if image is None and event["timestampMs"] == timestamp_ms:
                        image = capture_snapshot(frame, timestamp_ms, landmarks, live, exercise=self.exercise)
                    if image is not None:
                        self.snapshots[phase] = image
            elif event["type"] == "rep-discarded":
                self.cancel()
                messages = DISCARD_MESSAGES if self.exercise == "squat" else MOBILITY_DISCARD_MESSAGES
                self.notice = messages.get(event["reason"], "The full rep could not be tracked. Check your framing and try again.")
                break
            elif event["type"] == "rep-complete":
                rep = event["rep"]
                established_here = not self.reference
                if not self.reference:
                    metrics = rep["metrics"]
                    self.reference = {
                        "id": str(uuid.uuid4()),
                        "trackingSide": rep["side"],
                        "capturedAt": now_iso(),
                    }
                    if self.exercise == "squat":
                        self.reference.update({
                            "kneeExcursionDeg": metrics["startKneeAngleDeg"] - metrics["kneeAngleAtBottomDeg"],
                            "standingKneeAngleDeg": metrics["startKneeAngleDeg"],
                            "torsoLeanAtBottomDeg": metrics["torsoLeanAtBottomDeg"],
                            "bottomHipToKneeLegLengths": metrics["bottomHipToKneeLegLengths"],
                            "standingThighToShinRatio": metrics["standingThighToShinRatio"],
                            "standingTorsoToLegRatio": metrics["standingTorsoToLegRatio"],
                        })
                    else:
                        self.reference.update(range=metrics["range"], rangeUnit=metrics["rangeUnit"])
                camera = {"id": self.profile_id, "width": width, "height": height, "view": "side"}
                reference = {**self.reference, "establishedByThisRep": established_here}
                self.latest = make_evidence(
                    rep, self.snapshots, camera, reference, self.capture_timestamp,
                    self.armed_at, self.motion_samples, self.variant, self.exercise,
                    self.training_active and self.training_anchor is not None, self.source,
                )
                if recorded and self.training_anchor is not None:
                    self.review_training_anchor = replace(self.training_anchor, shift_x=0)
                    self.review_training_visible = self.training_active
                self.thumbnails = []
                for snapshot in self.latest["snapshots"]:
                    jpeg = np.frombuffer(base64.b64decode(snapshot["imageBase64"]), dtype=np.uint8)
                    image = cv2.imdecode(jpeg, cv2.IMREAD_COLOR)
                    if image is not None:
                        self.thumbnails.append((snapshot["phase"], image))
                if len(self.latest["snapshots"]) < len(PHASES):
                    self.notice = "Rep captured. Some images are missing. Press P to play or E to save."
                else:
                    self.notice = "Rep captured. Press P to play or E to save."
                self.cancel()
                break


def draw_pose(frame: np.ndarray, landmarks, side: str | None, tracking: bool, crop_left: float, crop_width: float,
              reacquiring=False, uncertain=False, exercise="squat"):
    if not landmarks:
        return
    height, width = frame.shape[:2]
    if side not in SIDE_CONNECTIONS:
        return

    def usable(point, index):
        threshold = 0.55
        if tracking and index in (11, 12):
            threshold = 0.30
        elif tracking and 23 <= index <= 28:
            threshold = 0.25 if uncertain else 0.35
        elif tracking and ((exercise == "push-up" and 13 <= index <= 16)
                           or (exercise == "heel-raise" and 29 <= index <= 32)):
            threshold = 0.38
        return _point_confidence(point) >= threshold and crop_left <= point.x <= crop_left + crop_width and 0 <= point.y <= 1

    def pixel(point):
        return (round((point.x - crop_left) / crop_width * width), round(point.y * height))

    color = MUTED if reacquiring else ACCENT
    center_color = MUTED if reacquiring else INK
    line_width = max(4, round(min(width, height) / 120))
    radius = line_width + 1
    segments = []
    points = set()
    for a, b in SIDE_CONNECTIONS[side]:
        first, second = landmarks[a], landmarks[b]
        if not usable(first, a) or not usable(second, b):
            continue
        start, end = pixel(first), pixel(second)
        segments.append((start, end))
        points.update((start, end))
    for start, end in segments:
        cv2.line(frame, start, end, POSE_OUTLINE, line_width + 4, cv2.LINE_AA)
    for start, end in segments:
        cv2.line(frame, start, end, color, line_width, cv2.LINE_AA)
    for point in points:
        cv2.circle(frame, point, radius + 2, POSE_OUTLINE, -1, cv2.LINE_AA)
        cv2.circle(frame, point, radius, color, -1, cv2.LINE_AA)
        cv2.circle(frame, point, 2, center_color, -1, cv2.LINE_AA)


def draw_text(image: np.ndarray, value: str, x: int, y: int, scale=0.56, color=INK, weight=1):
    cv2.putText(image, value, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, weight, cv2.LINE_AA)


def draw_paragraph(image: np.ndarray, value: str, x: int, y: int, color=INK):
    for line in textwrap.wrap(value, width=39):
        draw_text(image, line, x, y, color=color)
        y += 24
    return y


def draw_training_overlay(preview, session, timestamp_ms, crop_left, crop_width, source_height):
    if not session.armed or session.training_anchor is None:
        return False
    elapsed = timestamp_ms - session.active_since
    if elapsed < 0:
        return False
    progress = guide_progress(elapsed) or 0
    height, width = preview.shape[:2]

    def pixels(x, y):
        return round((x - crop_left) * width / crop_width), round(y * height / source_height)

    draw_training_pose(preview, session.training_anchor, progress, session.exercise, session.variant, pixels, width / crop_width)
    return True


def _training_limb(mask, start, end, start_radius, end_radius):
    """Join rounded, tapered body sections into one silhouette mask."""
    ax, ay = start
    bx, by = end
    length = hypot(bx - ax, by - ay)
    if length > 0:
        nx, ny = -(by - ay) / length, (bx - ax) / length
        polygon = np.rint([
            (ax + nx * start_radius, ay + ny * start_radius),
            (bx + nx * end_radius, by + ny * end_radius),
            (bx - nx * end_radius, by - ny * end_radius),
            (ax - nx * start_radius, ay - ny * start_radius),
        ]).astype(np.int32)
        cv2.fillConvexPoly(mask, polygon, 255, cv2.LINE_AA)
    cv2.circle(mask, start, max(1, round(start_radius)), 255, -1, cv2.LINE_AA)
    cv2.circle(mask, end, max(1, round(end_radius)), 255, -1, cv2.LINE_AA)


def _paint_training_silhouette(preview, mask, opacity, outline_opacity, line_width):
    x, y, width, height = cv2.boundingRect(mask)
    if not width or not height:
        return
    padding = line_width + 3
    left, top = max(0, x - padding), max(0, y - padding)
    right, bottom = min(preview.shape[1], x + width + padding), min(preview.shape[0], y + height + padding)
    region = preview[top:bottom, left:right]
    coverage = mask[top:bottom, left:right]
    # Blend only the body's bounds, keeping the live camera render inexpensive.
    layer = region.copy()
    layer[coverage > 0] = GUIDE_BAR
    cv2.addWeighted(layer, opacity, region, 1 - opacity, 0, region)
    # Outline the union so overlapping limbs do not look like disconnected bones.
    contours, _ = cv2.findContours(coverage, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    layer[:] = region
    cv2.drawContours(layer, contours, -1, POSE_OUTLINE, line_width + 2, cv2.LINE_AA)
    cv2.drawContours(layer, contours, -1, GUIDE_BAR, line_width, cv2.LINE_AA)
    cv2.addWeighted(layer, outline_opacity, region, 1 - outline_opacity, 0, region)


def draw_training_pose(preview, anchor, progress, exercise, variant, pixels, scale):
    leg = anchor.leg
    joints = guide_joints(exercise, progress * training_range(exercise), variant)
    points = {name: pixels(anchor.x + anchor.direction * leg * x, anchor.y + leg * y) for name, (x, y) in joints.items()}
    body_size = leg * scale
    if not isfinite(body_size) or body_size <= 0:
        return
    line_width = max(1, round(body_size * 0.012))
    near = np.zeros(preview.shape[:2], dtype=np.uint8)
    far = np.zeros_like(near)

    def limb(mask, start, end, first_radius, last_radius):
        _training_limb(mask, start, end, first_radius * body_size, last_radius * body_size)

    def shifted(point):
        return round(point[0] - anchor.direction * body_size * 0.055), round(point[1] - body_size * 0.008)

    # A second, quieter arm and leg make the side view readable at every phase.
    far_points = {name: points.get("far" + name[0].upper() + name[1:], shifted(points[name]))
                  for name in ("hip", "knee", "ankle", "heel", "toe", "shoulder", "elbow", "wrist")}
    for start, end, first_radius, last_radius in (
        ("hip", "knee", 0.076, 0.052), ("knee", "ankle", 0.050, 0.030),
        ("heel", "toe", 0.033, 0.025), ("ankle", "heel", 0.030, 0.033),
        ("shoulder", "elbow", 0.046, 0.035), ("elbow", "wrist", 0.035, 0.025),
    ):
        limb(far, far_points[start], far_points[end], first_radius, last_radius)
    _paint_training_silhouette(preview, far, 0.13, 0.45, line_width)

    shoulder, hip = points["shoulder"], points["hip"]
    waist = tuple(round(a + (b - a) * 0.64) for a, b in zip(shoulder, hip))
    limb(near, shoulder, waist, 0.105, 0.080)
    limb(near, waist, hip, 0.080, 0.105)
    for start, end, first_radius, last_radius in (
        ("hip", "knee", 0.078, 0.052), ("knee", "ankle", 0.052, 0.030),
        ("heel", "toe", 0.034, 0.025), ("ankle", "heel", 0.030, 0.034),
        ("shoulder", "elbow", 0.048, 0.035), ("elbow", "wrist", 0.035, 0.025),
    ):
        limb(near, points[start], points[end], first_radius, last_radius)
    wrist, elbow = points["wrist"], points["elbow"]
    hand = points.get("hand", tuple(round(w + (w - e) * 0.15) for w, e in zip(wrist, elbow)))
    limb(near, wrist, hand, 0.027, 0.026)

    # The model's nose point is a head anchor; a small profile gives its facing direction.
    head = (round(points["nose"][0] - anchor.direction * body_size * 0.022),
            round(points["nose"][1] - body_size * 0.01))
    limb(near, shoulder, head, 0.039, 0.035)
    cv2.ellipse(near, head, (max(1, round(body_size * 0.078)), max(1, round(body_size * 0.098))),
                0, 0, 360, 255, -1, cv2.LINE_AA)
    nose = np.rint([(head[0] + anchor.direction * body_size * 0.060, head[1] - body_size * 0.024),
                   (head[0] + anchor.direction * body_size * 0.105, head[1] + body_size * 0.016),
                   (head[0] + anchor.direction * body_size * 0.060, head[1] + body_size * 0.040)]).astype(np.int32)
    cv2.fillConvexPoly(near, nose, 255, cv2.LINE_AA)
    _paint_training_silhouette(preview, near, 0.24, 0.90, line_width)
    if "bar" in points:
        cv2.line(preview, points["bar"], shoulder, GUIDE_BAR, line_width + 1, cv2.LINE_AA)
        cv2.circle(preview, points["bar"], max(4, round(body_size * 0.09)), POSE_OUTLINE, line_width + 3, cv2.LINE_AA)
        cv2.circle(preview, points["bar"], max(4, round(body_size * 0.09)), GUIDE_BAR, line_width + 1, cv2.LINE_AA)


def draw_training_legend(preview, live, recorded=False):
    height, width = preview.shape[:2]
    scale = min(1.25, height / 545, width / 400)
    font, weight = 0.48 * scale, max(1, round(scale * 1.5))
    padding = max(8, round(12 * scale))
    line_height = max(15, round(24 * scale))
    rows = [("Training example", GUIDE_BAR, True)]
    if live:
        rows.append(("Recorded pose" if recorded else "Live pose", ACCENT, False))
    hint = "T  Hide training guide" if recorded else "Follow at your comfortable range."
    text_width = cv2.getTextSize(hint, cv2.FONT_HERSHEY_SIMPLEX, font, 1)[0][0]
    box_width = text_width + 2 * padding
    bottom = height - round(height * 0.09)
    top = bottom - (len(rows) + 1) * line_height - padding
    left = width - box_width - padding
    cv2.rectangle(preview, (left, top), (left + box_width, bottom), BG, -1)
    for i, (label, color, silhouette) in enumerate(rows):
        x, y = left + padding, top + (i + 1) * line_height
        bar = max(8, round(22 * scale))
        if silhouette:
            center = x + bar // 2
            cv2.circle(preview, (center, y - 12), max(2, round(3 * scale)), color, -1, cv2.LINE_AA)
            cv2.line(preview, (center, y - 7), (center, y + 1), color, weight + 3, cv2.LINE_AA)
        else:
            cv2.line(preview, (x, y - 5), (x + bar, y - 5), color, weight + 1, cv2.LINE_AA)
        draw_text(preview, label, x + bar + padding, y, font, color, weight)
    draw_text(preview, hint, left + padding, bottom - padding, font, INK)


def draw_mobility_guide(display, preview_width, preview_height, session):
    exercise = EXERCISES[session.exercise]
    guide_height = min(preview_height, 325)
    top = (preview_height - guide_height) // 2
    cv2.rectangle(display, (0, top), (preview_width - 1, top + guide_height - 1), BG, -1)
    draw_text(display, f"{exercise['short'].upper()} EXAMPLE", 16, top + 26, 0.50, ACCENT)
    floor = top + guide_height - 36
    cv2.line(display, (12, floor), (preview_width - 12, floor), POSE_OUTLINE, 1, cv2.LINE_AA)
    labels = ("Start", exercise["out"], exercise["peak"])
    poses = [guide_joints(session.exercise, progress) for progress in (0, 0.55, 1)]
    positions = [x for joints in poses for x, _ in joints.values()]
    left, right = min(positions), max(positions)
    panel_width = preview_width / len(poses)
    leg = min((guide_height - 76) / 2, (panel_width - 24) / max(0.55, right - left))
    floor_offset = {"push-up": 8 / 198, "knee-raise": 0.07}.get(session.exercise, 0)
    for i, joints in enumerate(poses):
        center = (i + 0.5) * panel_width
        x = center - (left + right) / 2 * leg
        points = {name: (round(x + px * leg), round(floor + (py - floor_offset) * leg))
                  for name, (px, py) in joints.items()}
        for first, second in GUIDE_CONNECTIONS:
            if first in points and second in points:
                color = MUTED if second.startswith("far") else ACCENT
                cv2.line(display, points[first], points[second], color, 3, cv2.LINE_AA)
        cv2.circle(display, points["nose"], 7, ACCENT, 2, cv2.LINE_AA)
        label_width = cv2.getTextSize(labels[i], cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)[0][0]
        draw_text(display, labels[i], round(center - label_width / 2), floor + 20, 0.4, MUTED)


def draw_range_guide(display: np.ndarray, preview_width: int, preview_height: int, session: CaptureSession):
    if preview_width < 200:
        return
    if session.exercise != "squat":
        draw_mobility_guide(display, preview_width, preview_height, session)
        return
    live = session.state["live"]
    thigh_ratio = min(1.65, max(0.70, live["standingThighToShinRatio"])) if live else 1.1
    torso_ratio = min(0.85, max(0.35, live["standingTorsoToLegRatio"])) if live else 0.6
    max_leg = min(110, preview_height * 0.24, preview_width * 0.19)
    shin = max_leg / (1 + thigh_ratio)
    thigh = max_leg - shin
    torso = torso_ratio * max_leg

    def vector(position, length, angle):
        theta = radians(angle)
        return position[0] + length * sin(theta), position[1] - length * cos(theta)

    def pixel(position):
        return tuple(round(v) for v in position)

    guide_height = min(preview_height, round(max_leg + torso + 130))
    top = (preview_height - guide_height) // 2
    cv2.rectangle(display, (0, top), (preview_width - 1, top + guide_height - 1), BG, -1)
    depth_label = ("Shallower", "Moderate", "Deeper")[session.guide_depth]
    draw_text(display, f"{VARIANT_LABELS[session.variant].upper()} GUIDE  /  {depth_label}", 16, top + 25, 0.52, ACCENT)
    draw_text(display, "Choose a depth that feels comfortable.", 16, top + 46, 0.43, INK)
    floor = top + guide_height - 42
    thigh_fraction = thigh / max_leg
    moderate = 22 + degrees(acos(min(1, max(0, 0.20 / thigh_fraction))))
    exercise_range = moderate + (-20, 0, 15)[session.guide_depth]
    sample = [
        ("Stand tall", 3, -3, 4),
        ("Lower", 15, 15 - exercise_range * 0.6, 20),
        ("Bottom", 22, 22 - exercise_range, 32),
    ]
    barbell = session.variant == "barbell"
    for i, (label, shin_angle, thigh_angle, torso_angle) in enumerate(sample):
        x = (i + 0.5) * preview_width / 3
        ankle = (x, floor - 8)
        knee = vector(ankle, shin, shin_angle)
        hip = vector(knee, thigh, thigh_angle)
        shoulder = vector(hip, torso, torso_angle)
        head = vector(shoulder, 15, 12)
        joints = [ankle, knee, hip, shoulder]
        for first, second in zip(joints, joints[1:]):
            cv2.line(display, pixel(first), pixel(second), ACCENT, 4, cv2.LINE_AA)
            cv2.circle(display, pixel(first), 4, ACCENT, -1, cv2.LINE_AA)
        cv2.circle(display, pixel(head), 8, ACCENT, 2, cv2.LINE_AA)
        if barbell:
            # The bar sits behind the shoulder. The near plate faces this side view.
            bar = (shoulder[0] - max_leg * 0.07, shoulder[1] + max_leg * 0.04)
            elbow = vector(shoulder, max_leg * 0.22, -145 + torso_angle * 0.5)
            hand = (bar[0] + max_leg * 0.15, bar[1] - max_leg * 0.04)
            cv2.line(display, pixel(shoulder), pixel(elbow), ACCENT, 3, cv2.LINE_AA)
            cv2.line(display, pixel(elbow), pixel(hand), ACCENT, 3, cv2.LINE_AA)
            plate_radius = max(6, round(max_leg * 0.105))
            cv2.circle(display, pixel(bar), plate_radius, GUIDE_BAR, 2, cv2.LINE_AA)
            cv2.line(display, pixel(bar), pixel(hand), GUIDE_BAR, 3, cv2.LINE_AA)
            cv2.circle(display, pixel(bar), 3, GUIDE_BAR, -1, cv2.LINE_AA)
            cv2.circle(display, pixel(hand), 3, INK, -1, cv2.LINE_AA)
        else:
            elbow = vector(shoulder, max_leg * 0.22, 117 - torso_angle * 0.3)
            hand = vector(elbow, max_leg * 0.20, 100 - torso_angle * 0.35)
            cv2.line(display, pixel(shoulder), pixel(elbow), ACCENT, 3, cv2.LINE_AA)
            cv2.line(display, pixel(elbow), pixel(hand), ACCENT, 3, cv2.LINE_AA)
        cv2.line(display, (round(x - 6), floor), (round(x + 14), floor), ACCENT, 4, cv2.LINE_AA)
        width = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)[0][0]
        draw_text(display, label, round(x - width / 2), floor + 20, 0.4, MUTED)


def review_guide_progress(result, offset_ms):
    elapsed = offset_ms - result["movementStartOffsetMs"]
    metrics = result["metrics"]
    if result["exercise"] == "squat":
        outward, hold, returning = metrics["descentMs"], metrics["pauseMs"], metrics["ascentMs"]
    else:
        outward, hold, returning = metrics["outwardMs"], metrics["holdMs"], metrics["returnMs"]
    if elapsed <= 0:
        return 0
    if outward > 0 and elapsed < outward:
        return (1 - cos(pi * elapsed / outward)) / 2
    past_peak = elapsed - outward - hold
    if past_peak <= 0:
        return 1
    if returning > 0 and past_peak < returning:
        return (1 + cos(pi * past_peak / returning)) / 2
    return 0


def draw_replay(display, preview_width, preview_height, session, timestamp_ms):
    result = session.latest
    frames = result["motionTrace"]["frames"]
    offset = session.replay_position(timestamp_ms)
    joints = replay_joints_at(frames, offset)
    camera = result["camera"]
    source_width, source_height = camera["width"], camera["height"]
    crop_left, crop_width = (0, source_width) if result.get("source") == "video" else center_crop_bounds(
        source_width, source_height, exercise=result["exercise"],
    )
    scale = min((preview_width - 30) / crop_width, (preview_height - 108) / source_height)
    left = (preview_width - crop_width * scale) / 2
    top = 52 + (preview_height - 108 - source_height * scale) / 2

    def source_pixels(x, y):
        return round(left + (x - crop_left) * scale), round(top + y * scale)

    def pixels(point):
        return source_pixels(point["x"] * source_width, point["y"] * source_height)

    panel = display[:preview_height, :preview_width]
    panel[:] = BG
    exercise = result["exercise"]
    variant = result.get("variant", "bodyweight")
    label = VARIANT_LABELS[variant] if exercise == "squat" else EXERCISES[exercise]["short"]
    draw_text(panel, f"{label.upper()} REP PLAYBACK", 17, 31, 0.51, ACCENT, 2)
    show_training = session.review_training_visible and session.review_training_anchor is not None
    if show_training:
        draw_training_pose(panel, session.review_training_anchor, review_guide_progress(result, offset),
                           exercise, variant, source_pixels, scale)
    line_width = max(5, round(min(preview_width, preview_height) / 96))
    radius = line_width + 1
    segments = [(pixels(joints[start]), pixels(joints[end])) for start, end in REPLAY_CONNECTIONS
                if start in joints and end in joints]
    for start, end in segments:
        cv2.line(panel, start, end, POSE_OUTLINE, line_width + 4, cv2.LINE_AA)
    for start, end in segments:
        cv2.line(panel, start, end, ACCENT, line_width, cv2.LINE_AA)
    for point in joints.values():
        center = pixels(point)
        cv2.circle(panel, center, radius + 2, POSE_OUTLINE, -1, cv2.LINE_AA)
        cv2.circle(panel, center, radius, INK, -1, cv2.LINE_AA)
    if not joints:
        draw_text(panel, "Pose unavailable here", 17, 64, 0.56, MUTED)
    if show_training:
        draw_training_legend(panel, joints, recorded=True)
    start = max(0, result["movementStartOffsetMs"] - 250)
    length = frames[-1]["offsetMs"] - start
    progress = min(1, (offset - start) / max(1, length))
    end_x = preview_width - 18
    bar_y = preview_height - 44
    cv2.line(panel, (18, bar_y), (end_x, bar_y), MUTED, 2, cv2.LINE_AA)
    cv2.line(panel, (18, bar_y), (round(18 + (end_x - 18) * progress), bar_y), ACCENT, 3, cv2.LINE_AA)
    action = "P  Pause" if session.replay_clock is not None else "P  Replay" if progress >= 1 else "P  Resume"
    elapsed = max(0, offset - start)
    draw_text(panel, f"{action}   |   X  Close   |   {elapsed / 1000:.1f} / {length / 1000:.1f}s", 17, preview_height - 17, 0.49, INK)
    if session.review_training_anchor is not None and not show_training:
        draw_text(panel, "T  Show training guide", 17, preview_height - 63, 0.49, GUIDE_BAR)


def make_camera_preview(frame, landmarks, session, timestamp_ms, overlay_side, max_width, max_height):
    height, width = frame.shape[:2]
    crop_left, crop_width = (0, width) if session.source == "video" else center_crop_bounds(width, height, exercise=session.exercise)
    preview_scale = min(max_width / crop_width, max_height / height)
    preview = cv2.resize(frame[:, crop_left:crop_left + crop_width], (round(crop_width * preview_scale), round(height * preview_scale)))
    live = session.state["live"]
    training_visible = draw_training_overlay(preview, session, timestamp_ms, crop_left, crop_width, height)
    tracking_motion = session.armed or session.countdown_until is not None
    side = overlay_side if overlay_side is not None else live["side"] if live else None
    draw_pose(preview, landmarks, side, tracking_motion, crop_left / width, crop_width / width,
              reacquiring=tracking_motion and not live, uncertain=bool(session.state.get("continuitySide")),
              exercise=session.exercise)
    if training_visible:
        draw_training_legend(preview, live)
    return preview


def draw_framing_guide(display, preview_width, preview_height, session):
    inset_x = round(preview_width * (0.04 if session.exercise == "push-up" or session.source == "video" else 0.12))
    inset_y = round(preview_height * 0.06)
    cv2.rectangle(display, (inset_x, inset_y), (preview_width - inset_x, preview_height - inset_y), MUTED, 1, cv2.LINE_AA)


def preview_status(session, timestamp_ms):
    exercise = EXERCISES[session.exercise]
    squat = session.exercise == "squat"
    live = session.state["live"]
    setup = session.state["setup"]
    center_label = ""
    if session.countdown_until is not None:
        countdown = max(0, (session.countdown_until - timestamp_ms + 999) // 1000)
        status = f"Capture starts in {countdown}" if countdown else "Waiting for a clear pose"
        hold = "Hold your high plank." if session.exercise == "push-up" else "Hold your starting position."
        instruction = hold if live else setup["message"]
        if countdown:
            center_label = str(countdown)
    elif session.armed:
        if live:
            phase = session.state["phase"]
            rising = "Stand tall" if squat else exercise["return"]
            if live.get("finishing"):
                rising = "Hold briefly"
            status = {
                "ready": "Go when ready", "descending": "Lowering" if squat else exercise["out"],
                "bottom": exercise["peak"], "ascending": rising,
            }.get(phase, "Tracking")
            instruction = exercise["cue"]
            if live.get("finishing"):
                instruction = "Hold the high plank briefly to finish." if session.exercise == "push-up" else "Hold your starting position briefly to finish."
            elif not squat and phase != "ready":
                instruction = setup.get("message", instruction)
        else:
            status = "Reacquiring pose"
            instruction = setup.get("message", "Waiting for a clear view of your near side.")
    elif session.wait_until is not None:
        status = "Waiting for setup"
        instruction = exercise["setup"] if not setup["checks"].get("sideOn") else setup.get("message", exercise["setup"])
    elif session.replay_open:
        status = "Review your rep"
        instruction = "Play back your recorded movement as a skeleton."
    elif session.show_guide:
        status = f"{VARIANT_LABELS[session.variant]} example" if squat else "Movement example"
        instruction = "Press V to switch squat type. Use + or - to change the example depth." if squat else exercise["cue"]
        if squat and session.source == "video":
            instruction = "Use + or - to adjust the example depth."
    elif session.source == "video" and session.latest:
        status = "Recorded rep saved"
        instruction = "Press P for playback or T for the training guide." if session.review_training_anchor is not None else "Press P for playback or G for the movement example."
    elif session.latest and session.reference:
        status = "Ready for another rep" if setup["ready"] else "Check your position"
        instruction = setup.get("message", "Press Space when ready.")
    else:
        status = "Camera setup" if not setup["ready"] else "Ready to capture"
        instruction = setup.get("message", exercise["setup"])

    if not center_label and session.go_at is not None and timestamp_ms - session.go_at < 1000:
        center_label = "Go"
    return status, instruction, center_label


def draw_countdown(display, label, center, size=1):
    if not label:
        return
    radius = round(51 * size)
    weight = max(2, round(2 * size))
    font_size = 1.4 * size
    cv2.circle(display, center, radius, BG, -1, cv2.LINE_AA)
    cv2.circle(display, center, radius, ACCENT, weight, cv2.LINE_AA)
    label_width, label_height = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_size, weight)[0]
    draw_text(display, label, center[0] - label_width // 2, center[1] + label_height // 2, font_size, INK, weight)


def make_preview(frame: np.ndarray, landmarks, session: CaptureSession, timestamp_ms: int, overlay_side=None) -> np.ndarray:
    preview = make_camera_preview(frame, landmarks, session, timestamp_ms, overlay_side, 720, 555)
    preview_height, preview_width = preview.shape[:2]
    display = np.full((650, preview_width + 390, 3), BG, dtype=np.uint8)
    display[:preview_height, :preview_width] = preview
    if session.replay_open:
        draw_replay(display, preview_width, preview_height, session, timestamp_ms)
    elif session.show_guide and session.wait_until is None and not session.armed:
        draw_range_guide(display, preview_width, preview_height, session)
    elif session.source != "video" or not session.latest:
        draw_framing_guide(display, preview_width, preview_height, session)
        if not session.armed:
            label = "SHOW YOUR HEAD, HANDS AND TOES" if session.exercise == "push-up" else "CENTER YOUR HEAD AND FEET"
            draw_text(display, label, 17, 27, 0.43, INK)

    panel_x = preview_width + 24
    exercise = EXERCISES[session.exercise]
    squat = session.exercise == "squat"
    draw_text(display, "Motif", panel_x, 32, 0.57, ACCENT, 1)
    title = f"{exercise['title']} camera" if squat else exercise["title"]
    draw_text(display, title, panel_x, 68, 0.89 if squat else 0.62, INK, 2)
    detail = session.variant.upper() if squat else "SIDE VIEW"
    if session.source == "video":
        training = "TRAINING GUIDE ON" if session.review_training_visible else "TRAINING GUIDE OFF"
    elif session.training_active:
        training = "TRAINING THIS REP"
    else:
        training = "NEXT REP TRAINING ON" if session.training_next else "NEXT REP TRAINING OFF"
    draw_text(display, f"{detail}  /  {training}", panel_x, 98, 0.46, MUTED)
    draw_text(display, "F  Fullscreen", panel_x + 237, 32, 0.57, INK, 2)

    status, instruction, center_label = preview_status(session, timestamp_ms)
    countdown_y = round(preview_height * (0.29 if session.exercise == "push-up" else 0.5))
    draw_countdown(display, center_label, (preview_width // 2, countdown_y))

    draw_text(display, status, panel_x, 150, 0.72, ACCENT, 2)
    y = draw_paragraph(display, instruction, panel_x, 181) + 8
    labels = (
        ("inFrame", "Head, hands and toes visible" if session.exercise == "push-up" else "Whole body centered"),
        ("sideOn", "Facing sideways"),
        ("standing", "High plank" if session.exercise == "push-up" else "Comfortable stance"),
        ("steady", "Starting position held"),
    )
    setup = session.state["setup"]
    if not session.armed and not session.replay_open:
        for key, label in labels:
            passed = setup["checks"].get(key, False)
            cv2.circle(display, (panel_x + 5, y - 4), 4, ACCENT if passed else MUTED, -1 if passed else 1)
            draw_text(display, label, panel_x + 18, y, 0.51, INK if passed else MUTED)
            y += 23

    last_exercise = session.latest["exercise"] if session.latest else None
    if last_exercise == "squat":
        metrics = session.latest["metrics"]
        y += 12
        last_variant = VARIANT_LABELS[session.latest.get("variant", "bodyweight")]
        draw_text(display, f"Last {last_variant.lower()} rep  {metrics['descentMs'] / 1000:.1f}s down / {metrics['ascentMs'] / 1000:.1f}s up", panel_x, y, 0.49, ACCENT)
        down = metrics["averageDescentLegLengthsPerSec"]
        up = metrics["averageAscentLegLengthsPerSec"]
        draw_text(display, f"Hip speed: {down:.2f} down / {up:.2f} up (leg lengths/s)", panel_x, y + 22, 0.43)
        draw_text(display, f"Bottom knee angle: {metrics['kneeAngleAtBottomDeg']:.0f} degrees", panel_x, y + 44, 0.43)
        ratio = metrics.get("thighToShinRatio")
        ratio_text = f"{ratio:.2f}:1" if ratio is not None else "Unavailable"
        draw_text(display, f"Thigh / shin: {ratio_text} (projected)", panel_x, y + 66, 0.43)
        y = draw_paragraph(display, session.latest["cue"]["text"], panel_x, y + 90, INK)
    elif last_exercise:
        metrics = session.latest["metrics"]
        y += 12
        draw_text(display, f"Last {EXERCISES[last_exercise]['short'].lower()} rep", panel_x, y, 0.49, ACCENT)
        draw_text(display, f"Time: {metrics['outwardMs'] / 1000:.1f}s out / {metrics['returnMs'] / 1000:.1f}s back", panel_x, y + 22, 0.43)
        angular = metrics["rangeUnit"] == "degrees"
        measured = f"{metrics['range']:.1f} degrees" if angular else f"{metrics['range']:.3f} leg lengths"
        label = EXERCISES[last_exercise]["range_label"]
        draw_text(display, f"{label}: {measured} (projected)", panel_x, y + 44, 0.43)
        unit = "deg/s" if angular else "leg lengths/s"
        out, back = metrics["averageOutwardSpeedPerSec"], metrics["averageReturnSpeedPerSec"]
        draw_text(display, f"Speed: {out:.2f} out / {back:.2f} back {unit}", panel_x, y + 66, 0.43)
        y = draw_paragraph(display, session.latest["cue"]["text"], panel_x, y + 90, INK)
    if session.notice:
        draw_paragraph(display, session.notice, panel_x, min(max(y + 6, 338), 500), MUTED)

    snapshot_labels = PHASE_LABELS.copy()
    if last_exercise and last_exercise != "squat":
        info = EXERCISES[last_exercise]
        snapshot_labels.update(descent=info["out"], bottom=info["peak"], ascent=info["return"])
    for i, (phase, image) in enumerate(session.thumbnails):
        x = panel_x + i * 68
        thumb_height, thumb_width = image.shape[:2]
        thumb_scale = min(58 / thumb_width, 44 / thumb_height)
        tw, th = max(1, round(thumb_width * thumb_scale)), max(1, round(thumb_height * thumb_scale))
        thumb = cv2.resize(image, (tw, th), interpolation=cv2.INTER_AREA)
        offset_x, offset_y = x + (58 - tw) // 2, 549 + (44 - th) // 2
        display[offset_y:offset_y + th, offset_x:offset_x + tw] = thumb
        draw_text(display, snapshot_labels[phase], x + 2, 612, 0.38, MUTED)

    if session.source == "video":
        draw_text(display, "P  Playback  |  T  Training guide  |  G  Example  |  F  Fullscreen", 22, 583, 0.43)
        draw_text(display, "X  Close playback  |  Esc  Quit", 22, 615, 0.41, MUTED)
    else:
        draw_text(display, "Space  Arm  |  M  Exercise  |  G  Example  |  T  Training  |  P  Playback", 22, 583, 0.43)
        draw_text(display, "X  Cancel  |  E  Save  |  C  Clear  |  R  Reset  |  V  Squat type  |  Esc  Quit", 22, 615, 0.41, MUTED)
    return display


def fit_preview(display, width, height):
    source_height, source_width = display.shape[:2]
    scale = min(width / source_width, height / source_height)
    fitted_width = max(1, round(source_width * scale))
    fitted_height = max(1, round(source_height * scale))
    canvas = np.full((height, width, 3), BG, dtype=np.uint8)
    left, top = (width - fitted_width) // 2, (height - fitted_height) // 2
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    canvas[top:top + fitted_height, left:left + fitted_width] = cv2.resize(
        display, (fitted_width, fitted_height), interpolation=interpolation,
    )
    return canvas


def draw_fullscreen_label(image, text, x, baseline, scale, weight=1, color=INK, right=False):
    size, below = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, weight)
    if right:
        x -= size[0]
    padding = max(6, round(10 * scale))
    cv2.rectangle(image, (x - padding, baseline - size[1] - padding),
                  (x + size[0] + padding, baseline + below + padding // 2), BG, -1)
    draw_text(image, text, x, baseline, scale, color, weight)


def make_fullscreen_preview(frame, landmarks, session, timestamp_ms, overlay_side, width, height):
    preview = make_camera_preview(frame, landmarks, session, timestamp_ms, overlay_side, width, height)
    preview_height, preview_width = preview.shape[:2]
    if session.replay_open or (session.show_guide and session.wait_until is None and not session.armed):
        scale = min(1, 720 / preview_width, 555 / preview_height)
        small_width, small_height = round(preview_width * scale), round(preview_height * scale)
        small = cv2.resize(preview, (small_width, small_height))
        if session.replay_open:
            draw_replay(small, small_width, small_height, session, timestamp_ms)
        else:
            draw_range_guide(small, small_width, small_height, session)
        preview = cv2.resize(small, (preview_width, preview_height))
    elif session.source != "video" or not session.latest:
        draw_framing_guide(preview, preview_width, preview_height, session)
    left, top = (width - preview_width) // 2, (height - preview_height) // 2
    display = np.full((height, width, 3), BG, dtype=np.uint8)
    display[top:top + preview_height, left:left + preview_width] = preview

    scale = min(width / 1150, height / 700)
    weight = max(1, round(scale * 2))
    margin = round(24 * scale)
    status_y = round(52 * scale)
    status, instruction, center_label = preview_status(session, timestamp_ms)
    draw_fullscreen_label(display, status, margin, status_y, 1.22 * scale, weight, ACCENT)
    draw_fullscreen_label(display, "F  Exit fullscreen", width - margin, status_y, 0.9 * scale, weight, right=True)
    fullscreen_hint = session.notice if not session.armed and not session.wait_until and session.notice else instruction
    for i, line in enumerate(textwrap.wrap(fullscreen_hint, width=62)):
        draw_fullscreen_label(display, line, margin, round((91 + 30 * i) * scale), 0.72 * scale, weight)
    countdown_y = round(height * (0.29 if session.exercise == "push-up" else 0.5))
    draw_countdown(display, center_label, (width // 2, countdown_y), max(0.3, 1.55 * scale))
    controls = "Space  Arm   |   X  Cancel/close   |   G  Example   |   P  Playback   |   E  Save"
    if session.source == "video":
        controls = "P  Playback   |   T  Training guide   |   G  Example   |   X  Close   |   Esc  Quit"
    draw_fullscreen_label(display, controls, margin, height - round(28 * scale), 0.7 * scale, weight)
    return display


def window_size():
    try:
        _, _, width, height = cv2.getWindowImageRect(WINDOW)
        if width >= 320 and height >= 240:
            return width, height
    except cv2.error:
        pass
    return 1000, 650


def create_detector():
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_presence_confidence=0.42,
    )
    return mp.tasks.vision.PoseLandmarker.create_from_options(options)


def show_preview(frame, landmarks, session, timestamp_ms, side, fullscreen):
    width, height = window_size()
    if fullscreen:
        display = make_fullscreen_preview(frame, landmarks, session, timestamp_ms, side, width, height)
    else:
        display = fit_preview(make_preview(frame, landmarks, session, timestamp_ms, side), width, height)
    cv2.imshow(WINDOW, display)


def review_video_capture(frame, landmarks, session):
    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL | cv2.WINDOW_FREERATIO)
    cv2.resizeWindow(WINDOW, 1000, 650)
    fullscreen = False
    opened_at = time.monotonic()
    session.toggle_replay(0)
    try:
        while cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) >= 1:
            timestamp_ms = round((time.monotonic() - opened_at) * 1000)
            show_preview(frame, landmarks, session, timestamp_ms, session.latest["trackingSide"], fullscreen)
            key = cv2.waitKey(16) & 0xFF
            if key in (27, ord("q"), ord("Q")):
                break
            if key in (ord("f"), ord("F")):
                fullscreen = not fullscreen
                mode = cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL
                cv2.setWindowProperty(WINDOW, cv2.WND_PROP_FULLSCREEN, mode)
            elif key in (ord("p"), ord("P")):
                session.show_guide = False
                session.toggle_replay(timestamp_ms)
            elif key in (ord("t"), ord("T")):
                if session.review_training_anchor is None:
                    session.notice = "Guide unavailable for this starting pose. Press G for the movement example."
                else:
                    session.show_guide = False
                    session.review_training_visible = not session.review_training_visible
                    if not session.replay_open:
                        session.toggle_replay(timestamp_ms)
            elif key in (ord("x"), ord("X")):
                session.show_guide = False
                session.close_replay()
            elif key in (ord("g"), ord("G")):
                session.close_replay()
                session.show_guide = not session.show_guide
            elif session.show_guide and session.exercise == "squat" and key in (ord("+"), ord("="), ord("-")):
                session.guide_depth = min(2, max(0, session.guide_depth + (-1 if key == ord("-") else 1)))
    finally:
        cv2.destroyAllWindows()


def run_video(path: Path, output: Path, variant="bodyweight", exercise="squat", review=False, training=False):
    if not path.is_file():
        raise RuntimeError(f"Video file not found: {path}")
    video = cv2.VideoCapture(str(path))
    session = CaptureSession(output, variant, exercise, source="video")
    try:
        if not video.isOpened():
            raise RuntimeError(f"Could not open {path.name}. Check that it is a readable video file.")
        fps = video.get(cv2.CAP_PROP_FPS)
        frame_interval = 1000 / fps if isfinite(fps) and fps > 0 else None
        previous_time = None
        next_sample_at = 0
        last_discard = ""
        print(f"Analyzing {path.name} locally for one {EXERCISES[exercise]['title'].lower()}.", flush=True)
        with create_detector() as detector:
            while True:
                ok, frame = video.read()
                if not ok:
                    break
                time_ms = video.get(cv2.CAP_PROP_POS_MSEC)
                if not isfinite(time_ms) or time_ms < 0 or (previous_time is not None and time_ms <= previous_time):
                    if frame_interval is None:
                        raise RuntimeError("The video does not have readable timestamps. Try exporting it as a standard MP4.")
                    time_ms = 0 if previous_time is None else previous_time + frame_interval
                previous_time = time_ms
                timestamp_ms = round(time_ms)
                if timestamp_ms + 2 < next_sample_at:
                    continue
                elapsed_intervals = max(1, int((timestamp_ms + 2 - next_sample_at) / POSE_INTERVAL_MS) + 1)
                next_sample_at += elapsed_intervals * POSE_INTERVAL_MS
                if session.wait_until is None:
                    last_discard = session.notice or last_discard
                    session.training_next = training
                    session.start(timestamp_ms)
                landmarks = detect_centered_pose(detector, frame, timestamp_ms, exercise, full_frame=True)
                session.update(frame, landmarks, timestamp_ms)
                if session.latest:
                    break
        if previous_time is None:
            raise RuntimeError(f"Could not decode any video frames in {path.name}.")
        if not session.latest:
            detail = session.notice or last_discard or session.state["setup"].get("message")
            message = "No complete rep found. Include a clear side view and hold the starting and ending positions in the video."
            raise RuntimeError(f"{message} {detail}" if detail else message)
    finally:
        video.release()
    if session.save() is None:
        raise RuntimeError(f"Could not write the rep to {output}.")
    if training:
        if session.review_training_anchor is None:
            print("The guide could not align to the recorded starting pose.")
        elif not review:
            print("Training guide aligned. Add --review to see it alongside the recorded skeleton.")
    if review:
        review_video_capture(frame, landmarks, session)


def run_camera(index: int, output: Path, quiet: bool, variant="bodyweight", exercise="squat", training=False):
    camera = cv2.VideoCapture(index)
    try:
        if not camera.isOpened():
            raise RuntimeError(f"Could not open camera {index}. Close other camera apps or choose another index with --camera.")
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        camera.set(cv2.CAP_PROP_FPS, 30)

        session = CaptureSession(output, variant, exercise, training)
        opened_at = time.monotonic()
        session.start(0)
        next_sample_at = 0
        last_frame = opened_at
        preview_frame = None
        overlay = LiveOverlay()
        fullscreen = False
        cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL | cv2.WINDOW_FREERATIO)
        cv2.resizeWindow(WINDOW, 1000, 650)
        with create_detector() as detector:
            while cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) >= 1:
                ok, frame = camera.read()
                now = time.monotonic()
                timestamp_ms = round((now - opened_at) * 1000)
                if ok:
                    preview_frame = frame
                    last_frame = now
                elif now - last_frame > 2:
                    raise RuntimeError("The camera stopped delivering video. Reconnect it and try again.")
                if preview_frame is None:
                    if cv2.waitKey(20) & 0xFF in (27, ord("q")):
                        break
                    continue
                if timestamp_ms + 2 >= next_sample_at:
                    landmarks = detect_centered_pose(detector, frame, timestamp_ms, session.exercise) if ok else None
                    session.update(preview_frame, landmarks, timestamp_ms)
                    live = session.state["live"]
                    side = live["side"] if live else session.state.get("continuitySide")
                    overlay.update(landmarks, side, timestamp_ms)
                    if session.go_at == timestamp_ms and not quiet:
                        play_go_sound()
                    elapsed_intervals = max(1, int((timestamp_ms + 2 - next_sample_at) / POSE_INTERVAL_MS) + 1)
                    next_sample_at += elapsed_intervals * POSE_INTERVAL_MS

                preview_time = round((time.monotonic() - opened_at) * 1000)
                render_points, render_side = overlay.at(preview_time)
                show_preview(preview_frame, render_points, session, preview_time, render_side, fullscreen)
                key = cv2.waitKey(1 if ok else 20) & 0xFF
                if key in (27, ord("q")):
                    break
                if key in (ord("f"), ord("F")):
                    fullscreen = not fullscreen
                    mode = cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL
                    cv2.setWindowProperty(WINDOW, cv2.WND_PROP_FULLSCREEN, mode)
                elif key == ord(" "):
                    session.start(timestamp_ms)
                elif key in (ord("x"), ord("X")):
                    if session.replay_open:
                        session.close_replay()
                    else:
                        session.cancel()
                        session.notice = "Capture cancelled."
                elif key in (ord("r"), ord("R")):
                    session.recalibrate()
                elif key in (ord("e"), ord("E")):
                    session.save()
                elif key in (ord("c"), ord("C")):
                    session.clear_result()
                elif key in (ord("p"), ord("P")):
                    session.toggle_replay(timestamp_ms)
                elif key in (ord("v"), ord("V")):
                    session.toggle_variant()
                elif key in (ord("m"), ord("M")):
                    session.cycle_exercise()
                elif key in (ord("t"), ord("T")):
                    session.toggle_training()
                elif key in (ord("g"), ord("G")):
                    session.close_replay()
                    session.show_guide = not session.show_guide
                    if session.show_guide and session.wait_until is not None:
                        session.cancel()
                elif session.show_guide and session.exercise == "squat" and key in (ord("+"), ord("="), ord("-")):
                    change = -1 if key == ord("-") else 1
                    session.guide_depth = min(2, max(0, session.guide_depth + change))
    finally:
        camera.release()
        cv2.destroyAllWindows()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--camera", type=int, default=0, help="OpenCV webcam index (default: 0)")
    inputs.add_argument("--video", type=Path, help="analyze the first complete rep in a local video file and save its JSON")
    parser.add_argument("--review", action="store_true", help="open the recorded rep in the desktop preview when --video finishes")
    parser.add_argument("--output", type=Path, default=Path("captures"), help="folder for your exported rep JSON")
    parser.add_argument("--quiet", action="store_true", help="skip the Windows cue sound when capture begins")
    parser.add_argument("--variant", choices=tuple(VARIANT_LABELS), default="bodyweight",
                        help="initial squat type for the guide and capture (press V to switch when idle)")
    parser.add_argument("--exercise", choices=tuple(EXERCISES), default="squat",
                        help="initial exercise (press M to switch when idle)")
    parser.add_argument("--training", action="store_true", help="show the training guide for the first live rep or in --video --review")
    args = parser.parse_args()
    if args.camera < 0:
        parser.error("--camera must be zero or greater")
    if args.review and not args.video:
        parser.error("--review requires --video")
    if not MODEL_PATH.is_file():
        print(f"Pose model missing at {MODEL_PATH}", file=sys.stderr)
        return 1
    try:
        if args.video:
            run_video(args.video, args.output, args.variant, args.exercise, args.review, args.training)
        else:
            run_camera(args.camera, args.output, args.quiet, args.variant, args.exercise, args.training)
    except (RuntimeError, cv2.error) as error:
        print(error, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

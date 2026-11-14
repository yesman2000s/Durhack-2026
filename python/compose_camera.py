"""Run the COMPOSE bodyweight squat camera as a local desktop app."""

from __future__ import annotations

import argparse
import base64
from bisect import bisect_right
from datetime import datetime, timezone
import json
from math import acos, cos, degrees, isfinite, radians, sin
from pathlib import Path
import sys
import textwrap
import time
import uuid

try:
    import winsound
except ImportError:
    winsound = None

import cv2
import mediapipe as mp
import numpy as np

from squat_tracker import SquatTracker


MODEL_PATH = Path(__file__).resolve().parents[1] / "public" / "models" / "pose_landmarker_lite.task"
WINDOW = "COMPOSE - Squat Camera"
POSE_CROP_WIDTH_PER_HEIGHT = 0.95
CENTERED_BODY_MARGIN = 0.175
COUNTDOWN_MS = 3000
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
    "proportionMethod": "Approximate ratios projected from standing, without absolute height or distance calibration.",
    "measurementLimits": "Estimates from one side in 2D. Do not infer side-to-side knee alignment, spinal loading, overall safety, or balance.",
}
SIDE_CONNECTIONS = {
    "left": ((11, 23), (23, 25), (25, 27), (27, 29), (29, 31)),
    "right": ((12, 24), (24, 26), (26, 28), (28, 30), (30, 32)),
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
DISCARD_MESSAGES = {
    "tracking-gap": "Tracking was lost. Keep your near hip, knee and ankle visible throughout the squat.",
    "foot-moved": "Your foot position changed. Stand still and press Space to set up again.",
    "timeout": "No complete rep was detected in time. Press Space to try again.",
    "incomplete-descent": "The camera saw a small bend. Try one continuous squat through your comfortable range.",
    "incomplete-ascent": "The camera missed part of the rise. Stand tall briefly at the end of your next rep.",
    "low-confidence": "Part of the squat was obscured. Improve the lighting and keep your near side visible.",
    "second-descent": "The camera saw a second lowering motion. Finish one rep before starting again.",
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


def center_crop_bounds(width: int, height: int) -> tuple[int, int]:
    crop_width = min(width, max(1, int(height * POSE_CROP_WIDTH_PER_HEIGHT + 0.5)))
    return (width - crop_width) // 2, crop_width


def detect_centered_pose(detector, frame: np.ndarray, timestamp_ms: int):
    height, width = frame.shape[:2]
    left, crop_width = center_crop_bounds(width, height)
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


def pose_within_center(landmarks, width: int, height: int) -> bool:
    left, crop_width = center_crop_bounds(width, height)
    if crop_width == width or not landmarks:
        return True

    pairs = ((landmarks[23], landmarks[27]), (landmarks[24], landmarks[28]))
    candidates = [
        (hip.visibility + ankle.visibility, (hip.x + ankle.x) / 2)
        for hip, ankle in pairs
        if (hip.visibility or 0) >= 0.55 and (ankle.visibility or 0) >= 0.55 and isfinite(hip.x) and isfinite(ankle.x)
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
            "visibility": point.visibility if point.visibility is not None and isfinite(point.visibility) else None,
        }
        for name, index in indices.items()
        if isfinite((point := landmarks[index + (offset if index else 0)]).x) and isfinite(point.y)
    }


def motion_sample(landmarks, live, timestamp_ms):
    if not live or not landmarks:
        return None
    joints = pose_joints(landmarks, live["side"], MOTION_JOINTS)
    if live["torsoLeanDeg"] is None:
        joints.pop("shoulder", None)
    if not all(name in joints for name in ("hip", "knee", "ankle")):
        return None
    return {
        "timestampMs": timestamp_ms,
        "joints": {
            name: {
                "x": round(point["x"], 4), "y": round(point["y"], 4),
                "visibility": round(point["visibility"], 3) if point["visibility"] is not None else None,
            }
            for name, point in joints.items()
        },
    }


def make_motion_trace(samples, start_ms, movement_start_ms):
    frames = [
        {"offsetMs": round(sample["timestampMs"] - start_ms), "joints": sample["joints"]}
        for i, sample in enumerate(samples)
        if i == 0 or sample["timestampMs"] >= movement_start_ms - 400
    ]
    return {"frames": frames}


def visible_motion_joints(joints):
    thresholds = {"hip": 0.35, "knee": 0.35, "ankle": 0.35, "shoulder": 0.35}
    return {
        name: point for name, point in joints.items()
        if 0 <= point["x"] <= 1 and 0 <= point["y"] <= 1
        and (point["visibility"] if point["visibility"] is not None else 1) >= thresholds.get(name, 0.55)
    }


def replay_joints_at(frames, offset_ms):
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
    return {
        name: {axis: point[axis] + (second[name][axis] - point[axis]) * t for axis in ("x", "y")}
        for name, point in first.items() if name in second
    }


def capture_snapshot(frame: np.ndarray, timestamp_ms: float, landmarks, live: dict | None) -> dict:
    height, width = frame.shape[:2]
    scale = min(1, 960 / max(width, height))
    if scale < 1:
        width, height = round(width * scale), round(height * scale)
        frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 84])
    if not ok:
        raise RuntimeError("Could not encode a squat snapshot.")
    snapshot = {
        "timestampMs": timestamp_ms,
        "width": width,
        "height": height,
        "mimeType": "image/jpeg",
        "imageBase64": base64.b64encode(encoded).decode("ascii"),
        "kneeAngleDeg": live["kneeAngleDeg"] if live else None,
    }
    if live and landmarks:
        snapshot["pose"] = {
            "side": live["side"],
            "hipAngleDeg": live["hipAngleDeg"],
            "torsoLeanDeg": live["torsoLeanDeg"],
            "shinLeanDeg": live["shinLeanDeg"],
            "hipDropLegLengths": live["hipDropRatio"],
            "hipToKneeLegLengths": live["hipToKneeRatio"],
            "hipSpeedLegLengthsPerSec": live["hipSpeedLegLengthsPerSec"],
            "joints": pose_joints(landmarks, live["side"]),
        }
    return snapshot


def make_evidence(rep: dict, frames: dict, camera: dict, reference: dict, captured_at: str,
                  capture_start_ms: int, motion_samples=(), variant="bodyweight") -> dict:
    metrics = dict(rep["metrics"])
    metrics["kneeExcursionDeg"] = metrics["startKneeAngleDeg"] - metrics["kneeAngleAtBottomDeg"]
    metrics["returnAngleErrorDeg"] = abs(metrics["startKneeAngleDeg"] - metrics["finishKneeAngleDeg"])
    snapshots = []
    for phase in PHASES:
        if phase in frames:
            image = dict(frames[phase])
            offset = round(image.pop("timestampMs") - capture_start_ms)
            snapshots.append({"phase": phase, "offsetMs": offset, **image})
    if reference["establishedByThisRep"]:
        cue = {"code": "BASELINE_CAPTURED", "text": "This rep established your personal range reference for this camera setup."}
    else:
        cue = {"code": "OBSERVED_CYCLE", "text": "Captured one down and up cycle from the same side view."}
    return {
        "schemaVersion": 1,
        "id": str(uuid.uuid4()),
        "exercise": "squat",
        "variant": variant,
        "captureMode": "single-rep",
        "source": "webcam",
        "capturedAt": captured_at,
        "camera": camera,
        "trackingSide": rep["side"],
        "movementStartOffsetMs": round(rep["startedAtMs"] - capture_start_ms),
        "reference": reference,
        "metrics": metrics,
        "cue": cue,
        "observations": rep["cues"],
        "practiceGuide": PRACTICE_GUIDE,
        "snapshots": snapshots,
        "motionTrace": make_motion_trace(motion_samples, capture_start_ms, rep["startedAtMs"]),
    }


class CaptureSession:
    def __init__(self, output: Path, variant="bodyweight"):
        self.output = output
        self.variant = variant
        self.tracker = SquatTracker()
        self.profile_id = str(uuid.uuid4())
        self.frame_size = None
        self.reference = None
        self.latest = None
        self.thumbnails = []
        self.show_guide = False
        self.guide_depth = 1
        self.snapshots = {}
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
        self.state = {"phase": "setup", "setup": {"ready": False, "checks": {}}, "live": None}
        self.notice = ""

    def start(self, timestamp_ms: int):
        if self.armed or self.wait_until is not None:
            return
        self.cancel()
        self.notice = ""
        self.wait_until = timestamp_ms + 45000

    def cancel(self):
        self.wait_until = None
        self.armed_at = None
        self.go_at = None
        self.active_since = None
        self.clear_countdown()
        self.close_replay()

    def clear_countdown(self):
        self.countdown_until = None
        self.countdown_started_at = None
        self.capture_timestamp = None
        self.snapshots.clear()
        self.motion_samples = []

    def keep_motion_sample(self, landmarks, live, timestamp_ms, force=False):
        if self.motion_samples:
            elapsed = timestamp_ms - self.motion_samples[-1]["timestampMs"]
            if elapsed <= 0 or (not force and elapsed < MOTION_SAMPLE_INTERVAL_MS):
                return
        sample = motion_sample(landmarks, live, timestamp_ms)
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
        self.wait_until = None
        self.countdown_until = None
        self.armed_at = self.countdown_started_at
        self.active_since = timestamp_ms
        if not early:
            self.go_at = timestamp_ms

    @property
    def armed(self):
        return self.armed_at is not None

    def recalibrate(self):
        self.cancel()
        self.tracker.reset()
        self.profile_id = str(uuid.uuid4())
        self.reference = None
        self.state = {"phase": "setup", "setup": {"ready": False, "checks": {}}, "live": None}
        self.notice = "Setup reset. Check your framing and stand still."

    def save(self):
        if not self.latest:
            self.notice = "Capture an assessed rep before saving."
            return
        try:
            self.output.mkdir(parents=True, exist_ok=True)
            path = self.output / f"compose-squat-{self.latest['id']}.json"
            path.write_text(json.dumps(self.latest, indent=2, allow_nan=False), encoding="utf-8")
        except (OSError, ValueError) as error:
            self.notice = "Could not save the rep. Check the output folder."
            print(f"Save failed: {error}", file=sys.stderr)
            return
        self.notice = "Saved the rep and snapshots."
        print(f"Saved {path.resolve()}")

    def clear_result(self):
        self.latest = None
        self.thumbnails = []
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
        centered = pose_within_center(landmarks, width, height)
        self.state = self.tracker.update(
            landmarks if centered or tracking_motion else None,
            timestamp_ms, width, height, armed=tracking_motion, lock_standing=tracking_motion,
        )
        if not tracking_motion and (not centered or (not landmarks and center_crop_bounds(width, height)[1] < width)):
            self.state["setup"]["message"] = "Step into the center with your head and feet visible."
        live = self.state["live"]
        ready = centered and self.state["setup"]["ready"] and self.state["phase"] == "ready"
        if self.reference and not tracking_motion and ready and live and live["side"] != self.reference["trackingSide"]:
            self.reference = None
            self.profile_id = str(uuid.uuid4())

        if tracking_motion:
            finished = any(event["type"] == "rep-complete" for event in self.state["events"])
            self.keep_motion_sample(landmarks, live, timestamp_ms, force=finished)
        if self.wait_until is not None:
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
                    if timestamp_ms >= self.countdown_until and centered and checks["sideOn"] and checks["standing"]:
                        self.begin_capture(timestamp_ms)
            elif ready:
                self.countdown_started_at = timestamp_ms
                self.countdown_until = timestamp_ms + COUNTDOWN_MS
                self.capture_timestamp = now_iso()
                self.snapshots["start"] = capture_snapshot(frame, timestamp_ms, landmarks, live)
                self.keep_motion_sample(landmarks, live, timestamp_ms)
            if not movement_started or not self.armed:
                return

        if not self.armed:
            return
        if timestamp_ms - self.active_since > 20000:
            self.cancel()
            self.tracker.reset()
            self.notice = "No complete rep was detected in time. Stand tall and try again."
            return
        if not self.state["events"] and self.state["phase"] == "setup" and timestamp_ms - self.active_since > 800:
            self.cancel()
            self.notice = "Your pose left the setup area. Check the framing and try again."
            return

        for event in self.state["events"]:
            if event["type"] == "capture":
                phase = event["phase"]
                if phase != "start" or "start" not in self.snapshots:
                    self.snapshots[phase] = capture_snapshot(frame, timestamp_ms, landmarks, live)
            elif event["type"] == "rep-discarded":
                self.cancel()
                self.notice = DISCARD_MESSAGES.get(event["reason"], "The full rep could not be tracked. Check your framing and try again.")
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
                        "kneeExcursionDeg": metrics["startKneeAngleDeg"] - metrics["kneeAngleAtBottomDeg"],
                        "standingKneeAngleDeg": metrics["startKneeAngleDeg"],
                        "torsoLeanAtBottomDeg": metrics["torsoLeanAtBottomDeg"],
                        "bottomHipToKneeLegLengths": metrics["bottomHipToKneeLegLengths"],
                        "standingThighToShinRatio": metrics["standingThighToShinRatio"],
                        "standingTorsoToLegRatio": metrics["standingTorsoToLegRatio"],
                    }
                camera = {"id": self.profile_id, "width": width, "height": height, "view": "side"}
                reference = {**self.reference, "establishedByThisRep": established_here}
                self.latest = make_evidence(
                    rep, self.snapshots, camera, reference, self.capture_timestamp,
                    self.armed_at, self.motion_samples, self.variant,
                )
                self.thumbnails = []
                for snapshot in self.latest["snapshots"]:
                    jpeg = np.frombuffer(base64.b64decode(snapshot["imageBase64"]), dtype=np.uint8)
                    image = cv2.imdecode(jpeg, cv2.IMREAD_COLOR)
                    if image is not None:
                        self.thumbnails.append((snapshot["phase"], image))
                self.notice = "Rep captured. Press P to play or E to save."
                self.cancel()
                break


def draw_pose(frame: np.ndarray, landmarks, side: str | None, tracking: bool, crop_left: float, crop_width: float):
    if not landmarks:
        return
    height, width = frame.shape[:2]
    if side not in SIDE_CONNECTIONS:
        return

    def usable(point, index):
        threshold = 0.30 if tracking and index in (11, 12) else 0.35 if tracking and 23 <= index <= 28 else 0.55
        return (point.visibility or 0) >= threshold and crop_left <= point.x <= crop_left + crop_width and 0 <= point.y <= 1

    def pixel(point):
        return (round((point.x - crop_left) / crop_width * width), round(point.y * height))

    for a, b in SIDE_CONNECTIONS[side]:
        first, second = landmarks[a], landmarks[b]
        if not usable(first, a) or not usable(second, b):
            continue
        start, end = pixel(first), pixel(second)
        cv2.line(frame, start, end, ACCENT, 2, cv2.LINE_AA)
        cv2.circle(frame, start, 5, ACCENT, -1, cv2.LINE_AA)
        cv2.circle(frame, end, 5, ACCENT, -1, cv2.LINE_AA)


def draw_text(image: np.ndarray, value: str, x: int, y: int, scale=0.56, color=INK, weight=1):
    cv2.putText(image, value, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, weight, cv2.LINE_AA)


def draw_paragraph(image: np.ndarray, value: str, x: int, y: int, color=INK):
    for line in textwrap.wrap(value, width=39):
        draw_text(image, line, x, y, color=color)
        y += 24
    return y


def draw_range_guide(display: np.ndarray, preview_width: int, preview_height: int, session: CaptureSession):
    if preview_width < 200:
        return
    live = session.state["live"]
    thigh_ratio = live["standingThighToShinRatio"] if live else 1.1
    torso_ratio = live["standingTorsoToLegRatio"] if live else 0.6
    max_leg = min(110, preview_height * 0.24)
    shin = max_leg / (1 + thigh_ratio)
    thigh = max_leg - shin
    torso = torso_ratio * max_leg

    def vector(position, length, angle):
        theta = radians(angle)
        return position[0] + length * sin(theta), position[1] - length * cos(theta)

    def pixel(position):
        return tuple(round(v) for v in position)

    guide_height = min(preview_height, round(max_leg + torso + 102))
    top = (preview_height - guide_height) // 2
    cv2.rectangle(display, (0, top), (preview_width - 1, top + guide_height - 1), BG, -1)
    depth_label = ("Shallower", "Moderate", "Deeper")[session.guide_depth]
    draw_text(display, f"SIDE VIEW GUIDE  /  {depth_label}", 20, top + 25, 0.57, ACCENT)
    draw_text(display, "Illustrative positions. Choose a comfortable depth.", 20, top + 46, 0.43, INK)
    floor = top + guide_height - 42
    thigh_fraction = thigh / max_leg
    moderate = 22 + degrees(acos(min(1, max(0, 0.20 / thigh_fraction))))
    exercise_range = moderate + (-20, 0, 15)[session.guide_depth]
    sample = [
        ("Stand tall", 3, -3, 4),
        ("Lower", 15, 15 - exercise_range * 0.6, 20),
        ("Comfortable bottom", 22, 22 - exercise_range, 32),
    ]
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
        cv2.line(display, (round(x - 6), floor), (round(x + 14), floor), ACCENT, 4, cv2.LINE_AA)
        width = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)[0][0]
        draw_text(display, label, round(x - width / 2), floor + 20, 0.4, MUTED)


def draw_replay(display, preview_width, preview_height, session, timestamp_ms):
    result = session.latest
    frames = result["motionTrace"]["frames"]
    offset = session.replay_position(timestamp_ms)
    joints = replay_joints_at(frames, offset)
    camera = result["camera"]
    source_width, source_height = camera["width"], camera["height"]
    crop_left, crop_width = center_crop_bounds(source_width, source_height)
    scale = min((preview_width - 30) / crop_width, (preview_height - 108) / source_height)
    left = (preview_width - crop_width * scale) / 2
    top = 52 + (preview_height - 108 - source_height * scale) / 2

    def pixels(point):
        x = left + (point["x"] * source_width - crop_left) * scale
        y = top + point["y"] * source_height * scale
        return round(x), round(y)

    panel = display[:preview_height, :preview_width]
    panel[:] = BG
    draw_text(panel, "REP PLAYBACK", 17, 31, 0.58, ACCENT, 2)
    for start, end in REPLAY_CONNECTIONS:
        if start in joints and end in joints:
            cv2.line(panel, pixels(joints[start]), pixels(joints[end]), ACCENT, 3, cv2.LINE_AA)
    for point in joints.values():
        cv2.circle(panel, pixels(point), 4, INK, -1, cv2.LINE_AA)
    if not joints:
        draw_text(panel, "Pose unavailable here", 17, 64, 0.56, MUTED)
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


def make_preview(frame: np.ndarray, landmarks, session: CaptureSession, timestamp_ms: int) -> np.ndarray:
    height, width = frame.shape[:2]
    crop_left, crop_width = center_crop_bounds(width, height)
    preview_scale = min(720 / crop_width, 555 / height)
    preview = cv2.resize(frame[:, crop_left:crop_left + crop_width], (round(crop_width * preview_scale), round(height * preview_scale)))
    live = session.state["live"]
    tracking_motion = session.armed or session.countdown_until is not None
    draw_pose(preview, landmarks, live["side"] if live else None, tracking_motion, crop_left / width, crop_width / width)
    preview_height, preview_width = preview.shape[:2]
    display = np.full((650, preview_width + 390, 3), BG, dtype=np.uint8)
    display[:preview_height, :preview_width] = preview
    inset_x, inset_y = round(preview_width * 0.12), round(preview_height * 0.06)
    cv2.rectangle(display, (inset_x, inset_y), (preview_width - inset_x, preview_height - inset_y), MUTED, 1, cv2.LINE_AA)
    if session.replay_open:
        draw_replay(display, preview_width, preview_height, session, timestamp_ms)
    elif session.show_guide and session.wait_until is None and not session.armed:
        draw_range_guide(display, preview_width, preview_height, session)
    elif not session.armed:
        draw_text(display, "CENTER YOUR HEAD AND FEET", 17, 27, 0.43, INK)

    panel_x = preview_width + 24
    draw_text(display, "COMPOSE", panel_x, 32, 0.57, ACCENT, 1)
    draw_text(display, "Squat Camera", panel_x, 68, 0.93, INK, 2)
    draw_text(display, f"{session.variant.upper()}  /  CENTERED SIDE VIEW", panel_x, 98, 0.49, MUTED)

    setup = session.state["setup"]
    if session.countdown_until is not None:
        countdown = max(0, (session.countdown_until - timestamp_ms + 999) // 1000)
        status = f"Capture starts in {countdown}" if countdown else "Waiting for a clear pose"
        instruction = "Hold your standing position." if live else setup["message"]
    elif session.armed:
        if live:
            rising = "Hold briefly" if live.get("finishing") else "Stand tall"
            status = {
                "ready": "Go when ready", "descending": "Lowering", "bottom": "Bottom", "ascending": rising,
            }.get(session.state["phase"], "Tracking")
            instruction = (
                "Hold your standing position briefly to finish."
                if live.get("finishing") else "Lower into a comfortable squat, then stand tall."
            )
        else:
            status = "Reacquiring pose"
            instruction = setup.get("message", "Waiting for a clear view of your near side.")
    elif session.wait_until is not None:
        status = "Waiting for setup"
        instruction = setup.get("message", "Stand sideways in the center so your whole body fits.")
    elif session.replay_open:
        status = "Review your squat"
        instruction = "Play back your recorded movement as a skeleton."
    elif session.latest and session.reference:
        status = "Ready for another rep" if setup["ready"] else "Check your position"
        instruction = setup.get("message", "Press Space when ready.")
    else:
        status = "Camera setup" if not setup["ready"] else "Ready to capture"
        instruction = setup.get("message", "Stand sideways in the center so your whole body fits.")

    center_label = ""
    if session.countdown_until is not None and countdown:
        center_label = str(countdown)
    elif session.go_at is not None and timestamp_ms - session.go_at < 1000:
        center_label = "Go"
    if center_label:
        center = (preview_width // 2, preview_height // 2)
        cv2.circle(display, center, 51, BG, -1, cv2.LINE_AA)
        cv2.circle(display, center, 51, ACCENT, 2, cv2.LINE_AA)
        label_width, label_height = cv2.getTextSize(center_label, cv2.FONT_HERSHEY_SIMPLEX, 1.4, 2)[0]
        draw_text(display, center_label, center[0] - label_width // 2, center[1] + label_height // 2, 1.4, INK, 2)

    draw_text(display, status, panel_x, 150, 0.72, ACCENT, 2)
    y = draw_paragraph(display, instruction, panel_x, 181) + 8
    labels = (
        ("inFrame", "Whole body centered"),
        ("sideOn", "Facing sideways"),
        ("standing", "Standing tall"),
        ("steady", "Standing still"),
    )
    if not session.armed and not session.replay_open:
        for key, label in labels:
            passed = setup["checks"].get(key, False)
            cv2.circle(display, (panel_x + 5, y - 4), 4, ACCENT if passed else MUTED, -1 if passed else 1)
            draw_text(display, label, panel_x + 18, y, 0.51, INK if passed else MUTED)
            y += 23

    if session.latest:
        metrics = session.latest["metrics"]
        y += 12
        draw_text(display, f"Last rep    {metrics['descentMs'] / 1000:.1f}s down    {metrics['ascentMs'] / 1000:.1f}s up", panel_x, y, 0.51, ACCENT)
        down = metrics["averageDescentLegLengthsPerSec"]
        up = metrics["averageAscentLegLengthsPerSec"]
        draw_text(display, f"Hip speed: {down:.2f} down / {up:.2f} up (leg lengths/s)", panel_x, y + 22, 0.43)
        draw_text(display, f"Bottom knee angle: {metrics['kneeAngleAtBottomDeg']:.0f} degrees", panel_x, y + 44, 0.43)
        y = draw_paragraph(display, session.latest["cue"]["text"], panel_x, y + 68, INK)
    if session.notice:
        draw_paragraph(display, session.notice, panel_x, min(max(y + 6, 338), 500), MUTED)

    for i, (phase, image) in enumerate(session.thumbnails):
        x = panel_x + i * 68
        thumb_height, thumb_width = image.shape[:2]
        thumb_scale = min(58 / thumb_width, 44 / thumb_height)
        tw, th = max(1, round(thumb_width * thumb_scale)), max(1, round(thumb_height * thumb_scale))
        thumb = cv2.resize(image, (tw, th), interpolation=cv2.INTER_AREA)
        offset_x, offset_y = x + (58 - tw) // 2, 549 + (44 - th) // 2
        display[offset_y:offset_y + th, offset_x:offset_x + tw] = thumb
        draw_text(display, PHASE_LABELS[phase], x + 2, 612, 0.38, MUTED)

    draw_text(display, "Space  Arm rep   |   P  Playback   |   X  Close/cancel   |   G  Guide", 22, 583, 0.51)
    draw_text(display, "E  Save    |    C  Clear result    |    R  Recalibrate    |    Esc  Quit", 22, 615, 0.49, MUTED)
    return display


def run_camera(index: int, output: Path, quiet: bool, variant="bodyweight"):
    camera = cv2.VideoCapture(index)
    try:
        if not camera.isOpened():
            raise RuntimeError(f"Could not open camera {index}. Close other camera apps or choose another index with --camera.")
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

        options = mp.tasks.vision.PoseLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_poses=1,
            min_pose_presence_confidence=0.42,
        )
        session = CaptureSession(output, variant)
        opened_at = time.monotonic()
        session.start(0)
        last_sample = -1000
        last_frame = opened_at
        preview_frame = None
        landmarks = None
        cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(WINDOW, 1000, 600)
        with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
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
                if timestamp_ms - last_sample >= 65:
                    if ok:
                        landmarks = detect_centered_pose(detector, frame, timestamp_ms)
                    else:
                        landmarks = None
                    session.update(preview_frame, landmarks, timestamp_ms)
                    if session.go_at == timestamp_ms and not quiet:
                        play_go_sound()
                    last_sample = timestamp_ms

                cv2.imshow(WINDOW, make_preview(preview_frame, landmarks, session, timestamp_ms))
                key = cv2.waitKey(1 if ok else 20) & 0xFF
                if key in (27, ord("q")):
                    break
                if key == ord(" "):
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
                elif key in (ord("g"), ord("G")):
                    session.close_replay()
                    session.show_guide = not session.show_guide
                    if session.show_guide and session.wait_until is not None:
                        session.cancel()
                elif session.show_guide and key in (ord("+"), ord("="), ord("-")):
                    change = -1 if key == ord("-") else 1
                    session.guide_depth = min(2, max(0, session.guide_depth + change))
    finally:
        camera.release()
        cv2.destroyAllWindows()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0, help="OpenCV webcam index (default: 0)")
    parser.add_argument("--output", type=Path, default=Path("captures"), help="folder for your exported rep JSON")
    parser.add_argument("--quiet", action="store_true", help="skip the Windows cue sound when capture begins")
    parser.add_argument("--variant", choices=("bodyweight", "barbell"), default="bodyweight", help="label the squat in the export")
    args = parser.parse_args()
    if args.camera < 0:
        parser.error("--camera must be zero or greater")
    if not MODEL_PATH.is_file():
        print(f"Pose model missing at {MODEL_PATH}", file=sys.stderr)
        return 1
    try:
        run_camera(args.camera, args.output, args.quiet, args.variant)
    except (RuntimeError, cv2.error) as error:
        print(error, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Run a local side-view video through the desktop camera's capture pipeline."""

import argparse
import base64
import json
from pathlib import Path
import sys

import cv2
import mediapipe as mp
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from compose_camera import CaptureSession, EXERCISES, MODEL_PATH, POSE_INTERVAL_MS, detect_centered_pose


def replay(path, exercise, start_ms, end_ms, hold_ms):
    camera = cv2.VideoCapture(str(path))
    try:
        fps = camera.get(cv2.CAP_PROP_FPS)
        if not camera.isOpened() or not fps:
            raise ValueError(f"Cannot read video: {path}")
        first_frame = round(start_ms * fps / 1000)
        camera.set(cv2.CAP_PROP_POS_FRAMES, first_frame)
        count = first_frame
        next_sample = 0
        session = CaptureSession(path.parent, exercise=exercise)
        session.start(0)
        options = mp.tasks.vision.PoseLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            min_pose_presence_confidence=0.42,
        )
        with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
            while True:
                ok, frame = camera.read()
                if not ok or (end_ms is not None and count * 1000 / fps > end_ms):
                    break
                if count == first_frame and hold_ms:
                    # Override only the pre-rep setup time. Every movement
                    # frame remains in the order and cadence of the source.
                    while next_sample < hold_ms:
                        time_ms = round(next_sample)
                        points = detect_centered_pose(detector, frame, time_ms, exercise)
                        session.update(frame, points, time_ms)
                        next_sample += POSE_INTERVAL_MS
                time_ms = hold_ms + round((count - first_frame) * 1000 / fps)
                count += 1
                if time_ms + 4 < next_sample:
                    continue
                next_sample += POSE_INTERVAL_MS
                points = detect_centered_pose(detector, frame, time_ms, exercise)
                session.update(frame, points, time_ms)
                if session.latest:
                    return session.latest
        raise ValueError(f"No rep captured: {session.notice or session.state['setup'].get('message', '')}")
    finally:
        camera.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--exercise", choices=tuple(EXERCISES), required=True)
    parser.add_argument("--start-ms", type=int, default=0)
    parser.add_argument("--end-ms", type=int)
    parser.add_argument("--hold-ms", type=int, default=0, help="Repeat the first frame for setup before the clip plays")
    parser.add_argument("--expect-snapshots", type=int, default=5)
    args = parser.parse_args()
    if args.start_ms < 0 or args.hold_ms < 0 or (args.end_ms is not None and args.end_ms <= args.start_ms):
        parser.error("Use nonnegative timestamps and an end after the start")
    try:
        evidence = replay(args.video, args.exercise, args.start_ms, args.end_ms, args.hold_ms)
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    images = evidence["snapshots"]
    if (len(images) != args.expect_snapshots or not evidence["motionTrace"]["frames"]
            or any(a["offsetMs"] >= b["offsetMs"] for a, b in zip(images, images[1:]))):
        parser.exit(1, f"Unexpected evidence: {len(images)} snapshots or invalid trace order\n")
    for image in images:
        pixels = np.frombuffer(base64.b64decode(image["imageBase64"], validate=True), dtype=np.uint8)
        if cv2.imdecode(pixels, cv2.IMREAD_COLOR) is None:
            parser.exit(1, f"Could not decode the {image['phase']} snapshot\n")
    print(json.dumps({
        "exercise": evidence["exercise"], "phases": [frame["phase"] for frame in images],
        "traceFrames": len(evidence["motionTrace"]["frames"]), "metrics": evidence["metrics"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()

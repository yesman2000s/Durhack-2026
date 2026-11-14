# Durhack-2026 · COMPOSE squat camera

Standalone browser and Python tools for capturing one side-view squat, with bodyweight and barbell options. The camera checks your position, counts down automatically, and saves five moments for review: standing, lowering, deepest point, rising, and standing again. It also records a pose trace for skeleton playback. The first valid rep is your baseline for the current camera session.

## Run the browser version

Use Node.js 20.19+ or 22.12+ (Node 24 tested). From this directory:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome or Edge, or use the address Vite prints. Click **Start camera** and grant camera access. **Try simulated example** runs the same capture and export flow without a webcam; it uses generated landmarks and is labeled in the export. The camera only runs from localhost or HTTPS. The project ships the [MediaPipe Pose Landmarker Lite model](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) and serves the runtime locally, so it needs no external services while the app is running.

## Run the Python version

Use 64-bit Python 3.12 and a desktop session. From this directory:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
.\.venv\Scripts\python.exe python\compose_camera.py
```

The preview opens and arms the first rep automatically. Use **Space** to arm another rep, **X** to cancel capture or close playback, **P** to play, pause or replay the skeleton, **E** to export, **C** to clear the result, **R** to reset setup, **G** to toggle the example (**+**/**−** adjusts range), and **Esc** or **Q** to quit. Use `--variant barbell` to label a barbell squat, `--camera 1` to switch camera, `--output <directory>` to change the export location (default: `captures/`), or `--quiet` to turn off the Windows Go sound.

## Capture a rep

1. Set the laptop on a stable surface and face left or right. The preview trims the sides of wide camera frames. Stand in the middle with your head and both feet visible, with enough room to squat. In the browser, select **Barbell** before starting the camera if you're using one.
2. Stand still for about two seconds. The app saves your standing stance, then shows a three-second countdown and **Go**. If you begin after setup passes, tracking can start during the countdown. The browser and Windows desktop app also play a brief Go sound.
3. Lower through a comfortable range, stand back up, and hold briefly. The tracker uses your saved stance to recognize the finish and can tolerate small shifts and brief tracking gaps. If it loses sight of you for longer or can't see a complete cycle, it asks you to try again.
4. Review the five snapshots. Use **Play skeleton** and the time slider in the browser, or **P** in Python, to replay the tracked movement. The browser's **Download rep data** button and Python's **E** key save a local JSON file. Until export, the latest rep is held in memory.

The side-view example shows how the hips, knees, and torso move. It scales the sketch using estimated thigh-to-shin and torso-to-leg ratios and lets you choose a range. Your first rep records your own comfortable range. A camera view and body proportions alone cannot determine an ideal or safe depth. The detector needs visible movement to distinguish a squat from a small posture change; a shallow or interrupted attempt may not count.

## What the export contains

Both versions use version 1 of the same JSON format, with the camera dimensions, tracked side, baseline values, the measured phases, and ordered JPEGs encoded as base64. Snapshot `offsetMs` and `movementStartOffsetMs` are relative to the captured standing frame. JPEGs keep the full camera framing. Joints use normalized coordinates in that same full image and include model visibility estimates.

The export labels the squat type as `bodyweight` or `barbell`. `motionTrace.frames` contains timestamped, normalized joints from the tracked side, with offsets relative to the same standing frame. Playback shows the pose trace without a video recording. Brief gaps can interpolate between nearby observations. Longer gaps appear blank.

The metrics include lowering and rising time, pause, mean and peak projected vertical hip speed, knee bend and return angle, bottom hip, torso and shin angles, estimated standing proportions, and tracking quality. Speed is scaled to the projected standing leg length, so it is in leg lengths per second. The deepest image is the best observed loaded pose from the sampled frames; it may differ from the exact instant of maximum depth. Missing or low-quality poses are excluded. View angle, clothing, lighting and camera position can all affect these estimates. A side view cannot assess side-to-side knee alignment, spinal loading, or overall safety.

The JPEGs may identify the person in the recording. The app does not upload them; if you share an export later, it contains the images as well as the measurements.

## Verify

```powershell
npm.cmd test
npm.cmd run build
node scripts/check-tracker-parity.mjs .venv/Scripts/python.exe
.\.venv\Scripts\python.exe python\compose_camera.py --help
```

For a live check, use the target laptop and test both profiles, a normal squat, a brisk squat, a partial bend, a brief occlusion, and stepping out of frame. Check that each full rep produces exactly one result, that the bottom thumbnail is visibly the lowest, that the other four moments are distinct, and that a lost or partial rep produces no new result. Fixtures verify the state machine and export, but can't establish how accurately the webcam sees your squat.

The bundled Google MediaPipe assets are documented in [the model notice](public/models/NOTICE.txt).

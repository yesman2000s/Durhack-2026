# Durhack-2026 · COMPOSE squat camera

Standalone browser and Python tools for capturing one side-view bodyweight squat. The camera checks your position, counts down automatically, and saves five moments for review: standing, lowering, deepest point, rising, and standing again. The first valid rep is your baseline for the current camera session. No score, fault diagnosis, uploads, Gemini, or ElevenLabs are part of this version.

## Run the browser version

Use Node.js 20.19+ or 22.12+ (Node 24 tested). From this directory:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome or Edge, or use the address Vite prints. Click **Start camera** and grant camera access. **Try simulated example** runs the same capture and export flow without a webcam; it uses generated landmarks and is labeled in the export. The camera only runs from localhost or HTTPS. The project ships the [MediaPipe Pose Landmarker Lite model](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) and serves the runtime locally, so it needs no external services while the app is running.

## Try the music studio

Visit [http://localhost:5173/music.html](http://localhost:5173/music.html). Pick a genre and an exercise, enter a **Test streak**, and click **Mock success**. The reward plays just that exercise’s part through the latest unlocked point, then stops. Day one plays a single sixteenth note (a quarter beat) and each additional day adds another sixteenth note. The 112-beat excerpts provide roughly 448 daily unlocks. The streak counter can keep growing after all audio is unlocked. **Mock failure** triggers no reward. **Reset demo** restores the starting streaks.

The music frontend expects a result such as `{ exerciseId: 'squat', success: true, streak: 4 }`. Only a successful response with a recognized exercise ID and valid streak can change that exercise's track. The backend is responsible for calculating the streak.

The demo ships 28-bar excerpts of three Kevin MacLeod instrumentals, trimmed to the beat grid and separated using [Demucs HTDemucs six-stem](https://github.com/facebookresearch/demucs). Rock uses drums, bass, guitar, piano and the residual instrument stem. Hip-hop and EDM use bass, the residual instrument stem and three frequency bands filtered from drums with FFmpeg. The percussion bands contain overlapping sounds from the drum stem. The vocal estimate is excluded, and each genre has five playable parts.

- Hip-hop · [Griphop](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1100413)
- EDM · [EDM Detection Mode](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1500026)
- Rock · [Jet Fueled Vixen](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1700079)

All three recordings are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Run the Python version

Use 64-bit Python 3.12 and a desktop session. From this directory:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
.\.venv\Scripts\python.exe python\compose_camera.py
```

The preview opens and arms the first rep automatically. Use **Space** to arm another rep, **X** to cancel, **E** to export, **C** to clear the result, **R** to reset setup, **G** to toggle the example (**+**/**−** adjusts range), and **Esc** or **Q** to quit. Use `--camera 1` if the default camera is the wrong device, `--output <directory>` to change the export location (default: `captures/`), or `--quiet` to turn off the Windows Go sound.

## Capture a rep

1. Set the laptop on a stable surface rather than holding it. Face left or right, with the camera looking at your side. Keep your head, knees, and full feet visible, and leave room in the frame for the whole movement.
2. Stand still for about two seconds, then wait for the five-second countdown and the **Go** signal. If you move before the countdown ends, it waits for you to settle again. The browser and Windows desktop app also play a brief Go sound.
3. Lower through a comfortable range, stand back up, and hold your starting position briefly. The tracker ends the capture after one complete cycle. If it loses your pose or can't see a complete cycle, it asks you to set up and try again.
4. Review the five snapshots. The browser's **Download rep data** button and Python's **E** key save a local JSON file. Until export, the latest rep is held in memory. Keep the export to preserve your first-day baseline; cross-day history is outside this prototype.

The side-view example shows how the hips, knees, and torso move. It scales the sketch using estimated thigh-to-shin and torso-to-leg ratios and lets you choose a range. Your first rep records your own comfortable range. A camera view and body proportions alone cannot determine an ideal or safe depth. The detector needs visible movement to distinguish a squat from a small posture change; a shallow or interrupted attempt may not count.

## What the export contains

Both versions use version 1 of the same JSON format, with the camera dimensions, tracked side, baseline values, the measured phases, and ordered JPEGs encoded as base64. Snapshot `offsetMs` and `movementStartOffsetMs` are relative to the end of the countdown. Joints in the snapshot metadata use normalized image coordinates and include model visibility estimates. The export is suitable as local input to a later analysis service.

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

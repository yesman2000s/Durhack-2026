# Durhack-2026 · COMPOSE squat camera

Standalone browser and Python tools for capturing one side-view squat, with bodyweight and barbell options. The camera checks your position, counts down automatically, and saves five moments for review: standing, lowering, deepest point, rising, and standing again. It also records a pose trace for skeleton playback. The first valid rep is your baseline for the current camera session.

## Run the browser version

Use Node.js 20.19+ or 22.12+ (Node 24 tested). From this directory:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome or Edge, or use the address Vite prints. Click **Start camera** and grant camera access. **Try simulated example** runs the same capture and export flow without a webcam; it uses generated landmarks and is labeled in the export. The camera only runs from localhost or HTTPS. The project ships the [MediaPipe Pose Landmarker Lite model](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) and serves the runtime locally, so it needs no external services while the app is running.

## Try the music studio

Visit [http://localhost:5173/music.html](http://localhost:5173/music.html). Pick a genre and an exercise, enter a **Test streak**, and click **Mock success**. Only the selected exercise's streak updates. All unlocked parts start together from the same point in the recording, and each fades out at its own unlocked length. The mix ends when the longest part finishes. Each streak day adds one sixteenth note (a quarter beat) to its part. The 112-beat excerpts provide 448 daily unlocks. The streak counter can keep growing after all audio is unlocked. **Mock failure** triggers no reward. **Reset demo** restores the starting streaks.

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

The preview opens and arms the first rep automatically. Use **Space** to arm another rep, **X** to cancel capture or close playback, **P** to play, pause or replay the skeleton, **E** to export, **C** to clear the result, **R** to reset setup, **G** to toggle the example (**+**/**−** adjusts range), and **Esc** or **Q** to quit. Use `--variant barbell` to label a barbell squat, `--camera 1` to switch camera, `--output <directory>` to change the export location (default: `captures/`), or `--quiet` to turn off the Windows Go sound.

## Capture a rep

1. Set the laptop on a stable surface and face left or right. The preview trims the sides of wide camera frames. Stand in the middle with your head and both feet visible, with enough room to squat. In the browser, select **Barbell** before starting the camera if you're using one.
2. Hold a comfortable standing position for about two seconds. Your knees can stay slightly bent. The app saves your stance, then shows a three-second countdown and **Go**. If you begin after setup passes, tracking can start during the countdown. The browser and Windows desktop app also play a brief Go sound.
3. Lower through a comfortable range, stand back up, and hold briefly. The tracker uses your saved stance to recognize the finish and can tolerate small shifts and brief tracking gaps. If it loses sight of you for longer or can't see a complete cycle, it asks you to try again.
4. Review the five snapshots. Use **Play skeleton** and the time slider in the browser, or **P** in Python, to replay the tracked movement. The browser's **Download rep data** button and Python's **E** key save a local JSON file. Until export, the latest rep is held in memory.

The side-view example shows how the hips, knees, and torso move. It scales the sketch using estimated thigh-to-shin and torso-to-leg ratios and lets you choose a range. Your first rep records your own comfortable range. A camera view and body proportions alone cannot determine an ideal or safe depth. The detector needs visible movement to distinguish a squat from a small posture change; a shallow or interrupted attempt may not count.

## What the export contains

Both versions use version 1 of the same JSON format, with the camera dimensions, tracked side, baseline values, the measured phases, and ordered JPEGs encoded as base64. Snapshot `offsetMs` and `movementStartOffsetMs` are relative to the captured standing frame. JPEGs keep the full camera framing. Joints use normalized coordinates in that same full image and include model visibility estimates.

The export labels the squat type as `bodyweight` or `barbell`. `motionTrace.frames` contains timestamped, normalized joints from the tracked side, with offsets relative to the same standing frame. Playback shows the pose trace without a video recording. Brief gaps can interpolate between nearby observations. Longer gaps appear blank.

**Thigh to shin** divides the visible hip-to-knee length by the knee-to-ankle length for the same leg. Snapshot poses and motion trace frames report the ratio for that image. The rep summary uses the median of usable measurements from the start of movement to the return to standing, with the standing ratio as a fallback. These are lengths projected onto the camera image. A more angled view can change the estimate.

The camera targets 12 pose measurements per second. The live skeleton eases between those measurements while the tracker and evidence use observed frames. The lowering and rising snapshots use the closest available frames to halfway through the hip travel in each phase. The bottom image is the deepest observed pose, based on the hip drop and knee bend together. A fast movement can pass between samples. If the camera misses a phase, its photo is omitted.

The metrics include lowering and rising time, pause, mean and peak projected vertical hip speed, knee bend and return angle, bottom hip, torso and shin angles, estimated standing proportions, and tracking quality. Speed is scaled to the projected standing leg length, so it is in leg lengths per second. Missing or low-quality poses are excluded. View angle, clothing, lighting and camera position can all affect these estimates. A side view cannot assess side-to-side knee alignment, spinal loading, or overall safety.

The JPEGs may identify the person in the recording. Capture and review run locally. **Score this rep** sends the selected rep’s snapshots and measurements to Google Gemini. A downloaded export contains the images and measurements.

## Score squat form with Gemini

Set the server-side `GEMINI_API_KEY` environment variable or put `GEMINI_API_KEY=<your key>` in the ignored `.env.local` file. The default model is `gemini-3.6-flash`. Set `GEMINI_MODEL` to use another Gemini 3 model that supports image input and structured output. Restart Vite after changing the configuration.

Run `npm.cmd run dev`, capture a squat or use **Try simulated example**, and click **Score this rep**. The practice rubric combines tempo, range of motion, visible control, and return to stance. It uses the previous rep’s personal range when available and treats two seconds down and one second up as flexible drill targets.

For other integrations, send a browser or Python rep export directly to the same endpoint:

```powershell
curl.exe -X POST http://localhost:5173/api/form-score -H "Content-Type: application/json" --data-binary "@captures/rep.json"
```

The response contains an integer score from 0 to 100 and up to three short, speech-ready cues. For example:

```json
{"score": 84, "tips": ["Take about two seconds to lower.", "Finish each rep standing tall."]}
```

When Gemini needs clearer evidence, `score` is `null` and `tips` contains a filming cue. The endpoint accepts up to 12 MiB of JSON and sends Gemini the phase JPEGs, timings, and selected numeric measurements. The exercise definitions and rubrics live in [server/form-scoring.js](server/form-scoring.js).

## Hear the feedback

Add `ELEVENLABS_API_KEY=<your key>` to `.env.local` and restart Vite. The default voice is George. Set `ELEVENLABS_VOICE_ID` to select another voice. After **Score this rep** returns, the score and tips appear on screen and play aloud automatically. If the browser blocks autoplay, an audio control appears.

`POST /api/form-speech` accepts the `{score, tips}` returned by `/api/form-score` and responds with `audio/mpeg`. ElevenLabs receives only the narration text.

Vite dev and preview serve both APIs from the same origin. Static deployments of `dist/` need a server mounting `formScoringRoute` and `feedbackSpeechRoute` at the same origin. Keep both routes behind application authentication and rate limits if deploying beyond localhost.

## Verify

```powershell
npm.cmd test
npm.cmd run build
node scripts/check-tracker-parity.mjs .venv/Scripts/python.exe
.\.venv\Scripts\python.exe python\compose_camera.py --help
```

For a live check, use the target laptop and test both profiles, a normal squat, a brisk squat, a partial bend, a brief occlusion, and stepping out of frame. Check that each full rep produces exactly one result, that the bottom thumbnail is visibly the lowest, that the other four moments are distinct, and that a lost or partial rep produces no new result. Fixtures verify the state machine and export, but can't establish how accurately the webcam sees your squat.

The bundled Google MediaPipe assets are documented in [the model notice](public/models/NOTICE.txt).

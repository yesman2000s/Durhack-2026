# Durhack-2026 · COMPOSE mobility camera

Standalone browser and Python tools for capturing one exercise rep from the side. The camera checks your setup, counts down, selects snapshots across the rep, and records a pose trace for skeleton playback. For a squat, the first valid rep becomes your baseline for that camera session.

| Exercise | Why it is included | Practice reference |
| --- | --- | --- |
| Squat | A comfortable lower-body movement related to sitting and standing. Use a stable chair for support as needed. | [NHS mini-squats](https://www.nhs.uk/live-well/exercise/strength-exercises/), [sit-to-stand and squat video](https://player.vimeo.com/video/878233151) |
| Push-up | Start in a high plank on the floor. The camera measures elbow bend as your shoulders and hips lower and return. | [NASM push-up](https://www.nasm.org/resource-center/exercise-library/push-up) |
| Knee raise | Stand freely and raise the knee nearest the camera once. Turn around in setup to practise the other side. | [NHS knee lifts](https://www.nhs.uk/Livewell/fitness/Pages/how-to-warm-up.aspx) |
| Heel raise | Stand freely with both feet flat, rise onto the balls of both feet, and lower your heels. | [UCLH heel raises](https://www.uclh.nhs.uk/patients-and-visitors/patient-information-pages/home-exercises-improve-strength-and-balance-following-hospital-admission) |

## Run the browser version

Use Node.js 20.19+ or 22.12+ (Node 24 tested). From this directory:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome or Edge, or use the address Vite prints. Choose an **Exercise**, then select **Start camera** or **Try simulated example**. Squat has **Bodyweight** and **Barbell** variants. The camera runs on localhost or HTTPS. The [MediaPipe Pose Landmarker Lite model](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) and runtime are served locally.

The camera stage takes up the first screen. Choose **Full screen** to hide the browser chrome where supported. The preview preserves the camera's height so you can keep your head and feet in frame. Choose **Review rep** after capture to open the snapshots and skeleton playback.

To analyze a recording, choose the exercise and select **Upload video**. A side view with the whole body visible works best. Leave about a second in the starting pose and hold briefly at the finish. The app scans for the first complete rep using the full frame and the clip's own clock. Choose **Play rep with guide** to see the amber example and your mint skeleton move together over the clip. MP4 (H.264) and WebM are good starting formats. The clip stays on your device.

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

The preview opens and arms the first rep automatically. Use **F** to toggle fullscreen, **Space** to arm another rep, **X** to cancel capture or close playback, **P** to play, pause or replay the skeleton, **E** to export, **C** to clear the result, **R** to reset setup, and **Esc** or **Q** to quit. Press **G** to open the illustrated example and **+**/**−** to adjust the range. While idle, press **V** to switch the example and future captures between bodyweight and barbell. Launch with `--variant barbell` to start in barbell mode, `--camera 1` to switch camera, `--output <directory>` to change the export location (default: `captures/`), or `--quiet` to turn off the Windows Go sound.

Choose a different exercise with **M** while idle, or launch with `--exercise push-up`, `--exercise knee-raise` or `--exercise heel-raise`. Press **T** while idle to enable the guide for the next rep, or launch with `--training` to guide the first rep. Press **X** first if the app is already waiting for setup.

Use `--video` to analyze a local recording. The app saves the first complete rep to `captures/` or the path set by `--output`. Add `--review --training` to open skeleton playback with the guide visible. Press **T** to show or hide the guide during review.

```powershell
.\.venv\Scripts\python.exe python\compose_camera.py --video "side-view.mp4" --exercise squat --review --training
```

## Capture a rep

1. Set the laptop on a stable surface to see you from the side. For a push-up, position the camera low enough to see your head, hands and toes. For the standing exercises, keep your head and feet visible.
2. Hold your starting position for at least one second. Start push-ups in a high plank and start the other exercises standing. As soon as the camera confirms one steady second, it saves your pose and starts a two-second countdown to **Go**. If you begin after setup passes, tracking can start during the countdown. The browser and Windows desktop app also play a brief Go sound.
3. Perform one movement through a comfortable range. Stand back up after a squat, or return to the starting position for another exercise, and hold briefly to finish. The squat measures knee bend and hip motion relative to the feet, so shifting your stance does not end a rep by itself. **Training overlay** starts on by default in the browser. Its dashed amber guide demonstrates a rep at Go and stays visible until capture ends. The solid mint skeleton shows the tracked pose.
4. Review the five snapshots. Use **Play skeleton** and the time slider in the browser, or **P** in Python, to replay the tracked movement. The browser's **Download rep data** button and Python's **E** key save a local JSON file. Until export, the latest rep is held in memory.

The side-view example shows how the hips, knees, and torso move. It scales the sketch using estimated thigh-to-shin and torso-to-leg ratios and lets you choose a range. Your first rep records your own comfortable range. A camera view and body proportions alone cannot determine an ideal or safe depth. The detector needs visible movement to distinguish a squat from a small posture change; a shallow or interrupted attempt may not count.

## What the export contains

Both versions use version 1 of the same JSON format, with the camera dimensions, tracked side, baseline values, the measured phases, and ordered JPEGs encoded as base64. Snapshot `offsetMs` and `movementStartOffsetMs` are relative to the captured standing frame. JPEGs keep the full camera framing. Joints use normalized coordinates in that same full image and include model visibility estimates.

The export includes the selected `exercise` and the squat's `bodyweight` or `barbell` variant. Simulation uses `source: "simulated"`, and an attempt that displayed the training overlay includes `trainingGuide: true`. `motionTrace.frames` contains timestamped, normalized joints from the tracked side. Playback eases through nearby observations and leaves longer gaps blank.

Recorded clips use `source: "video"`. Add `videoStartOffsetMs` to a snapshot's `offsetMs` to locate it on the original video timeline. The exported JSON does not include the file name or the original video.

Push-up measures the elbow bend relative to the high plank. Knee raise measures the camera-side thigh lift in degrees. Heel raise measures visible heel rise as a fraction of the projected standing leg length. Each includes outward and return duration, time at peak, projected speed, and tracking quality. The five phase IDs remain the same across exercises and display with movement-specific labels.

**Thigh to shin** divides the visible hip-to-knee length by the knee-to-ankle length for the same leg. Snapshot poses and motion trace frames report the ratio for that image. The rep summary uses the median of usable measurements from the start of movement to the return to standing, with the standing ratio as a fallback. These are lengths projected onto the camera image. A more angled view can change the estimate.

The camera targets 12 pose measurements per second. The live skeleton eases between those measurements while the tracker and evidence use observed frames. The lowering and rising snapshots use the closest available frames to halfway through the hip travel in each phase. The bottom image is the deepest observed pose, based on the hip drop and knee bend together. A fast movement can pass between samples. If the camera misses a phase, its photo is omitted.

The metrics include lowering and rising time, pause, mean and peak projected vertical hip speed relative to the feet, knee bend and return angle, bottom hip, torso and shin angles, estimated standing proportions, and tracking quality. Speed is scaled to the projected standing leg length, so it is in leg lengths per second. Missing or low-quality poses are excluded. View angle, clothing, lighting and camera position can all affect these estimates. A side view cannot assess side-to-side knee alignment, spinal loading, or overall safety.

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
node scripts/check-mobility-parity.mjs .venv/Scripts/python.exe
.\.venv\Scripts\python.exe python\compose_camera.py --help
```

For a live check on the target laptop, test a complete rep, a partial movement, and an occlusion for each exercise. Check both camera-facing sides, especially when choosing the working leg for knee raises. Turn on the guide for one attempt and confirm it clears when capture finishes or is cancelled.

For actual video checks, `scripts/replay-exercise-video.py` sends a local clip through MediaPipe, the desktop capture flow and the snapshot exporter. Use an unobstructed side profile. The script expects five ordered JPEGs and a motion trace. The reference clips are available from their publishers.

| Replay source | Exercise and tested window (ms) | Setup |
| --- | --- | --- |
| [Squat Analysis Model sample](https://github.com/rohanx01/Squat-Analysis-Model/blob/main/squat.mp4) | `squat`, 4800–12500 | Original standing and movement |
| [Repstate push-up clip](https://github.com/montasim/repstate/blob/main/public/clips/pushup-4.webm) | `push-up`, first rep | 3400 ms hold of the high plank at the start, followed by the original movement |
| [Physitrack supported knee lifts](https://ie.physitrack.com/home-exercise-video/standing-hip-flexion-with-support) | `knee-raise`, 12500–30600 | Standing and knee lift; the tracker does not use the hand or support |
| [Physitrack standing heel raises](https://us.physitrack.com/home-exercise-video/heel-raises-version-2) | `heel-raise`, 2200–15500 | Original side-view movement without hand support |

For browser camera replay, hold the first frame in view until **Go**, then play the original movement. Use the top plank for push-ups, a flat-footed frame for heel raises, and a frame with both feet down for knee raises.

```powershell
.\.venv\Scripts\python.exe scripts\replay-exercise-video.py pushup-4.webm --exercise push-up --hold-ms 3400
```

The bundled Google MediaPipe assets are documented in [the model notice](public/models/NOTICE.txt).

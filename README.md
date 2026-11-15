# Durhack-2026 · COMPOSE mobility camera

COMPOSE turns exercise progress into music. The browser app combines account-backed workout history, seven levels for each of four movements, a music studio, and a side-view camera with automatic Gemini feedback and optional ElevenLabs speech. The camera checks your setup, counts down, selects snapshots across each rep, and records a pose trace for skeleton playback. A standalone Python tool provides capture, tracking, and JSON export.

The browser has two pages: `index.html` is the music studio, account entry point, and practice library; `camera.html` captures the next available movement level. Choose **Unlock note N** beside an instrument, or select its available note, to review the exact goal, then choose **Start exercise** to open its workout. Completed notes can be previewed or muted in the studio. **Back to music** returns from the camera.

| Exercise | Why it is included | Practice reference |
| --- | --- | --- |
| Squat | A comfortable lower-body movement related to sitting and standing. Use a stable chair for support as needed. | [NHS mini-squats](https://www.nhs.uk/live-well/exercise/strength-exercises/), [sit-to-stand and squat video](https://player.vimeo.com/video/878233151) |
| Push-up | Start in a high plank on the floor. The camera measures elbow bend as your shoulders and hips lower and return. | [NASM push-up](https://www.nasm.org/resource-center/exercise-library/push-up) |
| Knee raise | Stand freely and raise the knee nearest the camera once. Turn around in setup to practise the other side. | [NHS knee lifts](https://www.nhs.uk/Livewell/fitness/Pages/how-to-warm-up.aspx) |
| Heel raise | Stand freely with both feet flat, rise onto the balls of both feet, and lower your heels. | [UCLH heel raises](https://www.uclh.nhs.uk/patients-and-visitors/patient-information-pages/home-exercises-improve-strength-and-balance-following-hospital-admission) |

## Run the browser version

Use Node.js 24, the recommended and tested runtime (24.11.0). The account server requires the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module; the previous Node 20 setup is no longer supported. From this directory:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome or Edge, or use the address Vite prints. Choose **Sign in**, then **Create an account** to register with a name, email address, and a password of 8–128 characters. Select an available movement note, choose **Start exercise**, then select **One rep** or **Full set** and **Start camera**, **Upload video**, or **Try simulated example**. Squat supports **Bodyweight** and **Barbell**; the first successful baseline fixes the variant for subsequent levels. The camera runs on localhost or HTTPS. The [MediaPipe Pose Landmarker Lite model](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) and runtime are served locally. Real coaching requires the server credentials described below; the isolated QA server works without them.

Before starting, **Your session** groups the **One rep** and **Full set** choices with switches for **Training overlay** and **Spoken feedback**. It sits beside the preview on desktop and below it on smaller screens. Open **Exercise settings** for the movement, squat type, and countdown sound; a movement opened from the studio stays fixed to its selected level. **About your recording** explains where images, feedback, and footage go. The setup checklist and **Exercise guide** remain available below the camera.

In **Full set**, the countdown runs once and each completed rep is saved and sent for coaching while tracking continues. Choose **End set** at any time, or let the app finish after 12 seconds without another tracked movement. An incomplete attempt does not add a rep. A session with no detected movement times out after 45 seconds. The simulated full set performs three reps and then demonstrates automatic ending. Select a rep in the set history to review its snapshots and feedback; **Download set data** exports every completed rep.

Starting capture requests browser fullscreen and uses a viewport-filling fallback when native fullscreen is unavailable. During the set, the camera shows a rep count, target, coaching cue, audio control, and **End set**. The preview preserves the camera's height so you can keep your head and feet in frame. **Full screen** also toggles the view manually.

After capture ends, the app leaves fullscreen and waits for all queued AI reviews before checking the level. A pending review cannot unlock music. If a review fails, choose **Retry and finish**, or **Save without unlocking** to retain the attempt with an error result. The result dialog shows the saved score and whether a note was earned; a captured rep alone is not a successful level. Review snapshots and skeleton playback from the camera, or open a saved attempt in the home page's practice library.

To analyze a recording, choose the exercise, capture mode, and **Upload video**. A side view with the whole body visible works best. Leave about a second in the starting pose and hold briefly at the finish. The app scans for the first complete rep or a set using the full frame and the clip's own clock. A set also ends at the end of the clip. Choose **Play rep with guide** on the latest rep to see the amber example and your mint skeleton move together over the clip. MP4 (H.264) and WebM are good starting formats. The original clip stays on your device; completed rep images and measurements are sent to Gemini for coaching.

## Movement music

Each movement has seven levels, and each level unlocks a 16-beat section of its instrument in a 112-beat excerpt. Squat adds drums, knee raise adds bass, push-ups add piano, and heel raises add guitar where those stems are available. All accounts start with zero unlocked notes. Levels progress independently for each movement.

The first completed webcam or uploaded-video workout with a numeric score sets that exercise's personal best and counts as the first unlock. Each workout that strictly beats the previous best adds one to the count and unlocks the next available note. For example, scores of 60, 68, 65, 68, and 71 leave a best score of 71 and a count of three. After all seven notes are unlocked, users can keep practising and recording personal bests.

The workout score is the mean of its numeric Gemini rep scores, rounded to two decimal places. Each signed-in account has a separate score history per exercise. Simulated examples, cancelled workouts, and workouts saved with review errors do not earn personal bests. Squat progression uses the variant of the first unlocked workout. Existing unlocked notes are kept when updating from an earlier version.

Choose a music genre, then use the small play/pause button above the instruments to listen. Its progress slider seeks through the current music. The player flows with the page instead of covering the bottom of the screen. Select a completed note to preview its original song section. Pausing and seeking preserve playback position; playback never awards progress.

While browsing, **Space** plays or pauses, **Left/Right** seeks five seconds, and **M** toggles mute. Shortcuts do not intercept typing, focused controls, or dialogs. Supported browsers also expose the current track to system media controls. Each instrument has an **Unlock note N** button that opens its next goal and the **Start exercise** action. Starting an exercise before sign-in keeps that movement selected and continues at its next available level after login.

The studio keeps its illustrated instruments and coloured, raised waveform note cards. Each instrument has a horizontal timeline, its exercise name, a Mute switch and an Unlock note action. The beat ruler and Playback tools provide seeking, zoom and follow controls. Select a note to review its goal or playback controls; drag an unlocked note by its handle to rearrange its visual position without changing musical timing. The small play/pause button and progress slider sit above the timeline, with no fixed bottom player.

Turn **Include in mix** off in a completed note's dialog to exclude that section, or turn on an instrument's **Mute** switch to mute all its unlocked notes. Turn the switch off to include those notes again. Mix changes retain playback position. The chosen song and note mutes are saved to the account.

The home player uses beat-matched excerpts of three Kevin MacLeod instrumentals, separated using [Demucs HTDemucs six-stem](https://github.com/facebookresearch/demucs). Rock provides drums, bass, piano, and guitar stems. Hip-hop and EDM map squat to low percussion, knee raise to bass, push-ups to the melodic residual, and heel raises to high percussion. The percussion bands are filtered from drums with FFmpeg; the studio labels the actual sounds as Drums, Bass, Melody, and Percussion for these genres.

- Hip-hop · [Griphop](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1100413)
- EDM · [EDM Detection Mode](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1500026)
- Rock · [Jet Fueled Vixen](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1700079)

All three recordings are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Accounts and saved workouts

In **My attempts**, filter by exercise or result to find previous practice. Each attempt shows every rep's summary, tips and review status. The latest server review takes precedence over older local feedback, while locally saved snapshots and recordings remain available alongside it.

The Vite server creates `.data/compose.sqlite` on first use. SQLite stores accounts, hashed passwords, hashed session tokens, individual rep scores and written feedback, attempt history, completed levels, and music settings. This directory is ignored by Git and blocked from HTTP downloads. Progress belongs to the account in this database and survives browser reloads and server restarts. Stop the server before copying `.data/` to move or back up its saved accounts and workouts.

Set the server-side `MONGODB_URI` in `.env.local` to save scored workout history to MongoDB. `MONGODB_DATABASE` defaults to `compose`. The `workout_scores` collection stores one document per scored webcam or uploaded-video workout, including ties and lower scores. Each document has the attempt ID as `_id`, the account and exercise IDs, variant, source, score, rep count, finish status and time, and a personal-best flag. SQLite remains the account and workflow store. The account service syncs the score history when a workout finishes or its owner opens progress, including history saved before MongoDB was configured. A failed sync can be retried with the same attempt ID.

Sign-in uses a 30-day `HttpOnly`, `SameSite=Lax` session cookie, with `Secure` on HTTPS. Signing out revokes the session. Passwords use salted scrypt hashes, and credential attempts are rate limited. Registration is local to this application; no email verification or password-reset service is configured.

Full footage and rep evidence use a separate store: the browser's `compose-local-attempts` IndexedDB database, keyed by account ID and attempt ID. Webcam footage is recorded without microphone audio where MediaRecorder is available; uploaded videos and rep snapshots are saved locally too. The practice library combines the server's score/feedback history with footage available in that browser. Signing in on another device can retrieve server history, but does not transfer recordings. Clearing site data, using another browser/origin, or browser storage eviction can remove local footage. The app requests persistent storage and reports storage failures; use **Download recording**, **Download rep data**, or **Download set data** to retain your own copy.

The SQLite database does not contain the original videos or image evidence. Pose detection runs locally, but completed rep JPEGs and measured evidence are sent to Gemini for coaching; ElevenLabs receives only narration text. Simulated attempts can appear in history without awarding music. The Python tool's exports do not create accounts or unlock browser levels by themselves.

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
2. Hold your starting position for at least one second. Start push-ups near the top of a floor plank; a slight elbow bend, natural hip height, and a modest camera angle are okay. The tracker uses your own starting pose for the return, rather than requiring locked elbows or an exact model pose. Start the other exercises standing. As soon as the camera confirms one steady second, it saves your pose and starts a two-second countdown to **Go**. If you begin after setup passes, tracking can start during the countdown. The browser and Windows desktop app also play a brief Go sound.
3. Perform one movement through a comfortable range. Stand back up after a squat, or return to the starting position for another exercise, and hold briefly to finish. The squat measures knee bend and hip motion relative to the feet, so shifting your stance does not end a rep by itself. **Training overlay** starts on by default in the browser. Its translucent amber human silhouette demonstrates a rep at Go and stays visible until capture ends. The solid mint skeleton shows the tracked pose. The guide illustrates a movement; tracking does not require you to match its angles or timing.
4. Review the available phase snapshots. Use **Play skeleton** and the time slider in the browser, or **P** in Python, to replay the tracked movement. The browser's **Download rep data** button and Python's **E** key save a local JSON file. Signed-in browser attempts also save evidence to IndexedDB and scored feedback to the server. The Python tool requires an export to retain its current result.

The side-view example shows how the hips, knees, and torso move. It scales the sketch using estimated thigh-to-shin and torso-to-leg ratios and lets you choose a range. Your first rep records your own comfortable range. A camera view and body proportions alone cannot determine an ideal or safe depth. The detector needs visible movement to distinguish a squat from a small posture change; a shallow or interrupted attempt may not count.

## What the export contains

Both versions use version 1 of the same JSON format, with the camera dimensions, tracked side, baseline values, the measured phases, and ordered JPEGs encoded as base64. Snapshot `offsetMs` and `movementStartOffsetMs` are relative to the captured standing frame. JPEGs keep the full camera framing. Joints use normalized coordinates in that same full image and include model visibility estimates.

The export includes the selected `exercise` and the squat's `bodyweight` or `barbell` variant. Simulation uses `source: "simulated"`, and an attempt that displayed the training overlay includes `trainingGuide: true`. `motionTrace.frames` contains timestamped, normalized joints from the tracked side. Playback eases through nearby observations and leaves longer gaps blank.

Recorded clips use `source: "video"`. Add `videoStartOffsetMs` to a snapshot's `offsetMs` to locate it on the original video timeline. The exported JSON does not include the file name or the original video.

Push-up measures the elbow bend relative to the high plank. Knee raise measures the camera-side thigh lift in degrees. Heel raise measures visible heel rise as a fraction of the projected standing leg length. Each includes outward and return duration, time at peak, projected speed, and tracking quality. The five phase IDs remain the same across exercises and display with movement-specific labels.

**Thigh to shin** divides the visible hip-to-knee length by the knee-to-ankle length for the same leg. Snapshot poses and motion trace frames report the ratio for that image. The rep summary uses the median of usable measurements from the start of movement to the return to standing, with the standing ratio as a fallback. These are lengths projected onto the camera image. A more angled view can change the estimate.

The camera targets 12 pose measurements per second. Each live sample freezes the full camera image before detection, keeping its selected snapshot and joints aligned. JPEGs preserve up to 1280 pixels on the longest edge without enlarging smaller sources. The live skeleton eases between those measurements while the tracker and evidence use observed frames. Both joint visibility and presence confidence are checked, with generous checks against the person's own setup proportions to exclude implausible joint jumps. Slightly angled views and natural variation remain supported; a clear side view gives more useful measurements. The lowering and rising snapshots use the closest available frames to halfway through the hip travel in each phase. The bottom image is the deepest observed pose, based on the hip drop and knee bend together. A fast movement can pass between samples. If the camera misses a phase, its photo is omitted.

The metrics include lowering and rising time, pause, mean and peak projected vertical hip speed relative to the feet, knee bend and return angle, bottom hip, torso and shin angles, estimated standing proportions, and tracking quality. Speed is scaled to the projected standing leg length, so it is in leg lengths per second. Missing or low-quality poses are excluded. View angle, clothing, lighting and camera position can all affect these estimates. A side view cannot assess side-to-side knee alignment, spinal loading, or overall safety.

The JPEGs may identify the person in the recording. Pose tracking runs locally. Completing a browser rep automatically sends its snapshots, measurements, motion trace and recent set context to Google Gemini. ElevenLabs receives only the feedback narration text. A downloaded export contains the images and measurements. Browser set exports include the session ID, end reason, rep order and any feedback received before export. Signed-in attempts are also saved as described above; an export is a portable copy independent of browser storage.

## Coach each rep with Gemini

For a new checkout, copy `.env.example` to the ignored `.env.local` file and set `GEMINI_API_KEY`. If `.env.local` already exists, update it without overwriting its other credentials. Connect ElevenLabs using the onboarding command below, or supply `ELEVENLABS_API_KEY` as a server environment variable. Do not prefix these keys with `VITE_`. The default model is [Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash). Set `GEMINI_MODEL` to use another compatible Gemini 3 model supporting image input, structured output and low thinking. Restart Vite after changing the configuration.

Run `npm.cmd run dev`, sign in, and capture any supported exercise or use **Try simulated example**. Every completed rep automatically enters the review queue. Gemini receives all captured phase JPEGs and pose metadata, confidence values, the timestamped motion trace, metrics, reference, practice guide and up to five recent rep summaries with available feedback. Exercise-specific prompts ask for evidence-based improvements for the next rep, allow natural body proportions and modest camera angles, and treat uncertain tracking as uncertainty rather than poor form. Simulated inputs are identified as examples. The prompt and rubrics live in [server/form-scoring.js](server/form-scoring.js).

Two reviews can run concurrently while capture continues. Each rep keeps its written feedback or a retryable error. Manual or automatic set ending keeps already queued reviews running, and the app prevents another attempt from starting until the current one has finished review and saving. Successful review retries return the stored feedback without re-scoring or crediting the rep twice. Failed reviews can be retried while the attempt remains active.

For standalone integrations, send rep evidence without an `attemptId` to the same endpoint. Python rep exports can be used directly; remove `attemptId` from an account-associated browser export when requesting standalone practice feedback:

```powershell
curl.exe -X POST http://localhost:5173/api/form-score -H "Content-Type: application/json" --data-binary "@captures/rep.json"
```

The response contains a provisional practice score from 0 to 100, a short summary and up to two speech-ready cues for the next rep. For example:

```json
{"score": 84, "summary": "Your return was controlled; the lowering phase was quicker.", "tips": ["Lower a little more slowly on your next rep."]}
```

When Gemini needs clearer evidence, `score` is `null` and it can return one filming cue. This is coaching from imperfect 2D evidence, not a medical or safety assessment. The endpoint validates up to 12 MiB of JSON, five JPEGs and 400 ordered motion frames. An optional `session` object contains `id`, `mode` (`single-rep` or `set`), `repNumber` and `previousReps`. Existing browser and Python rep exports remain accepted.

Calls without `attemptId` remain available for standalone practice feedback and never write progression. Account-backed scoring adds the server-issued `attemptId` and a unique rep `id` to the evidence. The server checks session ownership, exercise, source, and variant before calling Gemini, then stores the returned score and feedback. Clients cannot award levels by sending their own `score`, `repCount`, or `passed` values.

The same-origin account endpoints are:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/me` | Current public user, or `user: null`. |
| `POST /api/auth/register`, `POST /api/auth/login` | Accept email/password and, for registration, name; set the session cookie. |
| `POST /api/auth/logout` | Revoke the session; send an empty JSON object. |
| `GET /api/progress` | Per-movement baseline, variant, level states, next target, and saved music settings. |
| `PATCH /api/settings` | Save `songId`, `positions`, and/or `mutedNotes`. Note keys use `exerciseId:level`; visual slots are 0–6. |
| `POST /api/attempts` | Start the next available level with `exerciseId`, `level`, `source`, `mode`, and optional `variant` (default `bodyweight`). |
| `GET /api/attempts`, `GET /api/attempts/:id` | Read the account's latest 100 attempts or one attempt with per-rep feedback. |
| `POST /api/attempts/:id/finish` | Finalize once reviews settle, using `reason: "completed"`, `"cancelled"`, or `"error"`; return the saved attempt and refreshed progress. |

Account writes require JSON and reject cross-origin requests. Protected endpoints require the session cookie. Finalization is idempotent; pending reviews, or failed reviews with `reason: "completed"`, return HTTP 409. A server restart marks interrupted reviews as retryable errors rather than awarding progress.

## Hear the feedback

Run the official onboarding command from the project directory and follow its account authorization steps:

```powershell
npx -y @elevenlabs/cli@latest onboard init
```

The CLI saves `ELEVENLABS_API_KEY` in the ignored `.env.local` file. The server uses the official `@elevenlabs/elevenlabs-js` SDK, with credentials loaded by Vite's server configuration; the browser never receives the key. Restart Vite after setup. The default voice is George using [Eleven Flash v2.5](https://elevenlabs.io/docs/overview/models/). Set `ELEVENLABS_VOICE_ID` to select another voice. **Spoken feedback** starts enabled and can be muted during capture. The rep number, summary and tips play when analysis completes. If the browser blocks autoplay, choose **Play coaching audio**.

Speech never overlaps. If reviews arrive faster than they can be spoken, the next audio uses the newest feedback and older unsounded cues are skipped; all written reviews remain available. `POST /api/form-speech` accepts the `{score, summary, tips}` returned by `/api/form-score`, plus optional `repNumber`, and responds with `audio/mpeg`. The legacy `{score, tips}` payload remains supported. ElevenLabs receives only the narration text.

Vite dev and preview mount the account, progression, form-scoring, and speech routes from the same origin. A deployed Node server must mount the account service middleware, pass its `scoreRep` hook to `formScoringRoute`, mount `feedbackSpeechRoute`, and retain the SQLite data directory. For MongoDB score history, pass `mongoWorkouts: createMongoWorkouts(uri, database)` to `createAccountService` and close the MongoDB client on shutdown. Before exposing the paid coaching routes publicly, add deployment-level authentication and rate limits for standalone practice and speech requests, which remain available without an attempt session.

## Verify

For an isolated browser QA workspace with disposable data and no provider credentials, run:

```powershell
node scripts/studio-fixture-server.mjs
```

Open [http://localhost:5175](http://localhost:5175) and sign in with **studio@example.test** / **Compose-test-2026**. These are public fixture credentials, not a real account. The visibly marked **TEST WORKSPACE** uses an in-memory SQLite database, does not load `.env` files or the normal Vite configuration, and cannot access paid APIs. Server outbound fetches and external browser requests are blocked. Coaching always returns a fixture score of 82; speech is a short locally generated tone. Stopping and restarting the fixture resets server accounts and progress; recordings saved to that origin's browser IndexedDB remain until site data is cleared.

The fixture starts with squat level 2, knee raise level 1, push-up level 3, and no heel-raise levels unlocked, plus a failed squat attempt. It exercises normal sign-in, note previews/mutes, history, and capture/review flows without modifying `.data/compose.sqlite`. Simulated examples still cannot unlock levels, even with the fixture's fake score. Use the normal dev server and real captures to validate real provider feedback.

Run the automated checks separately:

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

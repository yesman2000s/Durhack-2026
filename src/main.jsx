import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SquatTracker } from './squat-tracker.js';
import { MobilityTracker } from './mobility-tracker.js';
import { createDemo } from './demo.js';
import { createMobilityDemo } from './mobility-demo.js';
import { createTrainingOverlay } from './training-overlay.js';
import { createRecordedOverlay } from './recorded-overlay.js';
import { EXERCISES, exerciseInfo } from './exercises.js';
import { poseInCenter } from './camera-crop.js';
import { createPosePreview } from './pose-preview.js';
import { makeMotionTrace, recordPose } from './motion-trace.js';
import { SkeletonPlayback } from './skeleton-playback.jsx';
import { FormFeedback } from './form-feedback.jsx';
import { captureImage, downloadEvidence, FORM_GUIDE, framePose, makeEvidence } from './evidence.js';
import './styles.css';

const DEFAULT_SETUP = { ready: false, checks: {}, message: 'Start the camera to check your position.', progress: 0 };
const PHASE_LABEL_KEY = { descending: 'descent', bottom: 'bottom', ascending: 'ascent' };
const SQUAT_LABELS = { bodyweight: 'Bodyweight squat', barbell: 'Barbell squat' };
const COUNTDOWN_SECONDS = 2;
const VIEWFINDER_CUES = {
  'Hold a comfortable standing position.': 'Stand comfortably and hold.',
  'Step into view so the camera can see you.': 'Step into view.',
  'Turn sideways so the camera sees your profile.': 'Turn to the side.',
  'Move a little closer while keeping your head and feet in frame.': 'Step closer. Keep your head and feet in view.',
};
const DISCARD_MESSAGES = {
  'tracking-gap': 'Tracking was lost. Keep your near hip, knee and ankle in view, then try again.',
  'foot-moved': 'Your support position changed. Reset your hands or feet for this exercise and try again.',
  'low-confidence': 'Too much of the squat was obscured. Keep your near hip, knee and ankle visible.',
  'incomplete-descent': 'The camera saw a partial bend. Try one comfortable squat and return to standing.',
  'incomplete-ascent': 'The camera missed the rise. Stand back up and hold briefly at the finish.',
  'second-descent': 'The camera saw a second dip. Capture one squat at a time.',
  'incomplete-movement': 'Complete one controlled movement and return to your starting position.',
  timeout: 'No complete rep was detected in time. Stand tall and try again.',
};
const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
const deg = (n) => `${Math.round(n)}°`;
const velocity = (n) => `${n.toFixed(2)}`;
const ratio = (n) => `${n.toFixed(2)} : 1`;
const shown = (format, value) => Number.isFinite(value) ? format(value) : '—';
const clipTime = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function CameraIcon({ size = 25 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.7" y="5.4" width="13.5" height="13.2" rx="3"/><path d="m16.2 10 4.8-2.7v9.4L16.2 14"/></svg>;
}

function Icon({ name }) {
  const paths = {
    check: <path d="m5 12 4 4 10-10"/>,
    shield: <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Zm-3-10 2 2 4-4"/>,
    play: <><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/></>,
    sound: <><path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="M15 9a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12"/></>,
    mute: <><path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="m16 9 6 6m0-6-6 6"/></>,
    expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>,
    contract: <path d="M3 9h6V3m12 6h-6V3M9 21v-6H3m12 6v-6h6"/>,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M4 16v4h16v-4"/></>,
    music: <><path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="18" cy="16" rx="3" ry="2"/></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 16v4h16v-4"/></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function figurePaths(x, depth, proportions, variant) {
  const leg = 33;
  const ratio = Math.min(1.65, Math.max(0.70, proportions?.standingThighToShinRatio ?? 1.1));
  const shin = leg / (1 + ratio), thigh = leg - shin;
  const torso = leg * Math.min(0.85, Math.max(0.35, proportions?.standingTorsoToLegRatio ?? 0.55));
  const radians = (n) => n * Math.PI / 180;
  const point = ([x, y], l, a) => [x + l * Math.sin(radians(a)), y - l * Math.cos(radians(a))];
  const ankle = [x, 85], knee = point(ankle, shin, 2 + depth * 20);
  const hip = point(knee, thigh, -depth * 78), shoulder = point(hip, torso, 2 + depth * 36);
  const head = point(shoulder, 10, 10);
  const [shoulderX, shoulderY] = shoulder;
  const bar = [shoulderX - 7, shoulderY - 1];
  return <g>
    <path d={`M${x + 9},85 L${ankle} L${knee} L${hip} L${shoulder}`} />
    <circle cx={head[0]} cy={head[1]} r="5.5" />
    {variant === 'barbell' ? <g>
      <path d={`M${shoulder} l-5,9 L${bar}`} strokeWidth="3" />
      <circle cx={bar[0]} cy={bar[1]} r="4.5" fill="#263750" stroke="#c2d5ff" strokeWidth="1.5" />
      <circle cx={bar[0]} cy={bar[1]} r="1.3" fill="#fff" stroke="none" />
    </g> : <path d={`M${shoulder} l8,6 l8,${3 - 6 * depth}`} strokeWidth="3" />}
  </g>;
}

function PracticeGuide({ live, reference, variant, exercise, guideRef }) {
  const [example, setExample] = useState('auto');
  const info = exerciseInfo(exercise);
  if (exercise !== 'squat') return <details className="practice-guide" ref={guideRef}>
    <summary>{info.title} guide</summary>
    <div className="practice-guide-body">
      <ul>{info.guidance.map((tip) => <li key={tip}>{tip}</li>)}</ul>
      <a className="button-link" href={info.reference} target="_blank" rel="noreferrer">See exercise instructions</a>
    </div>
  </details>;
  const proportions = live ?? reference;
  const ratio = Math.min(1.65, Math.max(0.70, proportions?.standingThighToShinRatio ?? 1.1));
  const thighFraction = ratio / (1 + ratio);
  // Illustrate the thigh stopping above horizontal, scaled to the projected leg proportions.
  const moderateBend = 22 + Math.acos(Math.min(1, 0.20 / thighFraction)) * 180 / Math.PI;
  const exampleBend = example === 'short' ? moderateBend - 26 : example === 'long' ? moderateBend + 8 : reference?.kneeExcursionDeg ?? moderateBend;
  const depth = Math.min(1, Math.max(0.38, exampleBend / 98));
  return <details className="practice-guide" ref={guideRef}>
    <summary>See a {variant} squat example</summary>
    <div className="practice-guide-body">
      <svg className="form-example" viewBox="0 0 260 114" role="img" aria-label={`${SQUAT_LABELS[variant]} side-view illustration of standing, lowering and standing again`}>
        <path d="M13 88H247" stroke="#a0abc4" strokeWidth="1.5" />
        <g fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          {figurePaths(48, 0, proportions, variant)}{figurePaths(130, depth, proportions, variant)}{figurePaths(208, 0, proportions, variant)}
        </g>
        <g fill="currentColor" fontSize="11" fontFamily="system-ui" textAnchor="middle"><text x="48" y="107">Stand</text><text x="130" y="107">Lower</text><text x="208" y="107">Stand</text></g>
      </svg>
      <label className="example-control">Example range <select value={example} onChange={(event) => setExample(event.target.value)}><option value="auto">{reference ? 'Use first rep as a guide' : 'Moderate'}</option><option value="short">Shallower</option><option value="long">Deeper</option></select></label>
      <ul>{variant === 'barbell' && <li>This example shows a bar resting across the upper back, with both hands holding it.</li>}{FORM_GUIDE.map((tip) => <li key={tip}>{tip}</li>)}</ul>
      <a className="button-link" href={info.reference} target="_blank" rel="noreferrer">Watch a reference video</a>
      <p>{proportions?.standingThighToShinRatio ? 'The illustration uses your estimated thigh, shin and torso proportions.' : 'Once you stand in view, the illustration can use your estimated body proportions.'} The example shows a movement pattern. Use a depth that feels comfortable for you.</p>
    </div>
  </details>;
}

function RepResult({ result, onClear, onPlayGuide, titleRef }) {
  const [selected, setSelected] = useState(result.snapshots.find(({ phase }) => phase === 'bottom')?.phase ?? result.snapshots[0]?.phase);
  const [expanded, setExpanded] = useState(false);
  const selectedSnapshot = result.snapshots.find(({ phase }) => phase === selected);
  const m = result.metrics;
  const reference = result.reference;
  const squat = result.exercise === 'squat';
  const info = exerciseInfo(result.exercise);
  const resultTitle = squat ? (SQUAT_LABELS[result.variant] ?? SQUAT_LABELS.bodyweight) : info.title;
  const formatRange = m.rangeUnit === 'leg-lengths' ? (v) => `${Math.round(v * 100)}% of leg length` : deg;
  const mainValues = squat ? [
    ['Lowering', s, m.descentMs],
    ['Rising', s, m.ascentMs],
    ['Knee bend', deg, m.kneeExcursionDeg, reference?.establishedByThisRep === false ? `First rep: ${deg(reference.kneeExcursionDeg)}` : ''],
  ] : [[info.phases.descent, s, m.outwardMs], [info.phases.ascent, s, m.returnMs], [info.rangeLabel, formatRange, m.range]];
  const tracking = ['Tracking', (v) => `${Math.round(v * 100)}%`, m.validFrameFraction, 'Usable pose samples'];
  const details = squat ? [
    ['Down speed', velocity, m.averageDescentLegLengthsPerSec, 'Leg lengths per second'], ['Up speed', velocity, m.averageAscentLegLengthsPerSec, 'Leg lengths per second'],
    ['Torso lean', deg, m.torsoLeanAtBottomDeg, 'From vertical at the bottom'], ['Return difference', deg, m.returnAngleErrorDeg, 'Compared with your start'],
    tracking,
  ] : [['Hold at peak', s, m.holdMs], ['Rep time', s, m.durationMs], tracking];
  const renderMetric = ([label, format, value, note]) => <div className="metric-card" key={label}>
    <dt>{label}</dt><dd>{shown(format, value)}{note && <small>{note}</small>}</dd>
  </div>;

  return <section className="result-panel" aria-labelledby="result-title" id="review">
    <div className="result-header">
      <div>
        <h2 id="result-title" tabIndex={-1} ref={titleRef}>Rep captured</h2>
        <p>{resultTitle}{result.source === 'simulated' ? ' · Simulated example' : result.source === 'video' ? ' · Uploaded video' : ''}{result.trainingGuide ? ' · Guided practice' : ''}{reference?.establishedByThisRep ? ' · First rep baseline' : ''}</p>
      </div>
      <div className="result-actions">
        {onPlayGuide && <button className="button button-secondary" onClick={onPlayGuide}><Icon name="play" />Play rep with guide</button>}
        <button className="button button-secondary" onClick={onClear}>Clear result</button>
        <button className="button button-primary" onClick={() => downloadEvidence(result)}><Icon name="download" />Download rep data</button>
      </div>
    </div>
    <div className="result-layout">
      <div className="result-evidence">
        {result.snapshots.length > 0 && <div className="snapshots-grid" role="group" aria-label="Rep snapshots">
          {result.snapshots.map((snapshot) => <button
            className="snapshot-card" type="button" key={snapshot.phase} data-phase={snapshot.phase}
            aria-pressed={snapshot.phase === selected} aria-expanded={expanded && snapshot.phase === selected}
            onClick={() => {
              setExpanded(selected !== snapshot.phase || !expanded);
              setSelected(snapshot.phase);
            }}
          >
            <img src={snapshot.url} alt="" />
            <span>{info.phases[snapshot.phase]}</span>
          </button>)}
        </div>}
        {expanded && selectedSnapshot && <figure className="selected-snapshot">
          <img src={selectedSnapshot.url} alt={`Side view · ${info.phases[selectedSnapshot.phase]}`} />
          <figcaption>{info.phases[selectedSnapshot.phase]}<span>{s(selectedSnapshot.offsetMs)} from capture start{Number.isFinite(selectedSnapshot.pose?.range) ? ` · ${info.rangeLabel} ${formatRange(selectedSnapshot.pose.range)}` : squat && Number.isFinite(selectedSnapshot.pose?.thighToShinRatio) ? ` · Thigh to shin ${ratio(selectedSnapshot.pose.thighToShinRatio)}` : ''}</span></figcaption>
        </figure>}
        {result.snapshots.length < 5 && <p className="snapshot-note">Some snapshots were unavailable. The export includes the images that were captured.</p>}
      </div>
      <dl className="primary-metrics" aria-label="Key measurements">
        {mainValues.map(renderMetric)}
      </dl>
    </div>
    {squat && result.snapshots.length > 0 && <FormFeedback rep={result} />}
    {Number.isFinite(m.thighToShinRatio) && <p className="leg-ratio">
      <strong>Thigh to shin</strong><strong>{ratio(m.thighToShinRatio)}</strong>
      <span>Hip to knee ÷ knee to ankle, estimated from the side view.</span>
    </p>}
    {result.motionTrace?.frames.length > 1 && <SkeletonPlayback
      motionTrace={result.motionTrace} camera={result.camera} movementStartOffsetMs={result.movementStartOffsetMs} exerciseName={info.title}
    />}
    <details className="practice-guide">
      <summary>More movement measurements</summary>
      <div className="practice-guide-body">
        <dl className="metrics-grid">{details.map(renderMetric)}</dl>
        {result.observations?.length > 0 && <p>{result.observations.map((item) => item.message).join(' ')}</p>}
        {squat && <p>At the bottom: {shown(deg, m.kneeAngleAtBottomDeg)} knee angle, {shown(deg, m.shinLeanAtBottomDeg)} shin lean{Number.isFinite(m.hipAngleAtBottomDeg) ? `, ${deg(m.hipAngleAtBottomDeg)} hip angle` : ''}. Pause: {shown(s, m.pauseMs)}.</p>}
        <p>These measurements are estimates from one camera angle.</p>
      </div>
    </details>
  </section>;
}

function App() {
  const tracker = useRef(null);
  if (!tracker.current) tracker.current = new SquatTracker();
  const recorder = useRef(null);
  const audio = useRef(null);
  const playSound = useRef(true);
  const attempt = useRef(null);
  const currentReference = useRef(null);
  const cameraVideo = useRef(null);
  const demoVideo = useRef(null);
  const overlay = useRef(null);
  const trainingCanvas = useRef(null);
  const trainingOverlay = useRef(null);
  const posePreview = useRef(null);
  const recordedOverlay = useRef(null);
  const snapshotCanvas = useRef(null);
  const guide = useRef(null);
  const reviewTitle = useRef(null);
  const studio = useRef(null);
  const videoInput = useRef(null);
  const [mode, setMode] = useState('off');
  const [exercise, setExercise] = useState('squat');
  const [training, setTraining] = useState(true);
  const [guideVisible, setGuideVisible] = useState(false);
  const [variant, setVariant] = useState('bodyweight');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState({ phase: 'setup', setup: DEFAULT_SETUP, live: null });
  const [cameraSize, setCameraSize] = useState({ width: 960, height: 540, crop: { left: 0, width: 960 } });
  const [captureStage, setCaptureStage] = useState('idle');
  const [countdown, setCountdown] = useState(0);
  const [showGo, setShowGo] = useState(false);
  const [reference, setReference] = useState(null);
  const [result, setResult] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);
  const [videoReview, setVideoReview] = useState(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const usingVideo = mode === 'video' || mode === 'video-loading';
  const loading = mode === 'loading' || mode === 'video-loading';
  const active = mode === 'camera' || mode === 'demo' || mode === 'video';
  const expanded = nativeFullscreen || fallbackFullscreen;
  const stageActive = captureStage !== 'idle';
  const selectedExercise = exerciseInfo(exercise);
  const exerciseTitle = exercise === 'squat' ? SQUAT_LABELS[variant] : selectedExercise.title;
  const setupChecks = [
    ['inFrame', 'Fit your whole body', selectedExercise.framing],
    ['sideOn', 'Turn to the side', 'Your profile can face either edge of the screen.'],
    ['steady', selectedExercise.start, 'Hold the starting pose for one second.'],
  ];

  function enableAudio() {
    if (!playSound.current || !window.AudioContext) return;
    try {
      audio.current ??= new AudioContext();
      audio.current.resume().catch(() => {});
    } catch { /* The countdown also has a visual Go signal. */ }
  }

  function signalGo() {
    const context = audio.current;
    if (!playSound.current || context?.state !== 'running') return;
    try {
      const tone = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      tone.frequency.setValueAtTime(660, now);
      tone.frequency.setValueAtTime(880, now + 0.1);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
      tone.connect(gain).connect(context.destination);
      tone.start(now);
      tone.stop(now + 0.27);
    } catch { /* Audio is optional. */ }
  }

  function clearAttempt(message) {
    attempt.current = null;
    trainingOverlay.current?.clear();
    setGuideVisible(false);
    setCaptureStage('idle');
    setCountdown(0);
    setShowGo(false);
    if (message) setNotice(message);
  }

  function clearReference() {
    currentReference.current = null;
    setReference(null);
  }

  function resetSetup() {
    clearAttempt();
    clearReference();
    tracker.current.reset();
    posePreview.current?.clear();
    setView({ phase: 'setup', setup: DEFAULT_SETUP, live: null });
  }

  function stop(message) {
    const source = recorder.current;
    recorder.current = null;
    source?.handle?.stop();
    resetSetup();
    setMode('off');
    setVideoInfo(null);
    setVideoReview(null);
    setNotice(message || '');
  }

  useEffect(() => {
    const pagehide = () => { if (recorder.current) stop(); };
    const visibility = () => {
      if (document.hidden && recorder.current && recorder.current.kind !== 'video') {
        stop('Camera paused when you left the page.');
      }
    };
    window.addEventListener('pagehide', pagehide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      recorder.current?.handle?.stop();
      posePreview.current?.clear();
      trainingOverlay.current?.clear();
      audio.current?.close().catch(() => {});
      window.removeEventListener('pagehide', pagehide);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    if (!videoReview || !cameraVideo.current || !trainingCanvas.current || !overlay.current) return;
    posePreview.current?.clear();
    trainingOverlay.current ??= createTrainingOverlay(trainingCanvas.current);
    const playback = createRecordedOverlay(cameraVideo.current, overlay.current, trainingOverlay.current, videoReview, setGuideVisible);
    recordedOverlay.current = playback;
    return () => {
      playback.dispose();
      recordedOverlay.current = null;
    };
  }, [videoReview]);

  useEffect(() => {
    recordedOverlay.current?.setGuide(training);
  }, [training, videoReview]);

  useEffect(() => {
    const syncFullscreen = () => setNativeFullscreen(document.fullscreenElement === studio.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useEffect(() => {
    if (!fallbackFullscreen) return;
    const escape = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setFallbackFullscreen(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [fallbackFullscreen]);

  async function leaveFullscreen() {
    if (document.fullscreenElement === studio.current) {
      try { await document.exitFullscreen(); }
      catch { if (document.fullscreenElement === studio.current) return false; }
    }
    setFallbackFullscreen(false);
    return true;
  }

  async function toggleFullscreen() {
    if (expanded) {
      await leaveFullscreen();
      return;
    }
    try {
      if (studio.current?.requestFullscreen && document.fullscreenEnabled) {
        await studio.current.requestFullscreen();
        return;
      }
    } catch { /* A browser or embed may forbid native fullscreen. */ }
    setFallbackFullscreen(true);
  }

  function safeCapture(frame, state, kneeAngleDeg = state.live?.kneeAngleDeg ?? null) {
    try {
      snapshotCanvas.current ??= document.createElement('canvas');
      const image = captureImage(frame.video, frame.width, frame.height, snapshotCanvas.current);
      return image ? { ...image, timestampMs: frame.timestampMs, kneeAngleDeg, pose: framePose(frame, state.live) } : null;
    } catch {
      return null;
    }
  }

  function rememberStanding(a, frame, state) {
    a.referenceAt = frame.timestampMs;
    a.capturedAt = new Date().toISOString();
    const { landmarks, width, height, crop, timestampMs } = frame;
    a.guideAnchor = { frame: { landmarks, width, height, crop, timestampMs }, side: state.live?.side };
    const image = safeCapture(frame, state);
    if (image) a.images.set('start', image);
    a.candidates.clear();
    a.trace = [];
    recordPose(a.trace, frame, state.live, true);
  }

  function resumePositioning(a) {
    trainingOverlay.current?.clear();
    setGuideVisible(false);
    a.stage = 'positioning';
    a.images.clear();
    a.candidates.clear();
    a.trace = [];
    a.movementStarted = false;
    a.guideShown = false;
    a.guideStartedAt = null;
    setCountdown(0);
    setShowGo(false);
    setCaptureStage('positioning');
  }

  function showTrainingGuide(a, frame, side, manual = false) {
    if (!a.trainingGuide || !a.guideAnchor?.side || !trainingCanvas.current) return;
    trainingOverlay.current ??= createTrainingOverlay(trainingCanvas.current);
    a.guideShown = trainingOverlay.current.start(
      a.guideAnchor.frame, a.guideAnchor.side, a.exercise, a.variant, undefined, { manual, keepAfterEnd: true },
    );
    if (a.guideShown) trainingOverlay.current.update(frame, side);
    setGuideVisible(a.guideShown);
  }

  function onFrame(frame, session) {
    if (session !== recorder.current) return;
    const { timestampMs, width, height } = frame;
    const fromVideo = session.kind === 'video';
    const crop = frame.crop ?? { left: 0, width };
    if (session.width !== width || session.height !== height) {
      if (session.width) {
        resetSetup();
        setNotice('The camera frame changed. Start a new capture to reset your baseline.');
      }
      session.width = width;
      session.height = height;
    }
    if (session.previewWidth !== crop.width || session.previewLeft !== crop.left || session.previewHeight !== height || session.previewSourceWidth !== width) {
      session.previewWidth = crop.width;
      session.previewLeft = crop.left;
      session.previewHeight = height;
      session.previewSourceWidth = width;
      setCameraSize({ width, height, crop });
    }
    const a = attempt.current;
    const trackingMotion = a?.stage === 'armed' || a?.stage === 'countdown';
    const centered = poseInCenter(frame.landmarks, width, crop);
    let state = tracker.current.update({
      ...frame,
      landmarks: centered || trackingMotion ? frame.landmarks : null,
      armed: trackingMotion,
    });
    if (!trackingMotion && (!centered || (!frame.landmarks && crop.width < width && a))) {
      state = { ...state, setup: { ...state.setup, message: 'Step into the center with your head and feet in view.' } };
    }
    const setupSide = state.setup.checks.inFrame && frame.landmarks ? (frame.landmarks[23]?.visibility >= frame.landmarks[24]?.visibility ? 'left' : 'right') : null;
    if (overlay.current) {
      posePreview.current ??= createPosePreview(overlay.current);
      const side = trackingMotion ? state.live?.side ?? state.continuitySide : state.live?.side ?? setupSide;
      posePreview.current.update({ ...frame, crop, exercise: a?.exercise ?? session.exercise }, side, trackingMotion, Boolean(state.continuitySide));
    }
    setView(state);
    if (trackingMotion) trainingOverlay.current?.update(frame, state.live?.side);
    const profile = currentReference.current;
    if (profile && !trackingMotion && state.setup.ready && state.live && profile.trackingSide !== state.live.side) {
      clearReference();
    }
    if (!a) return;
    if (fromVideo && a.guideShown) {
      if (['descending', 'bottom', 'ascending'].includes(state.phase)) a.guideStartedAt ??= timestampMs;
      trainingOverlay.current.renderAt(a.guideStartedAt == null ? 0 : timestampMs - a.guideStartedAt);
    }
    if (trackingMotion) recordPose(a.trace, frame, state.live, state.events.some(({ type, phase }) => type === 'capture' && phase === 'finish'));
    if (a.stage !== 'armed' && !fromVideo) {
      a.positioningStartedAt ??= timestampMs;
      if (timestampMs - a.positioningStartedAt > 45000) {
        clearAttempt('Setup timed out. Start again when you’re ready.');
        return;
      }
    }
    if (a.stage === 'positioning') {
      if (state.setup.ready && state.phase === 'ready') {
        rememberStanding(a, frame, state);
        if (fromVideo) {
          a.stage = 'armed';
          a.armedAt = timestampMs;
          setCaptureStage('armed');
          showTrainingGuide(a, frame, state.live?.side, true);
        } else {
          a.stage = 'countdown';
          a.countStartedAt = timestampMs;
          setCountdown(COUNTDOWN_SECONDS);
          setCaptureStage('countdown');
        }
      }
      return;
    }
    if (a.stage === 'countdown') {
      if (state.events.some((event) => event.type === 'capture')) {
        a.stage = 'armed';
        a.armedAt = timestampMs;
        setCountdown(0);
        setCaptureStage('armed');
        showTrainingGuide(a, frame, state.live?.side);
      } else if (state.phase === 'setup') {
        resumePositioning(a);
        return;
      } else {
        const remaining = Math.max(0, Math.ceil(COUNTDOWN_SECONDS - (timestampMs - a.countStartedAt) / 1000));
        const canStart = (centered || a.exercise === 'squat') && state.live && state.setup.checks.sideOn && state.setup.checks.standing;
        setCountdown(remaining);
        if (remaining || !canStart) return;
        a.stage = 'armed';
        a.armedAt = timestampMs;
        setCaptureStage('armed');
        setShowGo(true);
        signalGo();
        showTrainingGuide(a, frame, state.live?.side);
        session.handle?.perform?.();
        return;
      }
    }
    if (timestampMs - a.armedAt >= 1000) setShowGo(false);
    if (timestampMs - a.armedAt > 20000) {
      tracker.current.reset();
      if (fromVideo) resumePositioning(a);
      else clearAttempt('No complete rep was detected in time. Stand tall and try again.');
      return;
    }
    if (state.phase === 'setup' && !state.events.length) {
      if (!fromVideo && a.movementStarted) clearAttempt('Your pose left the setup area. Check the framing and try again.');
      else resumePositioning(a);
      return;
    }
    for (const event of state.events) {
      if (event.type === 'capture-candidate') {
        const image = safeCapture(frame, state, event.kneeAngleDeg);
        if (image) a.candidates.set(timestampMs, image);
      }
      if (event.type === 'capture') {
        if (event.phase === 'start') {
          a.movementStarted = true;
          if (a.images.has('start')) continue;
        }
        const image = a.candidates.get(event.timestampMs)
          ?? (event.timestampMs === timestampMs ? safeCapture(frame, state) : null);
        if (image) a.images.set(event.phase, image);
      }
      if (event.type === 'rep-discarded') {
        if (fromVideo) {
          tracker.current.reset();
          resumePositioning(a);
          break;
        }
        const message = a.exercise !== 'squat' && event.reason === 'incomplete-descent'
          ? DISCARD_MESSAGES['incomplete-movement'] : DISCARD_MESSAGES[event.reason];
        clearAttempt(message ?? 'The full rep could not be tracked. Stand side-on and try again.');
        break;
      }
      if (event.type === 'rep-complete') {
        const rep = event.rep;
        const firstRep = a.exercise === 'squat' && !currentReference.current;
        if (firstRep) {
          const next = {
            id: crypto.randomUUID(), trackingSide: rep.side,
            kneeExcursionDeg: rep.metrics.startKneeAngleDeg - rep.metrics.kneeAngleAtBottomDeg,
            standingKneeAngleDeg: rep.metrics.startKneeAngleDeg,
            torsoLeanAtBottomDeg: rep.metrics.torsoLeanAtBottomDeg,
            bottomHipToKneeLegLengths: rep.metrics.bottomHipToKneeLegLengths,
            standingThighToShinRatio: rep.metrics.standingThighToShinRatio,
            standingTorsoToLegRatio: rep.metrics.standingTorsoToLegRatio,
          };
          currentReference.current = next;
          setReference(next);
        }
        const evidence = makeEvidence({
          rep,
          images: a.images,
          motionTrace: makeMotionTrace(a.trace, a.referenceAt, rep.startedAtMs),
          captureStartMs: a.referenceAt,
          source: fromVideo ? 'video' : session.kind === 'demo' ? 'simulated' : 'webcam',
          variant: a.variant,
          camera: { width, height },
          capturedAt: a.capturedAt,
          reference: currentReference.current ? { ...currentReference.current, establishedByThisRep: firstRep } : null,
          trainingGuide: a.guideShown,
        });
        setResult(evidence);
        clearAttempt('Rep captured. Review the snapshots and measurements below.');
        if (fromVideo) {
          session.handle.finish();
          setVideoInfo((info) => ({ ...info, running: false, complete: true }));
          const movement = Math.max(a.referenceAt, rep.startedAtMs);
          const bottom = rep.frames.find(({ phase }) => phase === 'bottom')?.timestampMs ?? movement;
          const returned = rep.returnedAtMs;
          const rise = Math.max(bottom, returned - (rep.metrics.ascentMs ?? rep.metrics.returnMs));
          setVideoReview({
            evidence,
            anchor: a.guideAnchor,
            timing: { start: a.referenceAt, movement, bottom, rise, returned, end: timestampMs },
          });
        }
        break;
      }
    }
  }

  async function startCamera() {
    if (recorder.current) return;
    enableAudio();
    resetSetup();
    setError('');
    setNotice('');
    const session = { kind: 'camera', exercise };
    recorder.current = session;
    setMode('loading');
    try {
      const { createCamera } = await import('./camera.js');
      if (session !== recorder.current) return;
      session.handle = createCamera(cameraVideo.current, { initialExercise: exercise, onFrame: (frame) => onFrame(frame, session), onError: (err) => {
        if (session !== recorder.current) return;
        stop();
        setError(err.message);
      } });
      await session.handle.start();
      if (session === recorder.current) {
        setMode('camera');
        startRep();
      }
    } catch (err) {
      if (session !== recorder.current) return;
      stop();
      setError(err.message || 'The camera could not open.');
    }
  }

  async function startVideo(file) {
    if (!file || (recorder.current && recorder.current.kind !== 'video')) return;
    recorder.current?.handle?.stop();
    resetSetup();
    setError('');
    setNotice('');
    setMode('video-loading');
    setVideoReview(null);
    setVideoInfo({ name: file.name, at: 0, duration: 0, running: true, complete: false });
    const session = { kind: 'video', exercise, file };
    recorder.current = session;
    prepareAttempt(training);
    const fail = (err) => {
      if (session !== recorder.current) return;
      stop();
      setError(err.message || 'The video could not be read. Try an MP4 or WebM.');
    };
    try {
      const { createVideoAnalysis } = await import('./video-analysis.js');
      if (session !== recorder.current) return;
      session.handle = createVideoAnalysis(cameraVideo.current, {
        onFrame: (frame) => onFrame(frame, session),
        onProgress: (at, duration) => {
          if (session !== recorder.current) return;
          setMode('video');
          setVideoInfo((info) => ({ ...info, at, duration }));
        },
        onEnd: () => {
          if (session !== recorder.current) return;
          clearAttempt('No complete rep found. Keep your whole body in side view and hold the start and finish.');
          setVideoInfo((info) => ({ ...info, at: info.duration, running: false }));
        },
        onError: fail,
      });
      await session.handle.start(file);
    } catch (err) {
      fail(err);
    }
  }

  function chooseVideo() {
    if (!videoInput.current) return;
    videoInput.current.value = '';
    videoInput.current.click();
  }

  function playVideoGuide() {
    const playback = recordedOverlay.current;
    if (!playback) return;
    setTraining(true);
    playback.setGuide(true);
    studio.current?.scrollIntoView({ block: 'start' });
    void playback.playRep();
  }

  function startDemo() {
    if (recorder.current) return;
    enableAudio();
    resetSetup();
    setError('');
    setNotice('');
    const session = { kind: 'demo', exercise };
    recorder.current = session;
    session.handle = runExample(session, exercise);
    setMode('demo');
    startRep();
  }

  function runExample(session, exerciseId) {
    const emit = (frame) => onFrame(frame, session);
    return exerciseId === 'squat'
      ? createDemo(demoVideo.current, emit, variant)
      : createMobilityDemo(demoVideo.current, emit, exerciseId);
  }

  function changeExercise(next) {
    if (next === exercise || attempt.current) return;
    resetSetup();
    tracker.current = next === 'squat' ? new SquatTracker() : new MobilityTracker(next);
    const session = recorder.current;
    if (session) session.exercise = next;
    if (session?.kind === 'demo') {
      session.handle.stop();
      session.handle = runExample(session, next);
    } else if (session?.kind === 'camera') session.handle?.setExercise(next);
    setExercise(next);
    setNotice('');
  }

  function changeVariant(nextVariant) {
    if (nextVariant === variant || attempt.current) return;
    setVariant(nextVariant);
    if (recorder.current?.kind === 'demo') {
      recorder.current.handle.setVariant(nextVariant);
      resetSetup();
      setNotice('');
    } else {
      clearReference();
    }
  }

  function startRep() {
    if (!recorder.current || attempt.current) return;
    enableAudio();
    prepareAttempt(training);
  }

  function prepareAttempt(withGuide) {
    setNotice('');
    attempt.current = {
      stage: 'positioning', images: new Map(), candidates: new Map(), trace: [],
      exercise, variant: exercise === 'squat' ? variant : 'bodyweight', trainingGuide: withGuide,
    };
    setCaptureStage('positioning');
  }

  async function openBelowStudio(target) {
    if (expanded && !(await leaveFullscreen())) return;
    // Let the viewport return to document flow before scrolling to the result or guide.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'start' });
    }));
  }

  function showGuide() {
    const details = guide.current;
    if (!details) return;
    details.open = true;
    void openBelowStudio(details.querySelector('summary'));
  }

  const isRecording = captureStage === 'armed';
  const isCounting = captureStage === 'countdown';
  let cameraLabel = 'Camera off';
  let cameraTone = 'off';
  if (usingVideo) {
    cameraLabel = loading ? 'Opening video'
      : videoInfo?.running ? 'Analyzing video' : videoInfo?.complete ? 'Rep captured' : 'No rep found';
    cameraTone = videoInfo?.running ? 'pending' : videoInfo?.complete ? 'ready' : 'off';
  } else if (mode === 'loading') {
    cameraLabel = 'Starting camera';
    cameraTone = 'pending';
  } else if (isRecording && view.live) {
    cameraLabel = 'Capturing';
    cameraTone = 'recording';
  } else if (isRecording) {
    cameraLabel = 'Reacquiring pose';
    cameraTone = 'pending';
  } else if (isCounting || view.setup.ready) {
    cameraLabel = isCounting ? (countdown > 0 ? 'Countdown' : 'Waiting for a clear pose') : 'In position';
    cameraTone = 'ready';
  } else if (active) {
    cameraLabel = view.setup.checks.inFrame ? 'Adjust position' : 'Looking for pose';
    cameraTone = 'pending';
  }
  let movementPrompt = 'Reacquiring your side view';
  let setupMessage = active ? view.setup.message : '';
  if (isCounting) {
    setupMessage = countdown > 0 && view.live ? 'Starting stance saved. Move when you see Go.' : view.setup.message;
  } else if (isRecording && view.live) {
    if (view.live.finishing) {
      movementPrompt = 'Hold briefly';
      setupMessage = 'Hold your starting position briefly to finish the rep.';
    } else if (view.phase === 'ascending') {
      movementPrompt = selectedExercise.phases.ascent;
      setupMessage = exercise === 'squat' ? 'Stand back up and hold briefly.' : 'Return to your starting stance.';
    } else {
      movementPrompt = selectedExercise.phases[PHASE_LABEL_KEY[view.phase]] ?? 'Perform one rep';
      setupMessage = selectedExercise.action;
    }
  }
  const previewWidth = active ? cameraSize.crop.width : 960;
  const previewHeight = active ? cameraSize.height : 540;
  const currentResult = result?.exercise === exercise && (exercise !== 'squat' || result.variant === variant);
  const cameraCue = usingVideo && videoInfo?.running ? (isRecording && view.phase !== 'ready' && view.live
    ? movementPrompt : isRecording ? 'Looking for a complete rep' : 'Looking for the starting pose')
    : isRecording ? movementPrompt
    : !stageActive && notice ? (currentResult && notice.startsWith('Rep captured.') ? 'Rep captured' : notice)
    : !stageActive && currentResult ? 'Rep captured'
    : view.setup.message;
  const viewfinderCue = VIEWFINDER_CUES[cameraCue] ?? cameraCue;
  const liveAnnouncement = countdown > 0 ? `Recording in ${countdown} seconds`
    : showGo ? 'Go' : active ? viewfinderCue : notice;

  return <main className="main">
        <section ref={studio} className="camera-panel" data-expanded={expanded} data-fallback={fallbackFullscreen} aria-labelledby="studio-title">
          <input ref={videoInput} type="file" accept="video/*,.mp4,.mov,.webm,.m4v" hidden aria-label="Video file" onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void startVideo(file);
          }} />
          <header className="app-header">
            <div className="studio-heading">
              <div className="wordmark"><span className="brand-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 18 18" fill="none"><path d="M2 11h3l2.5-6 3.5 9 2-4h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span className="wordmark-text">COMPOSE</span></div>
              <h1 id="studio-title">Mobility camera</h1>
            </div>
            <div className="studio-tools">
              <a className="button button-studio-link music-studio-link" href="./music.html" aria-label="Music studio">
                <Icon name="music" /><span>Music studio</span>
              </a>
              <button className="button button-studio-link" onClick={showGuide}>Exercise guide</button>
              <button className="button button-studio-link fullscreen-button" aria-label={expanded ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>
                <Icon name={expanded ? 'contract' : 'expand'} /><span className="fullscreen-label">{expanded ? 'Exit full screen' : 'Full screen'}</span>
              </button>
            </div>
          </header>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="viewport-wrap" data-active={active}>
            <span className="camera-status" data-tone={cameraTone}>{cameraLabel}</span>
            {videoInfo && <div className="video-progress">
              <span className="video-progress-label" title={videoInfo.name}>
                {videoInfo.duration ? `${clipTime(videoInfo.at)} / ${clipTime(videoInfo.duration)}` : 'Reading video…'}
              </span>
              <progress max={1} value={videoInfo.duration ? videoInfo.at / videoInfo.duration : undefined} aria-label="Video analysis progress" />
            </div>}
            <span className="visually-hidden" role="status">{liveAnnouncement}</span>
            {active && !showGo && countdown === 0 && <div className="phase-pill" data-recording={isRecording} aria-hidden="true">{viewfinderCue}</div>}
            <div className="viewport" data-idle={!active} data-exercise={exercise} style={{ aspectRatio: `${previewWidth} / ${previewHeight}`, '--source-ratio': previewWidth / previewHeight }}>
              <video ref={cameraVideo} className="camera-video" hidden={mode !== 'camera' && mode !== 'video'} controls={mode === 'video' && !videoInfo?.running} muted playsInline aria-label={usingVideo ? 'Uploaded side-view clip' : 'Centered live side view'} style={{
                width: `${cameraSize.width / cameraSize.crop.width * 100}%`,
                left: `${-cameraSize.crop.left / cameraSize.crop.width * 100}%`,
              }} />
              <canvas ref={demoVideo} className="demo-video" hidden={mode !== 'demo'} role="img" aria-label={`Simulated ${exerciseTitle.toLowerCase()} from the side`} />
              <canvas ref={trainingCanvas} className="training-overlay" aria-hidden="true" />
              <canvas ref={overlay} className="pose-overlay" data-reacquiring={stageActive && captureStage !== 'positioning' && !view.live} hidden={!active} aria-hidden="true" />
              {(!active || (!usingVideo && !isRecording && !view.setup.ready)) && <div className="frame-guide" data-idle={!active} aria-hidden="true" />}
              {!active && <div className="empty-camera">
                <span className="empty-camera-icon"><CameraIcon size={34} /></span>
                <strong>{mode === 'video-loading' ? 'Opening video' : loading ? 'Starting camera' : 'Ready when you are'}</strong>
                <p>{mode === 'video-loading' ? 'Preparing the clip on this device.' : loading ? 'Allow camera access if your browser asks.' : selectedExercise.framing}</p>
                {mode === 'off' && <div className="empty-actions">
                  <button className="button button-primary" onClick={startCamera}>Start camera</button>
                  <button className="button button-viewfinder-link" onClick={chooseVideo}><Icon name="upload" />Upload video</button>
                  <button className="button button-viewfinder-link" onClick={startDemo}><Icon name="play" />Try simulated example</button>
                </div>}
              </div>}
              {mode === 'demo' && <div className="demo-tag">{exerciseTitle} example</div>}
              {guideVisible && <div className="training-tag" aria-label="Overlay legend">
                <span className="tracked-key">{usingVideo ? 'Recorded pose' : 'Live pose'}</span><span className="guide-key">Training guide</span>
              </div>}
              {countdown > 0 && <div className="countdown" aria-hidden="true">{countdown}</div>}
              {showGo && <div className="countdown" aria-hidden="true">Go</div>}
            </div>
          </div>
          <div className="camera-dock">
            <div className="camera-settings">
              <label className="example-control dock-select">Exercise
                <select value={exercise} disabled={stageActive || loading} onChange={(event) => changeExercise(event.currentTarget.value)}>
                  {Object.entries(EXERCISES).map(([id, info]) => <option key={id} value={id}>{info.title}</option>)}
                </select>
              </label>
              {exercise === 'squat' && <label className="example-control dock-select">Squat type
                <select value={variant} disabled={stageActive || loading} onChange={(event) => changeVariant(event.currentTarget.value)}>
                  <option value="bodyweight">Bodyweight</option>
                  <option value="barbell">Barbell</option>
                </select>
              </label>}
            </div>
            <div className="camera-controls">
              <label className="training-toggle">
                <input type="checkbox" checked={training} disabled={stageActive || loading} onChange={(event) => setTraining(event.currentTarget.checked)} />
                <span>Training overlay</span>
              </label>
              {!usingVideo && active && !stageActive && <button className="button button-primary" onClick={startRep}>{reference || currentResult ? 'Capture another rep' : 'Capture one rep'}</button>}
              {result && !stageActive && <button className="button button-secondary" onClick={() => void openBelowStudio(reviewTitle.current)}>{usingVideo && !videoInfo?.complete ? 'Review last rep' : 'Review rep'}</button>}
              {usingVideo && !videoInfo?.running && <>
                {videoReview && <button className="button button-primary" onClick={playVideoGuide}><Icon name="play" />Play rep with guide</button>}
                <button className={`button ${videoReview ? 'button-secondary' : 'button-primary'}`} onClick={chooseVideo}><Icon name="upload" />Upload another video</button>
                <button className="button button-secondary" onClick={() => void startVideo(recorder.current?.file)}>Analyze again</button>
              </>}
              {!usingVideo && active && <button className="button button-secondary button-sound" aria-pressed={soundEnabled} onClick={() => {
                playSound.current = !playSound.current;
                setSoundEnabled(playSound.current);
                enableAudio();
              }}><Icon name={soundEnabled ? 'sound' : 'mute'} />Go sound: {soundEnabled ? 'on' : 'off'}</button>}
              {!usingVideo && stageActive && <button className="button button-secondary" onClick={() => { clearAttempt('Rep capture cancelled.'); tracker.current.reset(); }}>Cancel rep</button>}
              {!usingVideo && active && !stageActive && <button className="button button-secondary" onClick={() => { resetSetup(); setNotice('Camera setup reset.'); }}>Redo setup</button>}
              {(active || loading) && <button className="button button-stop" onClick={() => stop()}><Icon name="stop" />{usingVideo ? videoInfo?.running ? 'Stop analysis' : 'Remove video' : mode === 'demo' ? 'Stop example' : 'Stop camera'}</button>}
            </div>
          </div>
        </section>
        <div className="studio-details" inert={expanded}>
        <aside className="setup-panel" aria-labelledby="setup-title">
          <h2 id="setup-title">Set up your side view</h2>
          <p className="step-copy">{selectedExercise.setup}</p>
          {!isRecording && <ol className="checklist" aria-label="Camera setup checklist">{setupChecks.map(([key, title, hint], index) => {
            const passed = key === 'steady' ? view.setup.ready : Boolean(view.setup.checks[key]);
            return <li className="check-item" key={key} data-passed={passed}>
              <span className="check-icon" aria-hidden="true">{passed ? <Icon name="check" /> : index + 1}</span>
              <span className="check-text"><strong>{title}{active && <span className="visually-hidden">: {passed ? 'ready' : 'waiting'}</span>}</strong><small>{hint}</small></span>
            </li>;
          })}</ol>}
          {active && captureStage === 'positioning' && view.setup.progress > 0 && <div className="progress-track" aria-hidden="true"><div className="progress-fill" style={{ width: `${view.setup.progress * 100}%` }} /></div>}
          <p className="setup-hint">{notice || setupMessage}</p>
          <PracticeGuide live={view.live} reference={reference} variant={variant} exercise={exercise} guideRef={guide} />
          <p className="privacy-badge"><Icon name="shield" />Capture and replay run on this device</p>
        </aside>
      {result && <RepResult key={result.id} result={result} titleRef={reviewTitle} onPlayGuide={videoReview ? playVideoGuide : undefined} onClear={() => {
        setResult(null);
        setVideoReview(null);
        setNotice('Result cleared.');
        guide.current?.querySelector('summary')?.focus();
      }} />}
        </div>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);

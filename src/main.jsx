import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SquatTracker } from './squat-tracker.js';
import { createDemo } from './demo.js';
import { poseInCenter } from './camera-crop.js';
import { createPosePreview } from './pose-preview.js';
import { makeMotionTrace, recordPose } from './motion-trace.js';
import { SkeletonPlayback } from './skeleton-playback.jsx';
import { captureImage, downloadEvidence, FORM_GUIDE, framePose, makeEvidence, PHASE_LABELS } from './evidence.js';
import './styles.css';

const DEFAULT_SETUP = { ready: false, checks: {}, message: 'Start the camera to check your position.', progress: 0 };
const CHECKS = [
  ['inFrame', 'Fit your whole body', 'Keep your head and feet in view.'],
  ['sideOn', 'Turn to the side', 'Face left or right.'],
  ['steady', 'Stand comfortably', 'Keep your feet planted and wait for Go.'],
];
const PHASE = { setup: 'Positioning', ready: 'Ready', descending: 'Lowering', bottom: 'Bottom', ascending: 'Rising' };
const COUNTDOWN_SECONDS = 3;
const DISCARD_MESSAGES = {
  'tracking-gap': 'Tracking was lost. Keep your near hip, knee and ankle in view, then try again.',
  'foot-moved': 'Your foot position changed. Stand still and redo setup.',
  'low-confidence': 'Too much of the squat was obscured. Keep your near hip, knee and ankle visible.',
  'incomplete-descent': 'The camera saw a partial bend. Try one comfortable squat and return to standing.',
  'incomplete-ascent': 'The camera missed the rise. Stand back up and hold briefly at the finish.',
  'second-descent': 'The camera saw a second dip. Capture one squat at a time.',
  timeout: 'No complete rep was detected in time. Stand tall and try again.',
};
const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
const deg = (n) => `${Math.round(n)}°`;
const velocity = (n) => `${n.toFixed(2)}`;
const ratio = (n) => `${n.toFixed(2)} : 1`;
const shown = (format, value) => Number.isFinite(value) ? format(value) : '—';

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
    download: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 16v4h16v-4"/></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function figurePaths(x, depth, proportions) {
  const leg = 33;
  const ratio = Math.min(1.65, Math.max(0.70, proportions?.standingThighToShinRatio ?? 1.1));
  const shin = leg / (1 + ratio), thigh = leg - shin;
  const torso = leg * Math.min(0.85, Math.max(0.35, proportions?.standingTorsoToLegRatio ?? 0.55));
  const radians = (n) => n * Math.PI / 180;
  const point = ([x, y], l, a) => [x + l * Math.sin(radians(a)), y - l * Math.cos(radians(a))];
  const ankle = [x, 85], knee = point(ankle, shin, 2 + depth * 20);
  const hip = point(knee, thigh, -depth * 78), shoulder = point(hip, torso, 2 + depth * 36);
  const head = point(shoulder, 10, 10);
  return <g><path d={`M${x + 9},85 L${ankle} L${knee} L${hip} L${shoulder} l12,9`}/><circle cx={head[0]} cy={head[1]} r="5.5"/></g>;
}

function PracticeGuide({ live, reference, guideRef }) {
  const [example, setExample] = useState('auto');
  const proportions = live ?? reference;
  const ratio = Math.min(1.65, Math.max(0.70, proportions?.standingThighToShinRatio ?? 1.1));
  const thighFraction = ratio / (1 + ratio);
  // Illustrate the thigh stopping above horizontal, scaled to the projected leg proportions.
  const moderateBend = 22 + Math.acos(Math.min(1, 0.20 / thighFraction)) * 180 / Math.PI;
  const exampleBend = example === 'short' ? moderateBend - 26 : example === 'long' ? moderateBend + 8 : reference?.kneeExcursionDeg ?? moderateBend;
  const depth = Math.min(1, Math.max(0.38, exampleBend / 98));
  return <details className="practice-guide" ref={guideRef}>
    <summary>See a squat example</summary>
    <div className="practice-guide-body">
      <svg className="form-example" viewBox="0 0 260 114" role="img" aria-label="Side view illustration: standing, lowering with bent knees and hips, then standing again">
        <path d="M13 88H247" stroke="#a0abc4" strokeWidth="1.5" />
        <g fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          {figurePaths(48, 0, proportions)}{figurePaths(130, depth, proportions)}{figurePaths(208, 0, proportions)}
        </g>
        <g fill="currentColor" fontSize="11" fontFamily="system-ui" textAnchor="middle"><text x="48" y="107">Stand</text><text x="130" y="107">Lower</text><text x="208" y="107">Stand</text></g>
      </svg>
      <label className="example-control">Example range <select value={example} onChange={(event) => setExample(event.target.value)}><option value="auto">{reference ? 'Use first rep as a guide' : 'Moderate'}</option><option value="short">Shallower</option><option value="long">Deeper</option></select></label>
      <ul>{FORM_GUIDE.map((tip) => <li key={tip}>{tip}</li>)}</ul>
      <p>{proportions?.standingThighToShinRatio ? 'The illustration uses your estimated thigh, shin and torso proportions.' : 'Once you stand in view, the illustration can use your estimated body proportions.'} The example shows a movement pattern. Use a depth that feels comfortable for you.</p>
    </div>
  </details>;
}

function RepResult({ result, onClear, titleRef }) {
  const [selected, setSelected] = useState(result.snapshots.find(({ phase }) => phase === 'bottom')?.phase ?? result.snapshots[0]?.phase);
  const [expanded, setExpanded] = useState(false);
  const selectedSnapshot = result.snapshots.find(({ phase }) => phase === selected);
  const m = result.metrics;
  const reference = result.reference;
  const mainValues = [
    ['Lowering', s, m.descentMs],
    ['Rising', s, m.ascentMs],
    ['Knee bend', deg, m.kneeExcursionDeg, reference?.establishedByThisRep === false ? `First rep: ${deg(reference.kneeExcursionDeg)}` : ''],
  ];
  const details = [
    ['Down speed', velocity, m.averageDescentLegLengthsPerSec, 'Leg lengths per second'], ['Up speed', velocity, m.averageAscentLegLengthsPerSec, 'Leg lengths per second'],
    ['Torso lean', deg, m.torsoLeanAtBottomDeg, 'From vertical at the bottom'], ['Return difference', deg, m.returnAngleErrorDeg, 'Compared with your start'],
    ['Tracking', (v) => `${Math.round(v * 100)}%`, m.validFrameFraction, 'Usable pose samples'],
  ];
  const renderMetric = ([label, format, value, note]) => <div className="metric-card" key={label}>
    <dt>{label}</dt><dd>{shown(format, value)}{note && <small>{note}</small>}</dd>
  </div>;

  return <section className="result-panel" aria-labelledby="result-title" id="review">
    <div className="result-header">
      <div>
        <h2 id="result-title" tabIndex={-1} ref={titleRef}>Rep captured</h2>
        <p>{result.source === 'simulated' ? 'Simulated example' : result.variant === 'barbell' ? 'Barbell squat' : 'Bodyweight squat'}{reference?.establishedByThisRep ? ' · First rep baseline' : ''}</p>
      </div>
      <div className="result-actions">
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
            <span>{PHASE_LABELS[snapshot.phase]}</span>
          </button>)}
        </div>}
        {expanded && selectedSnapshot && <figure className="selected-snapshot">
          <img src={selectedSnapshot.url} alt={`Side view · ${PHASE_LABELS[selectedSnapshot.phase]}`} />
          <figcaption>{PHASE_LABELS[selectedSnapshot.phase]}<span>{s(selectedSnapshot.offsetMs)} from capture start{Number.isFinite(selectedSnapshot.pose?.thighToShinRatio) && ` · Thigh to shin ${ratio(selectedSnapshot.pose.thighToShinRatio)}`}</span></figcaption>
        </figure>}
        {result.snapshots.length < 5 && <p className="snapshot-note">Some snapshots were unavailable. The export includes the images that were captured.</p>}
      </div>
      <dl className="primary-metrics" aria-label="Key measurements">
        {mainValues.map(renderMetric)}
      </dl>
    </div>
    {Number.isFinite(m.thighToShinRatio) && <p className="leg-ratio">
      <strong>Thigh to shin</strong><strong>{ratio(m.thighToShinRatio)}</strong>
      <span>Hip to knee ÷ knee to ankle, estimated from the side view.</span>
    </p>}
    {result.motionTrace?.frames.length > 1 && <SkeletonPlayback
      motionTrace={result.motionTrace} camera={result.camera} movementStartOffsetMs={result.movementStartOffsetMs}
    />}
    <details className="practice-guide">
      <summary>More movement measurements</summary>
      <div className="practice-guide-body">
        <dl className="metrics-grid">{details.map(renderMetric)}</dl>
        <p>{result.observations.map((item) => item.message).join(' ')}</p>
        <p>At the bottom: {shown(deg, m.kneeAngleAtBottomDeg)} knee angle, {shown(deg, m.shinLeanAtBottomDeg)} shin lean{Number.isFinite(m.hipAngleAtBottomDeg) ? `, ${deg(m.hipAngleAtBottomDeg)} hip angle` : ''}. Pause: {shown(s, m.pauseMs)}.</p>
        <p>These estimates come from a single 2D view. This angle cannot assess side-to-side knee alignment, spinal loading, or overall squat safety.</p>
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
  const posePreview = useRef(null);
  const snapshotCanvas = useRef(null);
  const guide = useRef(null);
  const reviewTitle = useRef(null);
  const [mode, setMode] = useState('off');
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
  const active = mode === 'camera' || mode === 'demo';
  const stageActive = captureStage !== 'idle';

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
    setNotice(message || '');
  }

  useEffect(() => {
    const pagehide = () => stop('Camera paused when you left the page.');
    const visibility = () => { if (document.hidden && recorder.current) pagehide(); };
    window.addEventListener('pagehide', pagehide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      recorder.current?.handle?.stop();
      posePreview.current?.clear();
      audio.current?.close().catch(() => {});
      window.removeEventListener('pagehide', pagehide);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

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
    const image = safeCapture(frame, state);
    if (image) a.images.set('start', image);
    a.candidates.clear();
    a.trace = [];
    recordPose(a.trace, frame, state.live, true);
  }

  function resumePositioning(a) {
    a.stage = 'positioning';
    a.images.clear();
    a.candidates.clear();
    a.trace = [];
    setCountdown(0);
    setShowGo(false);
    setCaptureStage('positioning');
  }

  function onFrame(frame, session) {
    if (session !== recorder.current) return;
    const { timestampMs, width, height } = frame;
    const crop = frame.crop ?? { left: 0, width };
    if (session.width !== width || session.height !== height) {
      if (session.width) {
        resetSetup();
        setNotice('The camera frame changed. Start a new capture to reset your baseline.');
      }
      session.width = width;
      session.height = height;
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
      posePreview.current.update({ ...frame, crop }, state.live?.side ?? setupSide, Boolean(state.live && trackingMotion));
    }
    setView(state);
    const profile = currentReference.current;
    if (profile && !trackingMotion && state.setup.ready && state.live && profile.trackingSide !== state.live.side) {
      clearReference();
    }
    if (!a) return;
    if (trackingMotion) recordPose(a.trace, frame, state.live, state.events.some(({ type, phase }) => type === 'capture' && phase === 'finish'));
    if (a.stage !== 'armed') {
      a.positioningStartedAt ??= timestampMs;
      if (timestampMs - a.positioningStartedAt > 45000) {
        clearAttempt('Setup timed out. Start again when you’re ready.');
        return;
      }
    }
    if (a.stage === 'positioning') {
      if (state.setup.ready && state.phase === 'ready') {
        rememberStanding(a, frame, state);
        a.stage = 'countdown';
        a.countStartedAt = timestampMs;
        setCountdown(COUNTDOWN_SECONDS);
        setCaptureStage('countdown');
      }
      return;
    }
    if (a.stage === 'countdown') {
      if (state.events.some((event) => event.type === 'capture')) {
        a.stage = 'armed';
        a.armedAt = timestampMs;
        setCountdown(0);
        setCaptureStage('armed');
      } else if (state.phase === 'setup') {
        resumePositioning(a);
        return;
      } else {
        const remaining = Math.max(0, Math.ceil(COUNTDOWN_SECONDS - (timestampMs - a.countStartedAt) / 1000));
        const canStart = centered && state.live && state.setup.checks.sideOn && state.setup.checks.standing;
        setCountdown(remaining || (canStart ? 0 : 1));
        if (remaining || !canStart) return;
        a.stage = 'armed';
        a.armedAt = timestampMs;
        setCaptureStage('armed');
        setShowGo(true);
        signalGo();
        session.handle?.perform?.();
        return;
      }
    }
    if (timestampMs - a.armedAt >= 1000) setShowGo(false);
    if (timestampMs - a.armedAt > 20000) {
      tracker.current.reset();
      clearAttempt('No complete rep was detected in time. Stand tall and try again.');
      return;
    }
    if (state.phase === 'setup' && !state.events.length && timestampMs - a.armedAt > 800) {
      if (a.movementStarted) clearAttempt('Your pose left the setup area. Check the framing and try again.');
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
        clearAttempt(DISCARD_MESSAGES[event.reason] ?? 'The full rep could not be tracked. Stand side-on and try again.');
        break;
      }
      if (event.type === 'rep-complete') {
        const rep = event.rep;
        const firstRep = !currentReference.current;
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
        setResult(makeEvidence({
          rep,
          images: a.images,
          motionTrace: makeMotionTrace(a.trace, a.referenceAt, rep.startedAtMs),
          captureStartMs: a.referenceAt,
          source: session.kind === 'demo' ? 'simulated' : 'webcam',
          variant: a.variant,
          camera: { width, height },
          capturedAt: a.capturedAt,
          reference: { ...currentReference.current, establishedByThisRep: firstRep },
        }));
        clearAttempt('Rep captured. Review the snapshots and measurements below.');
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
    const session = { kind: 'camera' };
    recorder.current = session;
    setMode('loading');
    try {
      const { createCamera } = await import('./camera.js');
      if (session !== recorder.current) return;
      session.handle = createCamera(cameraVideo.current, { onFrame: (frame) => onFrame(frame, session), onError: (err) => {
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

  function startDemo() {
    if (recorder.current) return;
    enableAudio();
    resetSetup();
    setError('');
    setNotice('');
    const session = { kind: 'demo' };
    recorder.current = session;
    session.handle = createDemo(demoVideo.current, (frame) => onFrame(frame, session));
    setMode('demo');
    startRep();
  }

  function startRep() {
    if (!recorder.current || attempt.current) return;
    enableAudio();
    setNotice('');
    attempt.current = {
      stage: 'positioning', images: new Map(), candidates: new Map(), trace: [],
      variant: recorder.current.kind === 'demo' ? 'bodyweight' : variant,
    };
    setCaptureStage('positioning');
  }

  function showGuide() {
    const details = guide.current;
    if (!details) return;
    details.open = true;
    details.querySelector('summary')?.focus();
  }

  const isRecording = captureStage === 'armed';
  const isCounting = captureStage === 'countdown';
  let cameraLabel = 'Camera off';
  let cameraTone = 'off';
  if (mode === 'loading') {
    cameraLabel = 'Starting camera';
    cameraTone = 'pending';
  } else if (isRecording && view.live) {
    cameraLabel = 'Capturing';
    cameraTone = 'recording';
  } else if (isRecording) {
    cameraLabel = 'Reacquiring pose';
    cameraTone = 'pending';
  } else if (isCounting || view.setup.ready) {
    cameraLabel = isCounting ? 'Countdown' : 'In position';
    cameraTone = 'ready';
  } else if (active) {
    cameraLabel = view.setup.checks.inFrame ? 'Adjust position' : 'Looking for pose';
    cameraTone = 'pending';
  }
  let movementPrompt = 'Finding your pose…';
  let setupMessage = active ? view.setup.message : '';
  if (isCounting) {
    setupMessage = 'Starting stance saved. Move when you see Go.';
  } else if (isRecording && view.live) {
    if (view.live.finishing) {
      movementPrompt = 'Hold briefly';
      setupMessage = 'Stay upright briefly to finish the rep.';
    } else if (view.phase === 'ascending') {
      movementPrompt = 'Stand back up';
      setupMessage = 'Return to your starting stance.';
    } else {
      movementPrompt = view.phase === 'ready' ? 'Perform one squat' : PHASE[view.phase];
      setupMessage = 'Lower once, stand back up, and hold briefly.';
    }
  }
  const previewWidth = active ? cameraSize.crop.width : 960;
  const previewHeight = active ? cameraSize.height : 540;

  return <div className="app-shell">
    <header className="app-header">
      <div className="wordmark"><span className="brand-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 11h3l2.5-6 3.5 9 2-4h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg></span> COMPOSE</div>
      <span className="privacy-badge"><Icon name="shield" />Video stays on this device</span>
    </header>
    <main className="main">
      <div className="page-intro">
        <div><h1>Squat camera</h1><p className="intro-copy">Capture one squat from the side.</p></div>
        <button className="button button-link" onClick={showGuide}>Squat guide</button>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="studio-grid">
        <section className="camera-panel" aria-label="Camera preview">
          <div className="panel-heading"><h2 className="panel-title">Camera preview</h2><span className="camera-status" data-tone={cameraTone}>{cameraLabel}</span></div>
          <div className="viewport-wrap">
            <div className="viewport" data-idle={!active} style={{ aspectRatio: `${previewWidth} / ${previewHeight}`, '--source-ratio': previewWidth / previewHeight }}>
              <video ref={cameraVideo} className="camera-video" hidden={mode !== 'camera'} muted playsInline aria-label="Centered live side view" style={{
                width: `${cameraSize.width / cameraSize.crop.width * 100}%`,
                left: `${-cameraSize.crop.left / cameraSize.crop.width * 100}%`,
              }} />
              <canvas ref={demoVideo} className="demo-video" hidden={mode !== 'demo'} aria-label="Simulated side view" />
              <canvas ref={overlay} className="pose-overlay" hidden={!active} aria-hidden="true" />
              {(!active || (!isRecording && !view.setup.ready)) && <div className="frame-guide" data-idle={!active} aria-hidden="true" />}
              {!active && <div className="empty-camera">
                <span className="empty-camera-icon"><CameraIcon size={34} /></span>
                <strong>{mode === 'loading' ? 'Starting camera' : 'Ready when you are'}</strong>
                <p>{mode === 'loading' ? 'Allow camera access if your browser asks.' : 'Set your laptop down, then step into the center.'}</p>
                {mode === 'off' && <div className="empty-actions">
                  <button className="button button-primary" onClick={startCamera}>Start camera</button>
                  <button className="button button-viewfinder-link" onClick={startDemo}><Icon name="play" />Try simulated example</button>
                </div>}
              </div>}
              {active && !showGo && !isCounting && <div className="phase-pill">
                {isRecording ? movementPrompt : (result && !stageActive ? 'Rep captured' : view.setup.message)}
              </div>}
              {mode === 'demo' && <div className="demo-tag">Simulated example</div>}
              {countdown > 0 && <div className="countdown" aria-label={`Recording in ${countdown} seconds`}>{countdown}</div>}
              {showGo && <div className="countdown" aria-hidden="true">Go</div>}
            </div>
          </div>
          {(active || mode === 'loading') && <div className="camera-controls">
            <button className="button button-stop" onClick={() => stop()}>{mode === 'demo' ? 'Stop example' : 'Stop camera'}</button>
            {stageActive && <button className="button button-secondary" onClick={() => { clearAttempt('Rep capture cancelled.'); tracker.current.reset(); }}>Cancel rep</button>}
            {active && !stageActive && <button className="button button-secondary" onClick={() => { resetSetup(); setNotice('Camera setup reset.'); }}>Redo setup</button>}
            {active && <button className="button button-secondary" aria-pressed={soundEnabled} onClick={() => {
              playSound.current = !playSound.current;
              setSoundEnabled(playSound.current);
              enableAudio();
            }}><Icon name={soundEnabled ? 'sound' : 'mute'} />Go sound: {soundEnabled ? 'on' : 'off'}</button>}
          </div>}
        </section>
        <aside className="setup-panel" aria-labelledby="setup-title">
          <h2 id="setup-title">{isRecording ? 'Perform one squat' : isCounting ? 'Get ready' : 'Set up your side view'}</h2>
          <p className="step-copy">{isRecording ? 'Use a range that feels comfortable.' : 'The countdown starts when you’re in position.'}</p>
          {!isRecording && <label className="example-control squat-variant">Squat type
            <select value={mode === 'demo' ? 'bodyweight' : variant} disabled={stageActive || mode === 'demo' || mode === 'loading'} onChange={(event) => {
              setVariant(event.currentTarget.value);
              clearReference();
            }}>
              <option value="bodyweight">Bodyweight</option>
              <option value="barbell">Barbell</option>
            </select>
          </label>}
          {!isRecording && <ol className="checklist" aria-label="Camera setup checklist">{CHECKS.map(([key, title, hint], index) => {
            const passed = key === 'steady' ? view.setup.ready : Boolean(view.setup.checks[key]);
            return <li className="check-item" key={key} data-passed={passed}>
              <span className="check-icon" aria-hidden="true">{passed ? <Icon name="check" /> : index + 1}</span>
              <span className="check-text"><strong>{title}{active && <span className="visually-hidden">: {passed ? 'ready' : 'waiting'}</span>}</strong><small>{hint}</small></span>
            </li>;
          })}</ol>}
          {active && captureStage === 'positioning' && view.setup.progress > 0 && <div className="progress-track" aria-hidden="true"><div className="progress-fill" style={{ width: `${view.setup.progress * 100}%` }} /></div>}
          <p className="setup-hint" role="status">{notice || setupMessage}</p>
          {active && !stageActive && <div className="setup-actions">
            <button className="button button-primary" onClick={startRep}>{reference ? 'Capture another rep' : 'Capture one rep'}</button>
            {result && <button className="button button-link" onClick={() => reviewTitle.current?.focus()}>Review rep</button>}
          </div>}
          <PracticeGuide live={view.live} reference={reference} guideRef={guide} />
        </aside>
      </div>
      {result && <RepResult key={result.id} result={result} titleRef={reviewTitle} onClear={() => {
        setResult(null);
        setNotice('Result cleared.');
        guide.current?.querySelector('summary')?.focus();
      }} />}
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

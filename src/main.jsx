import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SquatTracker } from './squat-tracker.js';
import { createDemo, drawPose } from './demo.js';
import { captureImage, downloadEvidence, FORM_GUIDE, framePose, makeEvidence, PHASE_LABELS } from './evidence.js';
import './styles.css';

const DEFAULT_SETUP = { ready: false, checks: {}, message: 'Start the camera to check your position.', progress: 0 };
const CHECKS = [
  ['inFrame', 'Full body in frame', 'Leave space above your head and below your feet.'],
  ['sideOn', 'Side view', 'Face left or right. Keep the laptop still.'],
  ['standing', 'Start tall', 'Stand comfortably with both feet on the floor.'],
  ['steady', 'Hold still', 'Stay in that position for about two seconds.'],
];
const PHASE = { setup: 'Positioning', ready: 'Ready', descending: 'Lowering', bottom: 'Bottom', ascending: 'Rising' };
const COUNTDOWN_SECONDS = 5;
const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
const deg = (n) => `${Math.round(n)}°`;
const velocity = (n) => `${n.toFixed(2)}`;
const shown = (format, value) => Number.isFinite(value) ? format(value) : '—';

function CameraIcon({ size = 25 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.7" y="5.4" width="13.5" height="13.2" rx="3"/><path d="m16.2 10 4.8-2.7v9.4L16.2 14"/></svg>;
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

function PracticeGuide({ live, reference }) {
  const [example, setExample] = useState('auto');
  const proportions = live ?? reference;
  const ratio = Math.min(1.65, Math.max(0.70, proportions?.standingThighToShinRatio ?? 1.1));
  const thighFraction = ratio / (1 + ratio);
  // Illustrate the thigh stopping above horizontal, scaled to the projected leg proportions.
  const moderateBend = 22 + Math.acos(Math.min(1, 0.20 / thighFraction)) * 180 / Math.PI;
  const exampleBend = example === 'short' ? moderateBend - 26 : example === 'long' ? moderateBend + 8 : reference?.kneeExcursionDeg ?? moderateBend;
  const depth = Math.min(1, Math.max(0.38, exampleBend / 98));
  return <details className="practice-guide">
    <summary>See a side-view squat example</summary>
    <div className="practice-guide-body">
      <svg className="form-example" viewBox="0 0 260 114" role="img" aria-label="Side view illustration: standing, lowering with bent knees and hips, then standing again">
        <path d="M13 88H247" stroke="#4e6965" strokeWidth="1.5" />
        <g fill="none" stroke="#b7f5cf" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          {figurePaths(48, 0, proportions)}{figurePaths(130, depth, proportions)}{figurePaths(208, 0, proportions)}
        </g>
        <g fill="#b9c9c8" fontSize="11" fontFamily="system-ui" textAnchor="middle"><text x="48" y="107">Stand</text><text x="130" y="107">Lower</text><text x="208" y="107">Stand</text></g>
      </svg>
      <label className="example-control">Example range <select value={example} onChange={(event) => setExample(event.target.value)}><option value="auto">{reference ? 'Use first rep as a guide' : 'Moderate'}</option><option value="short">Shallower</option><option value="long">Deeper</option></select></label>
      <ul>{FORM_GUIDE.map((tip) => <li key={tip}>{tip}</li>)}</ul>
      <p>{proportions?.standingThighToShinRatio ? 'The illustration uses your estimated thigh, shin and torso proportions.' : 'Once you stand in view, the illustration can use your estimated body proportions.'} The example shows a movement pattern. Use a depth that feels comfortable for you.</p>
    </div>
  </details>;
}

function RepResult({ result, reference, onClear }) {
  const m = result?.metrics;
  const values = m && [
    ['Lowering', s, m.descentMs, 'Descent duration'], ['Rising', s, m.ascentMs, 'Ascent duration'],
    ['Down speed', velocity, m.averageDescentLegLengthsPerSec, 'Leg lengths per second'], ['Up speed', velocity, m.averageAscentLegLengthsPerSec, 'Leg lengths per second'],
    ['Knee bend', deg, m.kneeExcursionDeg, reference?.establishedByThisRep === false ? `First rep: ${deg(reference.kneeExcursionDeg)}` : 'Change from standing'],
    ['Torso lean', deg, m.torsoLeanAtBottomDeg, 'From vertical at the bottom'], ['Return difference', deg, m.returnAngleErrorDeg, 'Compared with your start'],
    ['Tracking', (v) => `${Math.round(v * 100)}%`, m.validFrameFraction, 'Usable pose samples'],
  ];
  return <section className="result-panel" aria-labelledby="result-title">
    <div className="result-header">
      <div><p className="eyebrow">REVIEW</p><h2 id="result-title">{m ? 'Rep captured' : 'Your rep review'}</h2></div>
      {m && <div className="result-actions"><button className="button button-secondary" onClick={onClear}>Clear result</button><button className="button button-primary" onClick={() => downloadEvidence(result)}>Download rep data</button></div>}
    </div>
    {!m ? <p className="result-empty">After a tracked rep, your snapshots and measurements will appear here.</p> : <>
      <div className="result-cue"><strong>{result.source === 'simulated' ? 'Simulated rep' : 'Capture summary'}</strong><p>{result.cue.text}</p></div>
      <dl className="metrics-grid">
        {values.map(([label, format, value, note]) => <div className="metric-card" key={label}><dt>{label}</dt><dd>{shown(format, value)}</dd><small>{note}</small></div>)}
      </dl>
      <div className="snapshots-grid" aria-label="Rep snapshots">
        {result.snapshots.map((snapshot, index) => <figure className="snapshot-card" key={snapshot.phase}>
          <img src={snapshot.url} alt={`${result.source === 'simulated' ? 'Illustration' : 'Side camera frame'}: ${PHASE_LABELS[snapshot.phase].toLowerCase()}`} />
          <figcaption><span>{String(index + 1).padStart(2, '0')}</span> {PHASE_LABELS[snapshot.phase]}</figcaption>
        </figure>)}
      </div>
      {result.snapshots.length < 5 && <p className="setup-hint">Some snapshots were unavailable. The export includes the images that were captured.</p>}
      <details className="practice-guide">
        <summary>More movement measurements</summary>
        <div className="practice-guide-body">
          <p>{result.observations.map((item) => item.message).join(' ')}</p>
          <p>At the bottom: {shown(deg, m.kneeAngleAtBottomDeg)} knee angle, {shown(deg, m.shinLeanAtBottomDeg)} shin lean{Number.isFinite(m.hipAngleAtBottomDeg) ? `, ${deg(m.hipAngleAtBottomDeg)} hip angle` : ''}. Pause: {shown(s, m.pauseMs)}.</p>
          <p>These estimates come from a single 2D view. This angle cannot assess side-to-side knee alignment, spinal loading, or overall squat safety.</p>
        </div>
      </details>
    </>}
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
  const calibrationAnchor = useRef(null);
  const [mode, setMode] = useState('off');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState({ phase: 'setup', setup: DEFAULT_SETUP, live: null });
  const [cameraSize, setCameraSize] = useState({ width: 960, height: 540 });
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
    calibrationAnchor.current = null;
    setReference(null);
  }

  function resetSetup() {
    clearAttempt();
    clearReference();
    tracker.current.reset();
    setView({ phase: 'setup', setup: DEFAULT_SETUP, live: null });
  }

  function stop(message) {
    const source = recorder.current;
    recorder.current = null;
    source?.handle?.stop();
    resetSetup();
    setMode('off');
    setNotice(message || '');
    const canvas = overlay.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  useEffect(() => {
    const pagehide = () => stop('Camera paused when you left the page.');
    const visibility = () => { if (document.hidden && recorder.current) pagehide(); };
    window.addEventListener('pagehide', pagehide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      recorder.current?.handle?.stop();
      audio.current?.close().catch(() => {});
      window.removeEventListener('pagehide', pagehide);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  function safeCapture(frame, state) {
    try {
      const image = captureImage(frame.video, frame.width, frame.height);
      return image ? { ...image, timestampMs: frame.timestampMs, kneeAngleDeg: state.live?.kneeAngleDeg ?? null, pose: framePose(frame, state.live) } : null;
    } catch {
      return null;
    }
  }

  function onFrame(frame, session) {
    if (session !== recorder.current) return;
    const { timestampMs, width, height } = frame;
    if (session.width !== width || session.height !== height) {
      if (session.width) {
        resetSetup();
        setNotice('The camera frame changed. Start a new capture to reset your baseline.');
      }
      session.width = width;
      session.height = height;
      setCameraSize({ width, height });
    }
    const a = attempt.current;
    const state = tracker.current.update({ ...frame, armed: a?.stage === 'armed' });
    const setupSide = state.setup.checks.inFrame && frame.landmarks ? (frame.landmarks[23]?.visibility >= frame.landmarks[24]?.visibility ? 'left' : 'right') : null;
    if (overlay.current) drawPose(overlay.current, frame, state.live?.side ?? setupSide);
    setView(state);
    const profile = currentReference.current;
    const anchor = calibrationAnchor.current;
    if (profile && state.setup.ready && state.live?.side) {
      const i = state.live.side === 'right' ? 28 : 27;
      const p = frame.landmarks?.[i];
      const moved = anchor && p && Math.hypot((p.x - anchor.x) * width, (p.y - anchor.y) * height) > height * 0.13;
      if (profile.trackingSide !== state.live.side || moved) {
        resetSetup();
        setNotice('Your side or position changed. Start a new capture to reset your baseline.');
        return;
      }
    }
    if (!a) return;
    if (a.stage === 'positioning') {
      a.positioningStartedAt ??= timestampMs;
      if (timestampMs - a.positioningStartedAt > 45000) {
        clearAttempt('Setup timed out. Start again when you’re ready.');
      } else if (state.setup.ready && state.phase === 'ready') {
        a.stage = 'countdown';
        a.countStartedAt = timestampMs;
        setCountdown(COUNTDOWN_SECONDS);
        setCaptureStage('countdown');
      }
      return;
    }
    if (a.stage === 'countdown') {
      if (!state.setup.ready || state.phase !== 'ready') {
        a.stage = 'positioning';
        setCountdown(0);
        setCaptureStage('positioning');
        return;
      }
      const remaining = Math.max(0, Math.ceil(COUNTDOWN_SECONDS - (timestampMs - a.countStartedAt) / 1000));
      setCountdown(remaining);
      if (remaining) return;
      a.stage = 'armed';
      a.armedAt = timestampMs;
      a.capturedAt = new Date().toISOString();
      const initialImage = safeCapture(frame, state);
      if (initialImage) a.images.set('start', initialImage);
      const ankle = frame.landmarks?.[state.live?.side === 'right' ? 28 : 27];
      a.anchor = ankle ? { x: ankle.x, y: ankle.y } : null;
      setCaptureStage('armed');
      setShowGo(true);
      signalGo();
      session.handle?.perform?.();
      return;
    }
    if (timestampMs - a.armedAt >= 1000) setShowGo(false);
    if (timestampMs - a.armedAt > 20000) {
      tracker.current.reset();
      clearAttempt('No complete rep was detected in time. Stand tall and try again.');
      return;
    }
    if (state.phase === 'setup' && !state.events.length && timestampMs - a.armedAt > 800) {
      clearAttempt('Your pose left the setup area. Check the framing and try again.');
      return;
    }
    for (const event of state.events) {
      if (event.type === 'capture') {
        if (event.phase === 'start' && a.images.has('start')) continue;
        const image = safeCapture(frame, state);
        if (image) a.images.set(event.phase, image);
      }
      if (event.type === 'rep-discarded') {
        clearAttempt('The full rep could not be tracked. Stand side-on with your feet and knees visible, then try again.');
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
          calibrationAnchor.current = a.anchor;
          setReference(next);
        }
        setResult(makeEvidence({ rep, images: a.images, captureStartMs: a.armedAt, source: session.kind === 'demo' ? 'simulated' : 'webcam', camera: { width, height }, capturedAt: a.capturedAt, reference: { ...currentReference.current, establishedByThisRep: firstRep } }));
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
    attempt.current = { stage: 'positioning', images: new Map() };
    setCaptureStage('positioning');
  }

  const stepTitle = !active ? 'Set up your camera' : captureStage === 'positioning' ? 'Step into position' : captureStage === 'countdown' ? 'Get ready' : captureStage === 'armed' ? 'Perform one squat' : reference ? 'Ready for another rep?' : 'Capture one squat';
  const cameraLabel = mode === 'loading' ? 'Starting camera' : mode === 'off' ? 'Camera off' : !view.setup.checks.inFrame ? 'Looking for pose' : stageActive ? 'Tracking' : view.setup.ready ? 'In position' : 'Adjust position';

  return <div className="app-shell">
    <header className="app-header">
      <div className="wordmark"><span className="brand-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 11h3l2.5-6 3.5 9 2-4h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg></span> COMPOSE</div>
      <span className="header-title">Camera studio</span><span className="privacy-badge">Video stays on this device</span>
    </header>
    <main className="main">
      <div className="page-intro"><p className="eyebrow">MOVEMENT LAB / 01</p><h1>Squat camera<span aria-hidden="true">.</span></h1><p className="intro-copy">Step into a side view and capture one bodyweight squat, hands-free.</p></div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="studio-grid">
        <section className="camera-panel" aria-label="Camera preview">
          <div className="panel-heading"><h2 className="panel-title">Camera preview</h2><span className="camera-status" data-tone={active && view.live ? 'ready' : mode === 'loading' ? 'pending' : 'off'}>{cameraLabel}</span></div>
          <div className="viewport" style={{ aspectRatio: `${cameraSize.width} / ${cameraSize.height}` }}>
            <video ref={cameraVideo} className="camera-video" hidden={mode !== 'camera'} muted playsInline aria-label="Live side view" />
            <canvas ref={demoVideo} className="demo-video" hidden={mode !== 'demo'} aria-label="Simulated side view" />
            <canvas ref={overlay} className="pose-overlay" hidden={!active} aria-hidden="true" />
            {!active && <div className="empty-camera"><span className="empty-camera-icon"><CameraIcon /></span><strong>{mode === 'loading' ? 'Starting pose tracking' : 'Your camera is off'}</strong><p>{mode === 'loading' ? 'Allow camera access if your browser asks.' : 'Start the camera to see your position.'}</p></div>}
            {active && captureStage !== 'armed' && !view.setup.ready && <div className="frame-guide" aria-hidden="true"><span className="frame-guide-label">FIT YOUR FULL BODY</span></div>}
            {active && <div className="phase-pill">{captureStage === 'armed' && view.phase === 'ready' ? 'Perform one squat' : (PHASE[view.phase] || 'Positioning')}</div>}
            {mode === 'demo' && <div className="demo-tag">Simulated example</div>}
            {countdown > 0 && <div className="countdown" aria-label={`Recording in ${countdown} seconds`}>{countdown}</div>}
            {showGo && <div className="countdown" aria-hidden="true">Go</div>}
          </div>
          <div className="camera-controls">
            {active || mode === 'loading' ? <button className="button button-stop" onClick={() => stop(mode === 'demo' ? 'Example stopped.' : 'Camera stopped.')}>{mode === 'demo' ? 'Stop example' : 'Stop camera'}</button> : <>
              <button className="button button-primary" onClick={startCamera}><CameraIcon size={19}/> Start camera</button>
              <button className="button button-secondary" onClick={startDemo}>Try simulated example</button>
            </>}
            {stageActive && <button className="button button-secondary" onClick={() => { clearAttempt('Rep capture cancelled.'); tracker.current.reset(); }}>Cancel rep</button>}
            {active && !stageActive && <button className="button button-secondary" onClick={() => { resetSetup(); setNotice('Camera setup reset.'); }}>Redo setup</button>}
            {active && <button className="button button-secondary" aria-pressed={soundEnabled} onClick={() => {
              playSound.current = !playSound.current;
              setSoundEnabled(playSound.current);
              enableAudio();
            }}>Go sound: {soundEnabled ? 'on' : 'off'}</button>}
          </div>
        </section>
        <aside className="setup-panel" aria-labelledby="setup-title">
          <div className="panel-heading"><span className="panel-title">Capture setup</span></div>
          <p className="step-kicker">{captureStage === 'armed' ? '02 / RECORD' : '01 / POSITION'}</p><h2 id="setup-title">{stepTitle}</h2>
          <p className="step-copy">{captureStage === 'armed' ? 'Start tall, then lower and stand back up once at a comfortable pace.' : 'Set the laptop on a stable surface and turn so the camera sees you from the side.'}</p>
          {captureStage !== 'armed' && <ul className="checklist" aria-label="Camera setup checklist">{CHECKS.map(([key, title, hint]) => {
            const passed = Boolean(view.setup.checks[key]);
            return <li className="check-item" key={key} data-passed={passed}><span className="check-icon" aria-hidden="true">{passed ? '✓' : '·'}</span><span className="check-text"><strong>{title}<span className="visually-hidden">: {passed ? 'ready' : 'waiting'}</span></strong><small>{hint}</small></span></li>;
          })}</ul>}
          {active && captureStage !== 'armed' && <div className="progress-track" aria-hidden="true"><div className="progress-fill" style={{ width: `${view.setup.progress * 100}%` }} /></div>}
          <p className="setup-hint" aria-live="polite">{notice || (captureStage === 'countdown' ? 'Hold your starting stance until the countdown finishes.' : captureStage === 'armed' ? (view.live ? 'Lower and stand again. Hold your start position briefly when you finish.' : 'Finding your pose again…') : active ? view.setup.message : 'The countdown starts when you’re in position. Your first full rep becomes your baseline.')}</p>
          {active && !stageActive && <div className="setup-actions"><button className="button button-primary" onClick={startRep}>{reference ? 'Capture another rep' : 'Capture one rep'}</button><small>Step into frame. The countdown starts when you’re in position.</small></div>}
          <PracticeGuide live={view.live} reference={reference} />
        </aside>
      </div>
      <RepResult result={result} reference={result?.reference} onClear={() => setResult(null)} />
    </main>
    <footer className="app-footer"><span>COMPOSE / CAMERA STUDIO</span><span>Bodyweight squat · Side view</span></footer>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

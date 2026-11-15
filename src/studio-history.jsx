import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { EXERCISE_TRACKS } from './level-progression.js';
import { getLocalAttempt } from './local-attempts.js';
import { attemptOutcome, mergeAttemptReps } from './attempt-review.js';
import { summarizeSet } from './set-feedback.js';
import { SetFeedback } from './set-feedback.jsx';
import { CoachingAudioControl } from './form-feedback.jsx';
import { createRepCoach } from './rep-coach.js';
import { exerciseProgress, progressCoordinates } from './exercise-progress.js';
import { MusicNote } from './music/music-note.jsx';
import './studio-history.css';

const tones = { squat: 'coral', 'knee-raise': 'sky', 'push-up': 'gold', 'heel-raise': 'sage' };
const scoreLabel = (score) => Number.isFinite(score) ? Math.round(score) : '—';
const dateLabel = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const progressScore = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
const shortDate = (time) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(time));
function HistoryIcon({ name, size = 20 }) {
  if (name === 'note') return <MusicNote size={size} />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'close' ? <path d="m6 6 12 12M6 18 18 6" /> : name === 'arrow' ? <path d="M4 12h15m-6-6 6 6-6 6" /> : name === 'download' ? <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /> : <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2" /></>}
  </svg>;
}

function ExerciseProgress({ attempts, onViewAttempt, onBackToMusic }) {
  const [exercise, setExercise] = useState(() => EXERCISE_TRACKS.find(({ id }) => exerciseProgress(attempts, id).points.length)?.id ?? 'squat');
  const [variant, setVariant] = useState(() => exerciseProgress(attempts, 'squat').points.at(-1)?.attempt.variant ?? 'bodyweight');
  const [selectedId, setSelectedId] = useState(null);
  const [chartWidth, setChartWidth] = useState(760);
  const chartRef = useRef(null);
  const chartId = useId();
  const track = EXERCISE_TRACKS.find(({ id }) => id === exercise);
  const progress = exerciseProgress(attempts, exercise, exercise === 'squat' ? variant : undefined);
  const hasPoints = progress.points.length > 0;
  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const measure = () => {
      const width = chart.getBoundingClientRect().width;
      if (width > 0) setChartWidth(Math.round(width));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(chart);
    return () => observer.disconnect();
  }, [hasPoints]);
  const points = progressCoordinates(progress.points, { width: chartWidth });
  const selected = points.find(({ attempt }) => attempt.id === selectedId) ?? points.at(-1);
  const line = points.map(({ x, y }) => `${x},${y}`).join(' ');
  const change = progress.change;
  function pointKey(event, index) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onViewAttempt(points[index].attempt); return; }
    const next = event.key === 'ArrowRight' ? Math.min(points.length - 1, index + 1)
      : event.key === 'ArrowLeft' ? Math.max(0, index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      setSelectedId(points[next].attempt.id);
      event.currentTarget.parentNode.querySelector(`[data-progress-index="${next}"]`)?.focus();
    }
  }
  return <section className={`exercise-progress tone-${tones[exercise]}`} aria-labelledby={`${chartId}-heading`}>
    <div className="progress-heading"><div><h2 id={`${chartId}-heading`}>Your progress</h2><p>See what changes with every workout.</p></div>
      <div className="progress-selectors"><label>Exercise<select value={exercise} onChange={(event) => { setExercise(event.target.value); setSelectedId(null); }}>{EXERCISE_TRACKS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select></label>
        {exercise === 'squat' && <label>Type<select value={variant} onChange={(event) => { setVariant(event.target.value); setSelectedId(null); }}><option value="bodyweight">Bodyweight</option><option value="barbell">Barbell</option></select></label>}</div>
    </div>
    {points.length ? <>
      <dl className="progress-metrics"><div><dt>Latest score</dt><dd>{progressScore(progress.latest)}<small>/ 100</small></dd></div>
        <div><dt>{attempts.length >= 100 ? 'Best in this history' : 'Best score'}</dt><dd>{progressScore(progress.best)}<small>/ 100</small></dd></div>
        <div><dt>{attempts.length >= 100 ? 'Change in this history' : 'Since first workout'}</dt><dd className={change > 0 ? 'progress-improved' : ''}>{change === null ? '—' : `${change > 0 ? '+' : ''}${progressScore(change)}`}<small>{change === null ? 'One workout so far' : 'points'}</small></dd></div></dl>
      <div className="progress-chart-wrap" ref={chartRef}><svg className="progress-chart" viewBox={`0 0 ${chartWidth} 232`} role="group" aria-labelledby={`${chartId}-title ${chartId}-description`}>
        <title id={`${chartId}-title`}>{track.name} scores over time</title><desc id={`${chartId}-description`}>Form scores from 0 to 100. Use the left and right arrow keys to choose a workout, then Enter to open its review.</desc>
        {[0, 25, 50, 75, 100].map((value) => <g key={value} className="progress-grid"><line x1="42" x2={chartWidth - 22} y1={200 - value * 1.78} y2={200 - value * 1.78} /><text x="29" y={204 - value * 1.78} textAnchor="end">{value}</text></g>)}
        {points.length > 1 && <><polygon className="progress-area" points={`${points[0].x},200 ${line} ${points.at(-1).x},200`} /><polyline className="progress-line" points={line} /></>}
        {points.map((point, index) => <g key={point.attempt.id} className="progress-point" data-progress-index={index} data-selected={point.attempt.id === selected.attempt.id} role="button" tabIndex={point.attempt.id === selected.attempt.id ? 0 : -1}
          aria-label={`${dateLabel(point.time)}: ${progressScore(point.score)} out of 100${point.personalBest ? ', personal best' : ''}. Open workout review.`}
          onFocus={() => setSelectedId(point.attempt.id)} onPointerEnter={() => setSelectedId(point.attempt.id)} onClick={() => onViewAttempt(point.attempt)} onKeyDown={(event) => pointKey(event, index)}>
          <circle className="progress-point-hit" cx={point.x} cy={point.y} r="13" /><circle className="progress-point-dot" cx={point.x} cy={point.y} r="5" /><title>{shortDate(point.time)} · {progressScore(point.score)} / 100</title></g>)}
        {points.length === 1 ? <text className="progress-date" x={points[0].x} y="224" textAnchor="middle">{shortDate(points[0].time)}</text> : <><text className="progress-date" x="42" y="224">{shortDate(points[0].time)}</text><text className="progress-date" x={chartWidth - 22} y="224" textAnchor="end">{shortDate(points.at(-1).time)}</text></>}
      </svg></div>
      <div className="progress-selected"><div aria-live="polite"><strong>{progressScore(selected.score)}<small> / 100</small></strong><span>{dateLabel(selected.time)}{selected.personalBest ? ' · Personal best' : ''}</span></div><button className="plain-button" onClick={() => onViewAttempt(selected.attempt)}>Review workout <HistoryIcon name="arrow" size={17} /></button></div>
      {points.length === 1 && <p className="progress-first">Your starting point is saved. Complete another {track.name.toLowerCase()} workout to see your trend.</p>}
    </> : <div className="progress-empty"><HistoryIcon name="history" size={26} /><h3>A starting point for your {track.name.toLowerCase()}</h3><p>Complete a camera or video workout to see your first score here. Each finished workout adds to your progress.</p><button className="raised-button small" onClick={onBackToMusic}>Find an exercise <HistoryIcon name="arrow" size={16} /></button></div>}
    <p className="progress-footnote">Completed camera and video workouts only. Examples and incomplete attempts stay in your history below.{attempts.length >= 100 ? ' Based on your latest 100 saved attempts.' : ''}</p>
  </section>;
}

export function HistoryPanel({ user, attempts, onSignIn, onBackToMusic, onViewAttempt }) {
  const [exercise, setExercise] = useState('all');
  const [outcome, setOutcome] = useState('all');
  useEffect(() => { setExercise('all'); setOutcome('all'); }, [user?.id]);
  const shown = attempts.filter((attempt) => (exercise === 'all' || attempt.exerciseId === exercise)
    && (outcome === 'all' || attemptOutcome(attempt).filter === outcome));
  function clearFilters() { setExercise('all'); setOutcome('all'); }
  return <section className="history-panel practice-library" aria-label="Saved attempts">
    {user && <ExerciseProgress key={user.id} attempts={attempts} onViewAttempt={onViewAttempt} onBackToMusic={onBackToMusic} />}
    <div className="history-heading"><div><h2>Practice history</h2><p>Every attempt is a step forward.</p></div><span aria-live="polite">{shown.length}{shown.length !== attempts.length ? ` of ${attempts.length}` : ''} {attempts.length === 1 ? 'attempt' : 'attempts'}</span></div>
    {user && attempts.length > 0 && <div className="history-filters">
      <label>Exercise<select value={exercise} onChange={(event) => setExercise(event.target.value)}><option value="all">All exercises</option>{EXERCISE_TRACKS.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select></label>
      <label>Result<select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="all">All results</option><option value="unlocked">Notes unlocked</option><option value="practice">Practice</option><option value="active">In progress</option><option value="error">Review incomplete</option></select></label>
      {(exercise !== 'all' || outcome !== 'all') && <button className="plain-button clear-history-filters" onClick={clearFilters}>Clear filters</button>}
    </div>}
    {!user ? <div className="empty-history"><HistoryIcon size={36} /><h3>Keep track of your practice</h3><p>Sign in to save your scores and recordings.</p><button className="raised-button primary" onClick={onSignIn}>Sign in</button></div>
      : !attempts.length ? <div className="empty-history"><HistoryIcon name="note" size={36} /><h3>Your first note starts here</h3><p>Complete an exercise to save your score and coaching.</p><button className="raised-button primary" onClick={onBackToMusic}>Find an exercise</button></div>
        : !shown.length ? <div className="empty-history filtered-empty"><HistoryIcon size={30} /><h3>No matching attempts</h3><p>Try another exercise or clear your filters.</p><button className="raised-button" onClick={clearFilters}>Show all attempts</button></div>
          : <div className="attempt-list">{shown.map((attempt) => {
            const track = EXERCISE_TRACKS.find(({ id }) => id === attempt.exerciseId);
            const result = attemptOutcome(attempt);
            return <button key={attempt.id} className={`attempt-row tone-${tones[attempt.exerciseId]}`} onClick={() => onViewAttempt(attempt)}>
              <span className="attempt-art" aria-hidden="true"><HistoryIcon name="note" size={24} /></span>
              <span className="attempt-description"><strong>{track?.name} <span>· Note {attempt.level}</span></strong><small>{dateLabel(attempt.createdAt)}{attempt.source === 'simulated' ? ' · Example' : ''}</small></span>
              <span className="attempt-score"><strong>{scoreLabel(attempt.score)}</strong><small>form score</small></span>
              <span className="attempt-count">{attempt.repCount} {attempt.repCount === 1 ? 'rep' : 'reps'}</span>
              <span className={`attempt-state ${attempt.passed ? 'passed' : ''}`}>{result.label}</span><HistoryIcon name="arrow" />
            </button>;
          })}</div>}
    <p className="history-footnote">Scores are saved to your account. Recordings stay in this browser on this device.</p>
  </section>;
}

export function AttemptViewer({ user, attempt, onClose, onReadFeedbackStart }) {
  const dialogRef = useRef(null);
  const videoRef = useRef(null), coachRef = useRef(null);
  const [detail, setDetail] = useState(attempt), [local, setLocal] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [audioState, setAudioState] = useState({ status: 'idle' });
  useEffect(() => { const dialog = dialogRef.current; dialog.showModal(); return () => dialog.close(); }, []);
  useEffect(() => {
    let active = true;
    setAudioState({ status: 'idle' });
    const coach = createRepCoach({ onAudioState: (state) => { if (active) setAudioState(state); } });
    coachRef.current = coach;
    return () => {
      active = false;
      coach.dispose();
      if (coachRef.current === coach) coachRef.current = null;
    };
  }, [user.id, attempt.id]);
  useEffect(() => {
    let active = true, url;
    setDetail(attempt); setLocal(null); setVideoUrl(null); setError(''); setLoading(true);
    async function remoteAttempt() {
      const response = await fetch(`/api/attempts/${encodeURIComponent(attempt.id)}`, { credentials: 'same-origin' });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.attempt) throw new Error(data?.error || 'The latest review could not load. Please reopen this attempt to try again.');
      return data.attempt;
    }
    Promise.allSettled([remoteAttempt(), getLocalAttempt(user.id, attempt.id)]).then(([remoteResult, localResult]) => {
      if (!active) return;
      const errors = [];
      if (remoteResult.status === 'fulfilled') setDetail(remoteResult.value);
      else errors.push(remoteResult.reason.message);
      if (localResult.status === 'fulfilled') {
        const saved = localResult.value; setLocal(saved);
        if (saved?.video instanceof Blob && saved.video.size) { url = URL.createObjectURL(saved.video); setVideoUrl(url); }
      } else errors.push('The recording on this device could not load. Your saved scores are still available.');
      setError(errors.join(' '));
    }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [user.id, attempt.id]);
  const track = EXERCISE_TRACKS.find(({ id }) => id === attempt.exerciseId);
  const reps = mergeAttemptReps(local?.reps, detail.reps);
  const result = attemptOutcome(detail);
  const setFeedback = !loading && detail.mode === 'set' && detail.status !== 'active' ? summarizeSet(reps) : null;
  const summaryFeedback = setFeedback?.reviewed ? { score: setFeedback.average, summary: setFeedback.summary, tips: setFeedback.focus.map(({ text }) => text) }
    : !setFeedback && detail.feedback;
  const summaryAudioId = `${attempt.id}:summary`;
  function stopFeedback() { coachRef.current?.setMuted(true); }
  function readFeedback(feedback, repId, repNumber) {
    const coach = coachRef.current;
    if (!coach || !feedback) return;
    videoRef.current?.pause();
    onReadFeedbackStart?.();
    coach.setMuted(true);
    coach.setMuted(false);
    void coach.unlockAudio();
    coach.readFeedback(feedback, { repId, repNumber });
  }
  function resumeFeedback() {
    videoRef.current?.pause();
    onReadFeedbackStart?.();
    void coachRef.current?.resumeAudio();
  }
  function closeViewer() { stopFeedback(); onClose(); }
  function download() {
    if (!videoUrl) return;
    const link = document.createElement('a'); link.href = videoUrl;
    link.download = `motif-${attempt.exerciseId}-note-${attempt.level}.${local.video.type.includes('mp4') ? 'mp4' : 'webm'}`;
    link.click();
  }
  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeViewer();
  }
  return <dialog ref={dialogRef} className="studio-dialog attempt-dialog practice-review" aria-label="Review your attempt" onCancel={closeViewer} onClick={backdropClick}>
    <button className="icon-button dialog-close" aria-label="Close dialog" onClick={closeViewer}><HistoryIcon name="close" /></button>
    <span className="eyebrow">YOUR PRACTICE LIBRARY</span>
    <h2>{track?.name} · Note {attempt.level}</h2><p>{dateLabel(attempt.createdAt)}</p>
    <div className="review-stats"><span><strong>{scoreLabel(detail.score)}</strong> form score</span><span><strong>{detail.repCount}</strong> {detail.repCount === 1 ? 'rep' : 'reps'}</span><span className={detail.passed ? 'success-text' : ''}>{result.label}</span></div>
    {error && <p className="history-review-error" role="alert">{error}</p>}
    {loading ? <p role="status">Opening your attempt…</p> : videoUrl ? <video ref={videoRef} className="saved-video" src={videoUrl} controls playsInline preload="metadata" onPlay={stopFeedback} /> : <div className="no-recording"><HistoryIcon size={28} /><p>No video is stored here for this attempt.</p><small>Your scores and coaching are below. Recordings stay on the device where you practised.</small></div>}
    {videoUrl && <button className="plain-button download-video" onClick={download}><HistoryIcon name="download" /> Download recording</button>}
    {setFeedback ? <SetFeedback feedback={setFeedback} /> : detail.feedback?.summary && <div className="review-coach"><strong>Latest coaching</strong><p>{detail.feedback.summary}</p>{detail.feedback.tips?.length > 0 && <ul>{detail.feedback.tips.map((tip, index) => <li key={index}>{tip}</li>)}</ul>}</div>}
    {!loading && summaryFeedback && <CoachingAudioControl state={audioState.repId === summaryAudioId ? audioState : undefined}
      onRead={() => readFeedback(summaryFeedback, summaryAudioId)} onPlay={resumeFeedback} onStop={stopFeedback} />}
    {reps.length > 0 && <div className="review-reps"><h3>Rep by rep</h3>{reps.map((rep, index) => {
      const feedback = rep.feedback;
      const score = feedback?.score ?? rep.score;
      const pending = ['pending', 'queued', 'reviewing'].includes(rep.reviewStatus);
      const failed = rep.reviewStatus === 'error';
      const repAudioId = rep.id != null ? String(rep.id) : `${attempt.id}:rep:${index}`;
      return <section key={rep.id ?? index}><div className="review-rep-heading"><strong>Rep {rep.repNumber ?? index + 1}</strong><span>{Number.isFinite(score) ? `${scoreLabel(score)} / 100` : pending ? 'Review pending' : failed ? 'Review incomplete' : 'Not scored'}</span></div>
        {feedback?.summary && <p>{feedback.summary}</p>}
        {feedback?.tips?.length > 0 && <ul className="rep-coaching-tips">{feedback.tips.map((tip, tipIndex) => <li key={tipIndex}>{tip}</li>)}</ul>}
        {feedback && <CoachingAudioControl state={audioState.repId === repAudioId ? audioState : undefined}
          onRead={() => readFeedback(feedback, repAudioId, rep.repNumber ?? index + 1)} onPlay={resumeFeedback} onStop={stopFeedback} />}
        {failed && <p className="rep-review-issue">{rep.reviewError || 'This rep could not be reviewed. The attempt has been kept.'}</p>}
        {pending && <p>The review was still in progress when this attempt was opened.</p>}
        {!pending && !failed && !feedback && <p>No coaching was saved for this rep.</p>}
        {!!rep.snapshots?.length && <div className="review-snapshots">{rep.snapshots.map((snapshot, snapshotIndex) => {
          const source = snapshot.url?.startsWith('data:image/') ? snapshot.url : snapshot.imageBase64 ? `data:image/jpeg;base64,${snapshot.imageBase64}` : null;
          return source ? <figure key={`${snapshot.phase}-${snapshotIndex}`}><img src={source} alt={`${snapshot.phase} of rep ${index + 1}`} /><figcaption>{snapshot.phase}</figcaption></figure> : null;
        })}</div>}
      </section>;
    })}</div>}
  </dialog>;
}

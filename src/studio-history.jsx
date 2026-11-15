import React, { useEffect, useRef, useState } from 'react';
import { EXERCISE_TRACKS } from './level-progression.js';
import { getLocalAttempt } from './local-attempts.js';
import { attemptOutcome, mergeAttemptReps } from './attempt-review.js';
import './studio-history.css';

const tones = { squat: 'coral', 'knee-raise': 'sky', 'push-up': 'gold', 'heel-raise': 'sage' };
const scoreLabel = (score) => Number.isFinite(score) ? Math.round(score) : '—';
const dateLabel = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
function HistoryIcon({ name, size = 20 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'close' ? <path d="m6 6 12 12M6 18 18 6" /> : name === 'arrow' ? <path d="M4 12h15m-6-6 6 6-6 6" /> : name === 'download' ? <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /> : name === 'note' ? <><path d="M9 18V5l11-2v13M9 9l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></> : <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2" /></>}
  </svg>;
}

export function HistoryPanel({ user, attempts, onSignIn, onBackToMusic, onViewAttempt }) {
  const [exercise, setExercise] = useState('all');
  const [outcome, setOutcome] = useState('all');
  useEffect(() => { setExercise('all'); setOutcome('all'); }, [user?.id]);
  const shown = attempts.filter((attempt) => (exercise === 'all' || attempt.exerciseId === exercise)
    && (outcome === 'all' || attemptOutcome(attempt).filter === outcome));
  function clearFilters() { setExercise('all'); setOutcome('all'); }
  return <section className="history-panel practice-library" aria-label="Saved attempts">
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

export function AttemptViewer({ user, attempt, onClose }) {
  const dialogRef = useRef(null);
  const [detail, setDetail] = useState(attempt), [local, setLocal] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => { const dialog = dialogRef.current; dialog.showModal(); return () => dialog.close(); }, []);
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
  function download() {
    if (!videoUrl) return;
    const link = document.createElement('a'); link.href = videoUrl;
    link.download = `compose-${attempt.exerciseId}-note-${attempt.level}.${local.video.type.includes('mp4') ? 'mp4' : 'webm'}`;
    link.click();
  }
  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }
  return <dialog ref={dialogRef} className="studio-dialog attempt-dialog practice-review" aria-label="Review your attempt" onCancel={onClose} onClick={backdropClick}>
    <button className="icon-button dialog-close" aria-label="Close dialog" onClick={onClose}><HistoryIcon name="close" /></button>
    <span className="eyebrow">YOUR PRACTICE LIBRARY</span>
    <h2>{track?.name} · Note {attempt.level}</h2><p>{dateLabel(attempt.createdAt)}</p>
    <div className="review-stats"><span><strong>{scoreLabel(detail.score)}</strong> form score</span><span><strong>{detail.repCount}</strong> {detail.repCount === 1 ? 'rep' : 'reps'}</span><span className={detail.passed ? 'success-text' : ''}>{result.label}</span></div>
    {error && <p className="history-review-error" role="alert">{error}</p>}
    {loading ? <p role="status">Opening your attempt…</p> : videoUrl ? <video className="saved-video" src={videoUrl} controls playsInline preload="metadata" /> : <div className="no-recording"><HistoryIcon size={28} /><p>No video is stored here for this attempt.</p><small>Your scores and coaching are below. Recordings stay on the device where you practised.</small></div>}
    {videoUrl && <button className="plain-button download-video" onClick={download}><HistoryIcon name="download" /> Download recording</button>}
    {detail.feedback?.summary && <div className="review-coach"><strong>Latest coaching</strong><p>{detail.feedback.summary}</p>{detail.feedback.tips?.length > 0 && <ul>{detail.feedback.tips.map((tip, index) => <li key={index}>{tip}</li>)}</ul>}</div>}
    {reps.length > 0 && <div className="review-reps"><h3>Rep by rep</h3>{reps.map((rep, index) => {
      const feedback = rep.feedback;
      const score = feedback?.score ?? rep.score;
      const pending = ['pending', 'queued', 'reviewing'].includes(rep.reviewStatus);
      const failed = rep.reviewStatus === 'error';
      return <section key={rep.id ?? index}><div className="review-rep-heading"><strong>Rep {rep.repNumber ?? index + 1}</strong><span>{Number.isFinite(score) ? `${scoreLabel(score)} / 100` : pending ? 'Review pending' : failed ? 'Review incomplete' : 'Not scored'}</span></div>
        {feedback?.summary && <p>{feedback.summary}</p>}
        {feedback?.tips?.length > 0 && <ul className="rep-coaching-tips">{feedback.tips.map((tip, tipIndex) => <li key={tipIndex}>{tip}</li>)}</ul>}
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

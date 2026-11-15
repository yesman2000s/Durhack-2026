import React from 'react';
import { ScoreRing } from './score-ring.jsx';
import { instantRepFeedback } from './instant-feedback.js';
import './feedback-audio.css';

export function InstantRepFeedback({ rep, pending = true }) {
  const feedback = instantRepFeedback(rep);
  return <div className="instant-rep-feedback"><strong>{feedback.title}</strong><p>{feedback.summary}</p>
    {pending && <small>Your form score and coaching are being reviewed.</small>}</div>;
}

export function FormFeedback({ rep, review, onRetry, onPlay, onRead, onStop, audioState }) {
  const feedback = review?.feedback;
  const heading = `form-feedback-${rep.id}`;
  const pending = review?.status === 'queued' || review?.status === 'analyzing';
  return <section className="form-feedback" aria-labelledby={heading}>
    <h3 id={heading}>Form feedback</h3>
    <div role="status">
      {(pending || !review) && <InstantRepFeedback rep={rep} />}
      {review?.error && <p>{review.error}</p>}
      {feedback && <div className="rep-feedback-content">
        <ScoreRing score={feedback.score} />
        <div className="rep-feedback-copy">{feedback.summary && <p>{feedback.summary}</p>}
        {!feedback.summary && feedback.score === null && <p>A clearer view is needed to review this rep.</p>}
        {feedback.tips.length > 0 && <ul>{feedback.tips.map((tip, index) => <li key={index}>{tip}</li>)}</ul>}
        </div>
      </div>}
      {review?.speechError && !audioState && <p>{review.speechError} Your written feedback is still available.</p>}
    </div>
    {feedback && <CoachingAudioControl state={audioState} onPlay={onPlay} onRead={onRead} onStop={onStop} />}
    {review?.status === 'error' && onRetry && <button className="button button-secondary" type="button" onClick={onRetry}>Retry analysis</button>}
  </section>;
}

export function CoachingAudioControl({ state, onPlay, onRead, onStop }) {
  const status = state?.status ?? 'idle';
  const active = status === 'loading' || status === 'playing';
  const blocked = status === 'blocked';
  const failed = status === 'error';
  const play = onPlay ?? onRead;
  const message = status === 'loading' ? 'Preparing spoken feedback…'
    : status === 'playing' ? `Speaking feedback${state.repNumber ? ` for rep ${state.repNumber}` : ''}`
      : blocked ? 'Your feedback is ready to play.'
        : failed ? state.error || 'Feedback audio could not play. Try reading it again.' : '';
  if (!active && !blocked && !failed && !onRead) return null;
  return <div className="feedback-audio" data-status={status}>
    <span className="feedback-audio-status" role="status" aria-live="polite" aria-atomic="true">{message}</span>
    {blocked && <button className="feedback-audio-button" type="button" onClick={play} disabled={!play}>Play coaching audio</button>}
    {active && onStop && <button className="feedback-audio-button" type="button" onClick={onStop} aria-label="Stop spoken feedback">Stop</button>}
    {failed && onRead && <button className="feedback-audio-button" type="button" onClick={onRead}>Retry reading</button>}
    {!active && !blocked && !failed && onRead && <button className="feedback-audio-button" type="button" onClick={onRead}>Read feedback aloud</button>}
  </div>;
}

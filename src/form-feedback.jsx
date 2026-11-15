import React from 'react';

export function FormFeedback({ rep, review, onRetry }) {
  const feedback = review?.feedback;
  const heading = `form-feedback-${rep.id}`;
  const pending = review?.status === 'queued' || review?.status === 'analyzing';
  return <section className="form-feedback" aria-labelledby={heading}>
    <h3 id={heading}>Form feedback</h3>
    <div role="status">
      {pending && <p>{review.status === 'queued' ? 'Rep queued for analysis…' : 'Reviewing your movement and images…'}</p>}
      {!review && <p>Feedback will appear after this rep is analyzed.</p>}
      {review?.error && <p>{review.error}</p>}
      {feedback && <>
        {feedback.summary && <p>{feedback.summary}</p>}
        {feedback.score !== null && <p><strong>{feedback.score} / 100</strong> form score</p>}
        {!feedback.summary && feedback.score === null && <p>A clearer view is needed to review this rep.</p>}
        {feedback.tips.length > 0 && <ul>{feedback.tips.map((tip, index) => <li key={index}>{tip}</li>)}</ul>}
      </>}
      {review?.speechError && <p>{review.speechError} Your written feedback is still available.</p>}
    </div>
    {review?.status === 'error' && onRetry && <button className="button button-secondary" type="button" onClick={onRetry}>Retry analysis</button>}
  </section>;
}

export function CoachingAudioControl({ state, onPlay }) {
  if (state?.status === 'blocked') return <button className="button button-secondary" type="button" onClick={onPlay}>Play coaching audio</button>;
  if (state?.status === 'loading') return <span role="status">Preparing spoken feedback…</span>;
  if (state?.status === 'playing') return <span role="status">Speaking feedback{state.repNumber ? ` for rep ${state.repNumber}` : ''}</span>;
  if (state?.status === 'error') return <span role="status">{state.error}</span>;
  return null;
}

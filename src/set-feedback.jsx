import React from 'react';
import './set-feedback.css';

export function SetFeedback({ feedback }) {
  return <section className="set-feedback" aria-label="Whole-set feedback">
    <h3>Whole-set feedback</h3>
    <p>{feedback.summary}</p>
    {feedback.total > 0 && <small>{feedback.reviewed} of {feedback.total} reps reviewed{feedback.scored < feedback.reviewed ? ` · ${feedback.reviewed - feedback.scored} not scored` : ''}{feedback.reviewed < feedback.total ? ' · Feedback is incomplete' : ''}</small>}
    {feedback.focus.length > 0 && <div className="set-feedback-focus"><h4>For your next set</h4><ul>{feedback.focus.map((tip) => <li key={tip.text}>{tip.text}{tip.count > 1 && <span>Noted in {tip.count} reps</span>}</li>)}</ul></div>}
  </section>;
}

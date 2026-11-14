import React, { useEffect, useRef, useState } from 'react';
import { exportSnapshot } from './evidence.js';

function FeedbackSpeech({ feedback }) {
  const player = useRef(null);
  const [needsPlayback, setNeedsPlayback] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const audio = player.current;
    let audioUrl;

    async function speak() {
      try {
        const response = await fetch('/api/form-speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(feedback),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error ?? 'Feedback audio is unavailable.');
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        audioUrl = URL.createObjectURL(blob);
        audio.src = audioUrl;
        await audio.play();
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error.name === 'NotAllowedError') setNeedsPlayback(true);
        else setError(error.message || 'Feedback audio could not play.');
      }
    }

    speak();
    return () => {
      controller.abort();
      if (audioUrl) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [feedback]);

  return <>
    {error && <p role="status">{error}</p>}
    {needsPlayback && <p>Autoplay is blocked by your browser.</p>}
    <audio ref={player} hidden={!needsPlayback} controls={needsPlayback} aria-label="Spoken form feedback" />
  </>;
}

export function FormFeedback({ rep }) {
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const active = useRef(null);
  useEffect(() => () => active.current?.abort(), []);

  async function analyze() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setFeedback(null);
    setError('');
    try {
      const { exercise, variant, metrics, reference, snapshots } = rep;
      const response = await fetch('/api/form-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          exercise, variant, metrics, reference,
          snapshots: snapshots.map(({ phase, offsetMs, url }) => exportSnapshot({ phase, offsetMs, url })),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        setError(data?.error ?? 'Form scoring is unavailable. Try again later.');
        return;
      }
      setFeedback(data);
    } catch {
      if (!controller.signal.aborted) setError('Could not reach form scoring. Try again.');
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <section className="form-feedback" aria-labelledby="form-feedback-title">
    <h3 id="form-feedback-title">Form feedback</h3>
    {!feedback && <>
      <p>Send this rep’s snapshots and measurements to Gemini for a score and coaching tips.</p>
      <button className="button button-secondary" type="button" onClick={analyze} disabled={loading}>
        {loading ? 'Scoring…' : 'Score this rep'}
      </button>
    </>}
    <div role="status">
      {error && <p>{error}</p>}
      {feedback && <>
        <p>{feedback.score === null ? 'Gemini needs a clearer view to score this rep.' : <>
          <strong>{feedback.score} / 100</strong> practice score
        </>}</p>
        {feedback.tips.length > 0 && <ul>{feedback.tips.map((tip, index) => <li key={index}>{tip}</li>)}</ul>}
      </>}
    </div>
    {feedback && <FeedbackSpeech feedback={feedback} />}
  </section>;
}

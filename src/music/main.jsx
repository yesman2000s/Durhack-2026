import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BARS, BPM, createBeat } from './beat.js';
import { demoProfiles, earnedSegments, exercises } from './progression.js';
import './studio.css';

function Studio() {
  const [profile, setProfile] = useState(demoProfiles[0]);
  const [selected, setSelected] = useState(exercises[0].id);
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [bar, setBar] = useState(1);
  const [muted, setMuted] = useState({});
  const [error, setError] = useState('');
  const context = useRef(null);
  const beat = useRef(null);
  const exercise = exercises.find(({ id }) => id === selected);
  const streak = profile.streaks[selected];
  const earned = earnedSegments(exercise, streak);
  const nextThreshold = exercise.segments[earned]?.[0];

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => setBar(beat.current?.bar() ?? 1), 75);
    return () => clearInterval(timer);
  }, [playing]);

  useEffect(() => () => {
    beat.current?.stop();
    context.current?.close().catch(() => {});
  }, []);

  async function togglePlayback() {
    if (beat.current) {
      beat.current.stop();
      beat.current = null;
      setPlaying(false);
      setBar(1);
      return;
    }

    setStarting(true);
    setError('');
    try {
      context.current ??= new AudioContext();
      await context.current.resume();
      beat.current = createBeat(context.current);
      for (const { id } of exercises) beat.current.mute(id, Boolean(muted[id]));
      beat.current.start(profile.streaks);
      setPlaying(true);
    } catch {
      setError('Audio could not start. Try Play again.');
    } finally {
      setStarting(false);
    }
  }

  function chooseProfile(event) {
    const next = demoProfiles.find(({ id }) => id === event.target.value);
    setProfile(next);
    beat.current?.setStreaks(next.streaks);
  }

  function toggleMute(id) {
    const next = !muted[id];
    setMuted({ ...muted, [id]: next });
    beat.current?.mute(id, next);
  }

  return <div className="studio">
    <header className="studio-nav">
      <a className="wordmark" href="./">COMPOSE<span>.</span></a>
      <a href="./">Squat camera</a>
    </header>
    <main>
      <div className="studio-intro">
        <div>
          <h1>My composition</h1>
          <p>Each exercise adds a part. Longer daily streaks build out that part of the beat.</p>
        </div>
        <label className="profile">Demo profile
          <select value={profile.id} onChange={chooseProfile} disabled={starting}>
            {demoProfiles.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>

      <section className="mixer" aria-labelledby="mixer-title">
        <div className="transport">
          <div><h2 id="mixer-title">Shared beat</h2><p>{BPM} BPM · C major · {BARS}-bar loop</p></div>
          <button type="button" className="play" disabled={starting} onClick={togglePlayback}>
            {starting ? 'Starting…' : playing ? 'Stop' : 'Play'}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="bars" aria-label={'Bar ' + bar + ' of ' + BARS}>
          {Array.from({ length: BARS }, (_, i) => <span key={i} data-active={playing && i + 1 === bar} />)}
        </div>
        <ul className="tracks" aria-label="Exercise tracks">
          {exercises.map((track) => {
            const days = profile.streaks[track.id];
            const count = earnedSegments(track, days);
            return <li key={track.id} style={{ '--track-color': track.color }}>
              <button type="button" className="track-select" aria-pressed={track.id === selected}
                aria-controls="exercise-detail" onClick={() => setSelected(track.id)}>
                <span className="track-dot" aria-hidden="true" />
                <span><strong>{track.name}</strong><small>{track.instrument}</small></span>
                <span className="level" aria-label={count + ' of ' + track.segments.length + ' segments earned'}>
                  {track.segments.map(([threshold]) => <i key={threshold} data-earned={days >= threshold} />)}
                </span>
              </button>
              <button type="button" className="mute" disabled={!count || starting} aria-pressed={Boolean(muted[track.id])}
                aria-label={'Mute ' + track.instrument} onClick={() => toggleMute(track.id)}>
                {muted[track.id] ? 'Muted' : 'Mute'}
              </button>
            </li>;
          })}
        </ul>
      </section>

      <section id="exercise-detail" className="exercise-detail" aria-labelledby="exercise-title"
        style={{ '--track-color': exercise.color }}>
        <div>
          <h2 id="exercise-title">{exercise.name} · {exercise.instrument}</h2>
          <p>{streak} {streak === 1 ? 'day' : 'days'} in a row</p>
        </div>
        <ul className="segments">
          {exercise.segments.map(([threshold, label]) => <li key={label} data-earned={streak >= threshold}>
            <strong>{label}</strong><span>{streak >= threshold ? 'Earned' : 'Day ' + threshold}</span>
          </li>)}
        </ul>
        <p className="next">{nextThreshold ? 'Next segment at day ' + nextThreshold + '.' : 'All segments earned.'}</p>
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<Studio />);

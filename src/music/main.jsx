import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BARS, createBeat, loadStems } from './beat.js';
import { applyExerciseResult, demoStreaks, earnedSegments, exercises } from './progression.js';
import { songs, sourceUrl } from './songs.js';
import './studio.css';

function Studio() {
  const [streaks, setStreaks] = useState(demoStreaks);
  const [resultMessage, setResultMessage] = useState('');
  const [selected, setSelected] = useState(exercises[0].id);
  const [song, setSong] = useState(songs[0]);
  const [testStreak, setTestStreak] = useState(String(demoStreaks[exercises[0].id]));
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [bar, setBar] = useState(1);
  const [muted, setMuted] = useState({});
  const [error, setError] = useState('');
  const context = useRef(null);
  const beat = useRef(null);
  const loadedStems = useRef(new Map());
  const exercise = exercises.find(({ id }) => id === selected);
  const hasStem = song.stems.includes(exercise.stem);
  const streak = streaks[selected];
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

  function stopPlayback() {
    beat.current?.stop();
    beat.current = null;
    setPlaying(false);
    setBar(1);
  }

  async function startPlayback(track) {
    setStarting(true);
    setError('');
    try {
      context.current ??= new AudioContext();
      await context.current.resume();
      if (!loadedStems.current.has(track.id)) {
        loadedStems.current.set(track.id, await loadStems(context.current, track));
      }
      beat.current = createBeat(context.current, track, loadedStems.current.get(track.id));
      for (const { id } of exercises) beat.current.mute(id, Boolean(muted[id]));
      beat.current.start(streaks);
      setPlaying(true);
    } catch {
      stopPlayback();
      setError('The instrument tracks could not load. Try Play again.');
    } finally {
      setStarting(false);
    }
  }

  function chooseSong(event) {
    const next = songs.find(({ id }) => id === event.target.value);
    const resume = Boolean(beat.current);
    stopPlayback();
    setSong(next);
    setError('');
    if (resume) void startPlayback(next);
  }

  function chooseExercise(id) {
    setSelected(id);
    setTestStreak(String(streaks[id]));
    setResultMessage('');
  }

  function receiveDemoResult(success) {
    const result = { exerciseId: selected, success, streak: Number(testStreak) };
    const next = applyExerciseResult(streaks, result);
    setStreaks(next);
    if (next !== streaks) beat.current?.setStreaks(next);
    setResultMessage(success
      ? `${exercise.name}: completed. Streak from response: ${result.streak} days.`
      : `${exercise.name}: exercise was unsuccessful.`);
  }

  function resetStreaks() {
    setStreaks(demoStreaks);
    setTestStreak(String(demoStreaks[selected]));
    setMuted({});
    for (const { id } of exercises) beat.current?.mute(id, false);
    beat.current?.setStreaks(demoStreaks);
    setResultMessage('Demo streaks restored.');
  }

  const validTestStreak = /^\d+$/.test(testStreak) && Number.isSafeInteger(Number(testStreak));

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
        <label className="field">Genre
          <select value={song.id} onChange={chooseSong} disabled={starting}>
            {songs.map((track) => <option key={track.id} value={track.id}>{track.genre}</option>)}
          </select>
        </label>
      </div>

      <section className="mixer" aria-labelledby="mixer-title">
        <div className="transport">
          <div><h2 id="mixer-title">{song.title}</h2><p>{song.bpm} BPM · {BARS}-bar loop</p></div>
          <button type="button" className="play" disabled={starting}
            onClick={() => playing ? stopPlayback() : startPlayback(song)}>
            {starting ? 'Loading…' : playing ? 'Stop' : 'Play'}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="bars" aria-label={'Bar ' + bar + ' of ' + BARS}>
          {Array.from({ length: BARS }, (_, i) => <span key={i} data-active={playing && i + 1 === bar} />)}
        </div>
        <ul className="tracks" aria-label="Exercise tracks">
          {exercises.map((track) => {
            const days = streaks[track.id];
            const count = earnedSegments(track, days);
            return <li key={track.id} style={{ '--track-color': track.color }}>
              <button type="button" className="track-select" aria-pressed={track.id === selected}
                aria-controls="exercise-detail" onClick={() => chooseExercise(track.id)}>
                <span className="track-dot" aria-hidden="true" />
                <span><strong>{track.name}</strong><small>{track.instrument}{song.stems.includes(track.stem) ? '' : ' · unavailable in this song'}</small></span>
                <span className="level" aria-label={count + ' of ' + track.segments.length + ' segments earned'}>
                  {track.segments.map(([threshold]) => <i key={threshold} data-earned={days >= threshold} />)}
                </span>
              </button>
              <button type="button" className="mute" disabled={!count || starting || !song.stems.includes(track.stem)} aria-pressed={Boolean(muted[track.id])}
                aria-label={'Mute ' + track.instrument} onClick={() => toggleMute(track.id)}>
                {muted[track.id] ? 'Muted' : 'Mute'}
              </button>
            </li>;
          })}
        </ul>
        <p className="credits"><a href={sourceUrl(song)}>Kevin MacLeod</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · excerpt split into instrument stems and looped</p>
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
        <p className="next">{!hasStem ? 'This song has no usable ' + exercise.instrument.toLowerCase() + ' stem.' :
          nextThreshold ? 'Next segment at day ' + nextThreshold + '.' : 'All segments earned.'}</p>
        <div className="demo-results" role="group" aria-label="Mock backend results">
          <label className="field">Test streak (days)
            <input type="number" min="0" step="1" value={testStreak} disabled={starting}
              onChange={(event) => setTestStreak(event.target.value)} />
          </label>
          <button type="button" disabled={starting || !validTestStreak} onClick={() => receiveDemoResult(true)}>Mock success</button>
          <button type="button" disabled={starting} onClick={() => receiveDemoResult(false)}>Mock failure</button>
          <button type="button" disabled={starting} onClick={resetStreaks}>Reset demo</button>
        </div>
        <p role="status">{resultMessage}</p>
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<Studio />);

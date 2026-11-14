import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EXCERPT_BEATS, loadStem, playReward, rewardBeats } from './beat.js';
import { applyExerciseResult, demoStreaks, exercises } from './progression.js';
import { songs, sourceUrl } from './songs.js';
import './studio.css';

function Studio() {
  const [streaks, setStreaks] = useState(demoStreaks);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(exercises[0].id);
  const [song, setSong] = useState(songs[0]);
  const [testStreak, setTestStreak] = useState(String(demoStreaks[exercises[0].id]));
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const context = useRef(null);
  const playback = useRef(null);
  const loadedStems = useRef(new Map());

  const exercise = exercises.find(({ id }) => id === selected);
  const hasStem = song.stems.includes(exercise.stem);
  const streak = streaks[selected];
  const beats = rewardBeats(streak);
  const validTestStreak = /^\d+$/.test(testStreak) && Number.isSafeInteger(Number(testStreak));

  useEffect(() => () => {
    playback.current?.();
    context.current?.close().catch(() => {});
  }, []);

  function stopPlayback() {
    const stop = playback.current;
    playback.current = null;
    stop?.();
    setPlaying(false);
  }

  function chooseExercise(id) {
    setSelected(id);
    setTestStreak(String(streaks[id]));
  }

  async function receiveDemoResult(success) {
    setError('');
    if (!success) {
      setMessage(exercise.name + ': exercise was unsuccessful.');
      return;
    }

    const result = { exerciseId: selected, success, streak: Number(testStreak) };
    const next = applyExerciseResult(streaks, result);
    setStreaks(next);
    stopPlayback();
    const length = rewardBeats(next[selected]);
    const completed = exercise.name + ': streak ' + next[selected] + ' days.';
    if (!length || !hasStem) {
      setMessage(completed + (hasStem ? ' No section unlocked yet.' : ' This song has no usable stem for this exercise.'));
      return;
    }

    setLoading(true);
    setMessage(completed);
    try {
      context.current ??= new AudioContext();
      await context.current.resume();
      const key = song.id + '/' + exercise.stem;
      if (!loadedStems.current.has(key)) {
        loadedStems.current.set(key, await loadStem(context.current, song, exercise));
      }
      const stop = playReward(context.current, song, loadedStems.current.get(key), length, () => {
        if (playback.current === stop) {
          playback.current = null;
          setPlaying(false);
          setMessage(completed + ' Reward finished.');
        }
      });
      playback.current = stop;
      setPlaying(true);
      setMessage(completed + ' Playing ' + length + (length === 1 ? ' beat of ' : ' beats of ') + exercise.instrument.toLowerCase() + '.');
    } catch {
      setError('The reward audio could not play. Try Mock success again.');
    } finally {
      setLoading(false);
    }
  }

  function resetStreaks() {
    stopPlayback();
    setStreaks(demoStreaks);
    setTestStreak(String(demoStreaks[selected]));
    setError('');
    setMessage('Demo streaks restored.');
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
          <p>Complete an exercise to hear all the audio you’ve unlocked for its instrument.</p>
        </div>
        <label className="field">Genre
          <select value={song.id} disabled={loading} onChange={(event) => {
            stopPlayback();
            setMessage('');
            setError('');
            setSong(songs.find(({ id }) => id === event.target.value));
          }}>
            {songs.map((track) => <option key={track.id} value={track.id}>{track.genre}</option>)}
          </select>
        </label>
      </div>

      <section className="mixer" aria-labelledby="mixer-title">
        <div className="transport">
          <div><h2 id="mixer-title">{song.title}</h2><p>{song.bpm} BPM</p></div>
          <button type="button" className="play" disabled={!playing} onClick={() => {
            stopPlayback();
            setMessage('Reward stopped.');
          }}>Stop reward</button>
        </div>
        <ul className="tracks" aria-label="Exercise tracks">
          {exercises.map((track) => <li key={track.id} style={{ '--track-color': track.color }}>
            <button type="button" className="track-select" aria-pressed={track.id === selected}
              aria-controls="exercise-detail" disabled={loading} onClick={() => chooseExercise(track.id)}>
              <span className="track-dot" aria-hidden="true" />
              <span><strong>{track.name}</strong><small>{track.instrument}</small></span>
              <small>{song.stems.includes(track.stem) ? rewardBeats(streaks[track.id]) + ' beats unlocked' : 'Unavailable in this song'}</small>
            </button>
          </li>)}
        </ul>
        <p className="credits"><a href={sourceUrl(song)}>Kevin MacLeod</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · excerpt split into instrument stems</p>
      </section>

      <section id="exercise-detail" className="exercise-detail" aria-labelledby="exercise-title">
        <h2 id="exercise-title">{exercise.name} · {exercise.instrument}</h2>
        <p>{streak} {streak === 1 ? 'day' : 'days'} in a row</p>
        {hasStem && <p>{beats} of {EXCERPT_BEATS} beats unlocked · {Number((beats * 60 / song.bpm).toFixed(1))} seconds</p>}
        {hasStem && beats === EXCERPT_BEATS && <p>Full excerpt unlocked. Your streak can keep growing.</p>}
        {!hasStem && <p>This song has no usable {exercise.instrument.toLowerCase()} stem.</p>}
        <div className="demo-results" role="group" aria-label="Mock backend results">
          <label className="field">Test streak (days)
            <input type="number" min="0" step="1" value={testStreak} disabled={loading}
              onChange={(event) => setTestStreak(event.target.value)} />
          </label>
          <button type="button" disabled={loading || !validTestStreak} onClick={() => receiveDemoResult(true)}>
            {loading ? 'Loading…' : 'Mock success'}
          </button>
          <button type="button" disabled={loading} onClick={() => receiveDemoResult(false)}>Mock failure</button>
          <button type="button" disabled={loading} onClick={resetStreaks}>Reset demo</button>
        </div>
        <p role="status">{message}</p>
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<Studio />);

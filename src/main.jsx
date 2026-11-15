import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadStem, playReward, rewardBeats } from './music/beat.js';
import { demoStreaks, exercisePart, exercises, PROGRESSION_KEY, readProgress } from './music/progression.js';
import { songs } from './music/songs.js';
import './home.css';

const NOTES = [1, 2, 3];
const MOVEMENT_DETAILS = {
  squat: { copy: 'Build your beat one rep at a time.', art: 'drums', tone: 'coral' },
  'knee-raise': { copy: 'Keep your rhythm moving.', art: 'bass', tone: 'blue' },
  'push-up': { copy: 'Press into your next note.', art: 'piano', tone: 'gold' },
};
const MOVEMENTS = exercises.map((exercise) => ({ ...exercise, ...MOVEMENT_DETAILS[exercise.id] }));

function Icon({ name }) {
  const paths = {
    music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
    play: <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" /></>,
    stop: <><circle cx="12" cy="12" r="9" /><path d="M9 9h6v6H9z" /></>,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    arrowRight: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function InstrumentArt({ name }) {
  if (name === 'drums') return <svg viewBox="0 0 120 90" aria-hidden="true"><path d="m27 20 24-9m43 9L70 11" /><ellipse cx="22" cy="21" rx="15" ry="5" /><ellipse cx="98" cy="21" rx="15" ry="5" /><path d="M22 22v9m76-9v9" /><ellipse cx="60" cy="37" rx="25" ry="9" /><path d="M35 37v28c0 5 11 9 25 9s25-4 25-9V37" /><ellipse cx="60" cy="65" rx="25" ry="9" /><path d="M47 48v12m26-12v12" /></svg>;
  if (name === 'bass') return <svg viewBox="0 0 120 90" aria-hidden="true"><path d="M79 12 50 42" /><path d="M47 38c-6-4-15-2-17 5-2 5 2 9 0 13-3 5-9 5-8 12 2 11 18 12 25 5 5-6 10-4 15-6 7-3 9-11 5-17L95 20l5 5-8 8" /><path d="m44 45 21 21M80 13l8 8m-39 21 21 21m-24-18 17 17" /><circle cx="47" cy="61" r="2" /><path d="m92 12 8-7m-3 12 9-3" /></svg>;
  return <svg viewBox="0 0 120 90" aria-hidden="true"><path d="M15 29h90v43H15z" /><path d="M15 29h90v15H15z" /><path d="M28 44v28m13-28v28m13-28v28m13-28v28m13-28v28m13-28v28" /><path d="M35 29v15m26-15v15m26-15v15" /></svg>;
}

function HomePage() {
  const [openMovement, setOpenMovement] = useState(null);
  const [streaks, setStreaks] = useState(demoStreaks);
  const [song, setSong] = useState(songs[0]);
  const [playing, setPlaying] = useState(null);
  const [loading, setLoading] = useState(false);
  const [musicNotice, setMusicNotice] = useState('');
  const audioContext = useRef(null);
  const playback = useRef(null);
  const loadedStems = useRef(new Map());
  const progressByMovement = MOVEMENTS.map(({ id }) => Math.min(Math.max(streaks[id], 1), NOTES.length) / NOTES.length);
  const combinedProgress = progressByMovement.reduce((sum, value) => sum + value, 0) / MOVEMENTS.length;
  const tracksAligned = progressByMovement.every((value) => value === progressByMovement[0]);

  useEffect(() => {
    function syncProgress() {
      try {
        setStreaks(readProgress(window.localStorage));
        setMusicNotice('');
      } catch (error) {
        setMusicNotice(error instanceof Error ? error.message : 'Saved music progress could not be read.');
      }
    }

    syncProgress();
    function onStorage(event) {
      if (event.key === PROGRESSION_KEY || event.key === null) syncProgress();
    }
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      playback.current?.();
      audioContext.current?.close().catch(() => {});
    };
  }, []);

  function stopMusic(message = '') {
    const stop = playback.current;
    playback.current = null;
    stop?.();
    setPlaying(null);
    if (message) setMusicNotice(message);
  }

  async function playMusic(exerciseId = null) {
    if (loading) return;
    const selectedExercises = exerciseId
      ? MOVEMENTS.filter(({ id }) => id === exerciseId)
      : MOVEMENTS;
    const parts = selectedExercises.map((exercise) => ({
      part: exercisePart(song, exercise),
      beats: rewardBeats(streaks[exercise.id]),
    })).filter(({ beats }) => beats > 0);

    if (parts.length === 0) {
      setMusicNotice('Complete a movement to unlock its music.');
      return;
    }

    stopMusic();
    setLoading(true);
    setMusicNotice(exerciseId ? 'Loading instrument preview…' : 'Loading your movement mix…');
    const finishedMessage = exerciseId
      ? `${MOVEMENTS.find(({ id }) => id === exerciseId).instrument} preview finished.`
      : 'Your movement mix finished.';
    try {
      if (!window.AudioContext) throw new Error('Audio playback is not supported in this browser.');
      audioContext.current ??= new AudioContext();
      await audioContext.current.resume();
      const playableParts = await Promise.all(parts.map(async ({ part, beats }) => {
        const key = `${song.id}/${part.stem}`;
        if (!loadedStems.current.has(key)) {
          loadedStems.current.set(key, await loadStem(audioContext.current, song, part));
        }
        return { buffer: loadedStems.current.get(key), beats };
      }));

      const stop = playReward(audioContext.current, song, playableParts, () => {
        if (playback.current === stop) {
          playback.current = null;
          setPlaying(null);
          setMusicNotice(finishedMessage);
        }
      });
      playback.current = stop;
      setPlaying(exerciseId ?? 'mix');
      setMusicNotice(exerciseId ? `Playing ${MOVEMENTS.find(({ id }) => id === exerciseId).instrument}.` : 'Playing your unlocked mix.');
    } catch (error) {
      setMusicNotice(error instanceof Error ? `Music could not play: ${error.message}` : 'Music could not play.');
    } finally {
      setLoading(false);
    }
  }

  function changeSong(event) {
    stopMusic();
    setMusicNotice('');
    setSong(songs.find(({ id }) => id === event.target.value));
  }

  return <div className="app-shell home-shell">
    <header className="app-header">
      <div className="wordmark"><span className="brand-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 11h3l2.5-6 3.5 9 2-4h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span> COMPOSE</div>
      <nav className="home-nav" aria-label="Main navigation">
        <a className="home-camera-link" href="/camera.html">Squat camera</a>
      </nav>
    </header>
    <main className="home-main">
      <section className={`music-bar ${tracksAligned ? 'music-bar-aligned' : ''}`} aria-label="Combined movement progress">
        <span className="music-label"><Icon name="music" /> MUSIC</span>
        <span className="music-title">{song.title}</span>
        <label className="music-genre">
          <span className="visually-hidden">Music genre</span>
          <select value={song.id} disabled={loading} onChange={changeSong}>
            {songs.map((track) => <option key={track.id} value={track.id}>{track.genre}</option>)}
          </select>
        </label>
        <button
          className="music-preview-play" type="button" disabled={loading}
          title={playing === 'mix' ? 'Stop combined music' : 'Play combined music'}
          aria-label={playing === 'mix' ? 'Stop combined music' : 'Play combined music'}
          onClick={() => playing === 'mix' ? stopMusic('Music stopped.') : playMusic()}
        >
          <Icon name={playing === 'mix' ? 'stop' : 'play'} />
        </button>
        <div className="music-bar-track" role="progressbar" aria-label="Combined progress across all movements" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(combinedProgress * 100)}>
          <span style={{ width: `${combinedProgress * 100}%` }} />
        </div>
      </section>
      <p className="music-feedback" role="status" aria-live="polite">{musicNotice}</p>
      <section className="movement-list" aria-label="Movement training paths">
        {MOVEMENTS.map((movement, index) => {
          const expanded = openMovement === movement.name;
          const notesId = `notes-${index}`;
          const unlockedNotes = Math.min(Math.max(streaks[movement.id], 1), NOTES.length);
          return <section className={`movement-dropdown movement-${movement.tone}`} data-open={expanded} key={movement.name}>
            <div className="movement-card">
              <button
                type="button" className="movement-toggle" aria-expanded={expanded} aria-controls={notesId}
                onClick={() => setOpenMovement(expanded ? null : movement.name)}
              >
                <span className="movement-art"><InstrumentArt name={movement.art} /></span>
                <span className="movement-info">
                  <span className="movement-name">{movement.name}</span>
                  <span className="movement-note">{movement.copy}</span>
                  <span className="instrument-tag"><Icon name="music" /> {movement.instrument}</span>
                </span>
                <span className="movement-arrow" aria-hidden="true"><Icon name="chevronDown" /></span>
              </button>
              <div className="movement-progress-controls">
                <button
                  className="instrument-preview-play" type="button" disabled={loading}
                  title={playing === movement.id ? `Stop ${movement.instrument} preview` : `Play ${movement.instrument} preview`}
                  aria-label={playing === movement.id ? `Stop ${movement.instrument} preview` : `Play ${movement.instrument} preview`}
                  onClick={() => playing === movement.id ? stopMusic('Instrument preview stopped.') : playMusic(movement.id)}
                >
                  <Icon name={playing === movement.id ? 'stop' : 'play'} />
                </button>
                <div className="movement-progress-info">
                  <span className="movement-progress-label">NOTE {unlockedNotes} OF {NOTES.length} UNLOCKED</span>
                  <span className="movement-progress-track" role="progressbar" aria-label={`${movement.name} notes unlocked`} aria-valuemin={0} aria-valuemax={NOTES.length} aria-valuenow={unlockedNotes}>
                    <span style={{ width: `${unlockedNotes / NOTES.length * 100}%` }} />
                  </span>
                </div>
              </div>
            </div>
            <div className="movement-days" id={notesId} aria-label={`${movement.name} training notes`} hidden={!expanded}>
              {NOTES.map((note) => note <= unlockedNotes
                ? <a className="training-day training-day-open" href={`/camera.html?exercise=${movement.id}`} key={note}>
                    <span className="training-day-number">NOTE {note}</span>
                    <span className="training-day-content"><strong>{movement.name} pattern</strong><small>Start your session</small></span>
                    <span className="training-day-action" aria-hidden="true"><Icon name="arrowRight" /></span>
                  </a>
                : <button className="training-day training-day-locked" type="button" key={note} disabled>
                    <span className="training-day-number">NOTE {note}</span>
                    <span className="training-day-content"><strong>Coming up</strong><small>Complete Note {note - 1} to unlock</small></span>
                    <svg className="training-day-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                  </button>)}
            </div>
          </section>;
        })}
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<HomePage />);

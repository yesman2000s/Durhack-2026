import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EXERCISE_TRACKS, LEVEL_COUNT } from './level-progression.js';
import { songs } from './music/songs.js';
import { partForTrack } from './music/timeline.js';
import { visualSlots, moveClipPositions } from './music/arrangement.js';
import { ArrangementEditor } from './music/arrangement-editor.jsx';
import { useStudioPlayer } from './music/use-studio-player.js';
import { PlayerBar } from './music/player-controls.jsx';
import { HistoryPanel, AttemptViewer } from './studio-history.jsx';
import './studio.css';
import './music/player.css';
import { InstrumentArt } from './music/instrument-art.jsx';
import './music/playful-studio.css';

const LEVELS = Array.from({ length: LEVEL_COUNT }, (_, i) => i + 1);
const TONES = { squat: 'coral', 'knee-raise': 'sky', 'push-up': 'gold', 'heel-raise': 'sage' };
const EMPTY_SETTINGS = { songId: 'hiphop', positions: {}, mutedNotes: [] };
const noteKey = (exerciseId, level) => `${exerciseId}:${level}`;
const scoreLabel = (score) => Number.isFinite(score) ? Math.round(score) : '—';
const soundLabel = (song, exerciseId) => ({ 'drums-low': 'Drums', 'drums-high': 'Percussion', other: 'Melody' }[partForTrack(song, exerciseId).stem] ?? partForTrack(song, exerciseId).name);

function emptyTracks() {
  return EXERCISE_TRACKS.map(({ id }) => ({ exerciseId: id, baseline: null, completedLevels: 0,
    levels: LEVELS.map((level) => ({ level, status: level === 1 ? 'available' : 'locked', score: null, repCount: 0 })),
    target: { level: 1, reps: 1, minScore: 0, scoreToBeat: null } }));
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Could not connect. Please try again.');
  return data;
}

function Icon({ name, size = 20 }) {
  const paths = {
    play: <path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
    pause: <path d="M8 5v14M16 5v14" strokeWidth="4" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
    note: <><path d="M9 18V5l11-2v13M9 9l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    volume: <><path d="m11 5-5 4H3v6h3l5 4Zm4 4a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12" /></>,
    mute: <><path d="m11 5-5 4H3v6h3l5 4Zm5 4 5 6m0-6-5 6" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9Z" />,
    grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Dialog({ children, onClose, label, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className={`studio-dialog ${className}`} aria-label={label} onCancel={onClose} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <button className="icon-button dialog-close" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button>
    {children}
  </dialog>;
}

function AuthDialog({ onClose, onSuccess }) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      const { user } = await api(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(fields)) });
      onSuccess(user);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <Dialog onClose={onClose} label={register ? 'Create your account' : 'Sign in'} className="auth-dialog">
    <span className="auth-emblem"><Icon name="note" size={32} /></span>
    <h2>{register ? 'Create your account' : 'Welcome back'}</h2>
    <p>Save your progress and pick up where you left off.</p>
    <form onSubmit={submit}>
      {register && <label>Your name<input name="name" autoComplete="name" maxLength={60} required placeholder="What should we call you?" /></label>}
      <label>Email<input name="email" type="email" autoComplete="email" maxLength={254} required placeholder="you@example.com" /></label>
      <label>Password<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : 1} maxLength={128} required placeholder={register ? 'At least 8 characters' : 'Your password'} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="raised-button primary auth-submit" disabled={busy}>{busy ? 'One moment…' : register ? 'Create account' : 'Sign in'}<Icon name="arrow" /></button>
    </form>
    <button className="plain-button auth-switch" onClick={() => { setRegister(!register); setError(''); }} disabled={busy}>{register ? 'Already have an account? Sign in' : 'New to Compose? Create an account'}</button>
    <small>Scores are saved to your account. Recordings stay on this device.</small>
  </Dialog>;
}

function NoteDetail({ open, onClose, className, children }) {
  return open ? <Dialog label="Selected note" onClose={onClose} className={`${className} arrangement-note-detail`}>{children}</Dialog> : null;
}

function StudioApp() {
  const [user, setUser] = useState(null), [ready, setReady] = useState(false);
  const [tracks, setTracks] = useState(emptyTracks), [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [selected, setSelected] = useState({ exerciseId: 'squat', level: 1 });
  const [tab, setTab] = useState('studio'), [authOpen, setAuthOpen] = useState(false), [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [attempts, setAttempts] = useState([]), [viewAttempt, setViewAttempt] = useState(null);
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const accountGeneration = useRef(0);
  const accountIdentity = useRef(null);
  const accountVersion = useRef(0), accountBusy = useRef(false), selectionTouched = useRef(false);
  const settingsRevision = useRef(0), settingsPending = useRef(false), pendingWorkout = useRef(null);
  const currentSong = songs.find(({ id }) => id === settings.songId) ?? songs[0];
  const player = useStudioPlayer({ song: currentSong, tracks, mutedNotes: settings.mutedNotes, accountId: user?.id ?? null, onNotice: setNotice, onPrevious: () => skipSong(-1), onNext: () => skipSong(1) });
  const audioState = player.status, previewKey = player.previewKey;
  const stopMusic = player.reset;
  const selectedTrack = tracks.find(({ exerciseId }) => exerciseId === selected.exerciseId) ?? tracks[0];
  const selectedLevel = selectedTrack.levels.find(({ level }) => level === selected.level) ?? selectedTrack.levels[0];
  const selectedInstrument = EXERCISE_TRACKS.find(({ id }) => id === selected.exerciseId) ?? EXERCISE_TRACKS[0];
  const total = tracks.reduce((sum, track) => sum + track.completedLevels, 0);
  const nextTrack = selectedTrack.target ? selectedTrack : tracks.find((track) => track.target);
  const selectedKey = noteKey(selected.exerciseId, selected.level);
  const selectedMuted = settings.mutedNotes.includes(selectedKey);

  async function loadAccount() {
    if (accountBusy.current) return;
    const generation = ++accountGeneration.current;
    const revision = settingsRevision.current;
    setError('');
    try {
      const identity = await api('/api/auth/me');
      if (generation !== accountGeneration.current) return;
      if (accountIdentity.current !== (identity.user?.id ?? null)) {
        accountVersion.current++; selectionTouched.current = false; settingsPending.current = false; setSaving(false);
        accountIdentity.current = identity.user?.id ?? null;
        setViewAttempt(null); setTracks(emptyTracks()); setSettings(EMPTY_SETTINGS); setAttempts([]); stopMusic();
      }
      setUser(identity.user);
      if (identity.user) {
        const [data, history] = await Promise.all([api('/api/progress'), api('/api/attempts')]);
        if (generation !== accountGeneration.current) return;
        setTracks(data.tracks); if (!settingsPending.current && revision === settingsRevision.current) setSettings(data.settings); setAttempts(history.attempts);
        if (!selectionTouched.current) {
          const nextTrack = data.tracks.find((track) => track.target);
          if (nextTrack) setSelected({ exerciseId: nextTrack.exerciseId, level: nextTrack.target.level });
        }
        return data;
      } else { setTracks(emptyTracks()); setAttempts([]); }
    } catch (err) { if (generation === accountGeneration.current) setError(err.message); } finally { if (generation === accountGeneration.current) setReady(true); }
  }
  useEffect(() => {
    void loadAccount();
    const onFocus = () => { void loadAccount(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); accountGeneration.current++; };
  }, []);
  useEffect(() => {
    if (ready && !user && new URLSearchParams(location.search).has('next')) setAuthOpen(true);
  }, [ready, user]);

  async function saveSettings(patch) {
    if (!user) { setAuthOpen(true); return; }
    if (saving) return;
    const version = accountVersion.current;
    settingsRevision.current++;
    settingsPending.current = true;
    const previous = settings, next = { ...settings, ...patch };
    setSettings(next); setSaving(true);
    try { const result = await api('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }); if (version === accountVersion.current) setSettings(result.settings); }
    catch (err) { if (version === accountVersion.current) { setSettings(previous); setError(err.message); } }
    finally { if (version === accountVersion.current) { settingsRevision.current++; settingsPending.current = false; setSaving(false); } }
  }
  function moveNote(exerciseId, level, toSlot) {
    const positions = moveClipPositions(tracks, settings.positions, exerciseId, level, toSlot);
    if (positions !== settings.positions) void saveSettings({ positions });
  }
  async function signedIn(identity) {
    setUser(identity); setAuthOpen(false); const data = await loadAccount();
    const intended = pendingWorkout.current; pendingWorkout.current = null;
    const next = new URLSearchParams(location.search).get('next');
    if (next?.startsWith('/camera.html?') || next === '/camera.html') location.assign(next);
    else if (intended && data) {
      const targetTrack = data.tracks.find((track) => track.exerciseId === intended.exerciseId);
      if (targetTrack?.target) { stopMusic(); location.assign(`/camera.html?exercise=${intended.exerciseId}&level=${targetTrack.target.level}`); }
      else selectNote(intended.exerciseId, LEVEL_COUNT);
    }
  }
  async function signOut() {
    if (accountBusy.current) return;
    accountBusy.current = true; accountVersion.current++;
    try { accountGeneration.current++; await api('/api/auth/logout', { method: 'POST', body: '{}' }); accountGeneration.current++; accountIdentity.current = null; selectionTouched.current = false; setSaving(false); stopMusic(); setViewAttempt(null); setUser(null); setTracks(emptyTracks()); setSettings(EMPTY_SETTINGS); setAttempts([]); setSelected({ exerciseId: 'squat', level: 1 }); }
    catch (err) { setError(err.message); }
    finally { accountBusy.current = false; settingsPending.current = false; setSaving(false); }
  }
  function beginLevel(exerciseId, level) {
    if (!user) { pendingWorkout.current = { exerciseId }; setAuthOpen(true); return; }
    stopMusic(); location.assign(`/camera.html?exercise=${exerciseId}&level=${level}`);
  }
  function startLevel() { beginLevel(selected.exerciseId, selected.level); }
  function continueTraining() { if (nextTrack?.target) beginLevel(nextTrack.exerciseId, nextTrack.target.level); }
  const target = selectedTrack.target;
  const selectedSlot = visualSlots(selectedTrack, settings.positions)[selected.level];
  const selectedSound = soundLabel(currentSong, selected.exerciseId);
  const previewingSelected = audioState === 'playing' && previewKey === selectedKey;
  function selectNote(exerciseId, level) { selectionTouched.current = true; setSelected({ exerciseId, level }); setNoteOpen(true); }
  function chooseSong(id) { if (saving || id === settings.songId) return; if (user) void saveSettings({ songId: id }); else { settingsRevision.current++; setSettings((value) => ({ ...value, songId: id })); } }
  function skipSong(direction) { const index = songs.findIndex((song) => song.id === currentSong.id); chooseSong(songs[(index + direction + songs.length) % songs.length].id); }
  function toggleTrack(exerciseId) {
    const keys = tracks.find((track) => track.exerciseId === exerciseId).levels.filter((level) => level.status === 'completed').map((level) => noteKey(exerciseId, level.level));
    const allMuted = keys.every((key) => settings.mutedNotes.includes(key));
    void saveSettings({ mutedNotes: allMuted ? settings.mutedNotes.filter((key) => !keys.includes(key)) : [...new Set([...settings.mutedNotes, ...keys])] });
  }

  return <div className="compose-studio playful-studio">
    <header className="studio-header"><a className="studio-brand" href="/" aria-label="Compose home"><span><svg width="23" height="23" viewBox="0 0 24 24" fill="none"><path d="M3 14h4l3-8 4 13 3-8 2 3h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span> COMPOSE</a>
      <nav aria-label="Main navigation"><button className={tab === 'studio' ? 'current' : ''} aria-current={tab === 'studio' ? 'page' : undefined} onClick={() => setTab('studio')}><Icon name="note" size={18} /> My studio</button><button className={tab === 'history' ? 'current' : ''} aria-current={tab === 'history' ? 'page' : undefined} onClick={() => setTab('history')}><Icon name="history" size={18} /> My attempts</button></nav>
      <div className="header-account">{user ? <><span className="user-avatar" aria-hidden="true">{user.name?.slice(0, 1).toUpperCase()}</span><span className="user-name">{user.name}</span><button className="plain-button" onClick={signOut}>Sign out</button></> : <button className="raised-button small" onClick={() => setAuthOpen(true)}><Icon name="user" size={17} /> Sign in</button>}</div>
    </header>
    <main className="studio-main">
      {tab === 'studio' ? <section className="journey-intro">
        <div><span className="eyebrow">MOVE A LITTLE. MAKE SOMETHING.</span><h1>Find your rhythm.</h1><p>A rep becomes a note. Your progress becomes a song.</p></div>
        <div className="journey-progress" aria-label={`${total} of 28 notes unlocked`}><Icon name="star" size={30} /><div><strong>{total} <small>/ 28</small></strong><span>notes unlocked</span><progress value={total} max="28" aria-label="Notes unlocked" /></div></div>
      </section> : <div className="studio-intro"><div><h1>Your attempts</h1><p>Your scores, coaching and saved recordings.</p></div></div>}
      {error && <div className="studio-alert" role="alert">{error}<button onClick={loadAccount} className="plain-button">Try again</button></div>}
      {!ready && <p className="loading-account" role="status">Opening your studio…</p>}
      {tab === 'studio' ? <div className="studio-workspace arrangement-workspace">
        <ArrangementEditor song={currentSong} tracks={tracks} positions={settings.positions} mutedNotes={settings.mutedNotes}
          selected={selected} player={player} canEdit={Boolean(user) && !saving} saving={saving}
          onSelect={selectNote} onMove={moveNote} onToggleTrack={toggleTrack} onShortcuts={() => setShortcutsOpen(true)}
          toolbar={<div className="journey-mixbar"><div className="journey-mix-heading"><span className="journey-mix-icon"><Icon name="note" size={24} /></span><div><h2>Your movement mix</h2><p>{currentSong.title} <span>·</span> {currentSong.bpm} BPM</p></div></div><div className="journey-mix-controls"><select aria-label="Music genre" value={currentSong.id} onChange={(event) => chooseSong(event.target.value)} disabled={saving}>{songs.map((song) => <option value={song.id} key={song.id}>{song.genre}</option>)}</select><button className="raised-button primary" disabled={audioState === 'loading' || !player.hasAudio} title={!player.hasAudio ? 'Complete your first rep to unlock a sound' : undefined} onClick={() => previewKey ? player.playMix() : player.toggle()}><Icon name={audioState === 'playing' && !previewKey ? 'pause' : 'play'} size={16} />{audioState === 'loading' ? 'Loading…' : audioState === 'playing' && !previewKey ? 'Pause my mix' : 'Play my mix'}</button></div></div>} />
        {notice && <p className="journey-music-notice" role="status">{notice}</p>}
        <section className={`journey-next tone-${TONES[nextTrack?.exerciseId ?? selected.exerciseId]}`} aria-label="Your next little win">
          <div className="journey-next-art"><InstrumentArt instrument={soundLabel(currentSong, nextTrack?.exerciseId ?? selected.exerciseId)} /><small>{nextTrack ? `NOTE ${String(nextTrack.target.level).padStart(2, '0')}` : 'COMPLETE'}</small></div>
          <div className="journey-next-copy"><span className="eyebrow">YOUR NEXT LITTLE WIN</span><h2>{!nextTrack ? 'A whole soundtrack. Made by you.' : nextTrack.target.level === 1 ? 'One rep. Your first note.' : 'Build on your best.'}</h2>
            <p>{!nextTrack ? 'Every note is yours. Enjoy your mix or revisit your progress.' : nextTrack.target.level === 1 ? `Start with one rep of ${EXERCISE_TRACKS.find((track) => track.id === nextTrack.exerciseId).name.toLowerCase()}. Set your starting score and unlock your first sound.` : `Complete ${nextTrack.target.reps} reps at ${scoreLabel(nextTrack.target.minScore)}+ form${nextTrack.target.scoreToBeat !== null ? `, or earn ${scoreLabel(nextTrack.target.scoreToBeat)}+ on your form` : ''}. Your own progress is the goal.`}</p>
            {nextTrack?.baseline != null && <span className="journey-baseline">Your starting score <strong>{scoreLabel(nextTrack.baseline)}</strong></span>}
          </div><div className="journey-next-action"><button className="raised-button primary" disabled={!ready || (!nextTrack && !player.hasAudio)} onClick={nextTrack ? continueTraining : player.playMix}>{nextTrack ? 'Let’s move' : 'Play my mix'}<Icon name="arrow" size={18} /></button><small>{nextTrack ? 'Camera on. Distractions off.' : 'Your progress. Your soundtrack.'}</small></div>
        </section>
        <div className="journey-footer"><span><Icon name="history" size={17} /> Every attempt is a step forward.</span><button className="plain-button" onClick={() => setTab('history')}>See your attempts <Icon name="arrow" size={16} /></button></div>
        <NoteDetail open={noteOpen} onClose={() => setNoteOpen(false)} className={`note-detail tone-${TONES[selected.exerciseId]}`}>
          <div className="detail-heading"><span className="detail-icon"><Icon name={selectedLevel.status === 'completed' ? 'check' : selectedLevel.status === 'locked' ? 'lock' : 'note'} size={24} /></span><span className="detail-status">{selectedLevel.status === 'completed' ? 'Unlocked' : selectedLevel.status === 'locked' ? 'Locked' : 'Your next note'}</span></div>
          <h2>{selectedInstrument.name}</h2><p className="detail-subtitle">{selectedSound} <span>·</span> Note {String(selected.level).padStart(2, '0')}</p>
          <div className="note-goal">
            {selectedLevel.status === 'completed' ? <><div className="earned-stats"><div><strong>{scoreLabel(selectedLevel.score)}</strong><span>form score</span></div><div><strong>{selectedLevel.repCount}</strong><span>{selectedLevel.repCount === 1 ? 'rep' : 'reps'}</span></div></div><p>{selectedMuted ? 'This note is muted. Include it in your mix to hear it again.' : 'This note is part of your mix.'}</p></> : selectedLevel.status === 'locked' ? <p>Unlock note {selectedTrack.completedLevels + 1} in this track first.</p> : selected.level === 1 ? <><h3>Start with 1 rep</h3><p>Your first reviewed rep sets your starting score and unlocks this sound.</p></> : <><h3>Improve to unlock</h3><div className="goal-option"><strong>{target?.reps} reps</strong><span>at {scoreLabel(target?.minScore)}+ form</span></div>{target?.scoreToBeat != null && <><span className="goal-or">or</span><div className="goal-option"><strong>{target.scoreToBeat}+ form</strong><span>in at least 1 rep</span></div></>}</>}
          </div>
          <div className="note-actions">{selectedLevel.status === 'completed' ? <>
            <button className="raised-button primary" disabled={selectedMuted || audioState === 'loading'} onClick={() => previewKey === selectedKey ? player.toggle() : player.playNote(selected)}><Icon name={previewingSelected ? 'pause' : 'play'} size={17} />{previewingSelected ? 'Pause note' : 'Play note'}</button>
            <button className="mute-control" role="switch" aria-checked={!selectedMuted} aria-label="Include selected note in mix" disabled={saving} onClick={() => saveSettings({ mutedNotes: selectedMuted ? settings.mutedNotes.filter((key) => key !== selectedKey) : [...settings.mutedNotes, selectedKey] })}><span>Include in mix</span><span className="switch-track"><span /></span></button>
            <div className="move-controls"><span>Move clip</span><button aria-label="Move selected note left" disabled={saving || selectedSlot === 0} onClick={() => moveNote(selected.exerciseId, selected.level, selectedSlot - 1)}>←</button><button aria-label="Move selected note right" disabled={saving || selectedSlot === LEVEL_COUNT - 1} onClick={() => moveNote(selected.exerciseId, selected.level, selectedSlot + 1)}>→</button></div><p className="detail-hint">Moving clips keeps the music in order.</p>
          </> : selectedLevel.status === 'locked' ? <button className="raised-button" onClick={() => selectNote(selected.exerciseId, selectedTrack.completedLevels + 1)}>Go to note {selectedTrack.completedLevels + 1}<Icon name="arrow" size={16} /></button> : <><button className="raised-button primary" disabled={!ready} onClick={startLevel}>Start exercise <Icon name="arrow" size={17} /></button><p className="detail-hint">{user ? 'Choose one rep or a full set.' : 'Sign in to save your progress.'}</p></>}</div>
          {selectedTrack.baseline !== null && <div className="baseline-line"><span>Your starting score</span><strong>{scoreLabel(selectedTrack.baseline)}</strong></div>}
        </NoteDetail>
      </div> : <HistoryPanel user={user} attempts={attempts} onSignIn={() => setAuthOpen(true)} onBackToMusic={() => setTab('studio')} onViewAttempt={setViewAttempt} />}
    </main>
    <PlayerBar song={currentSong} player={player} onPrevious={() => skipSong(-1)} onNext={() => skipSong(1)} changingTrack={saving} />
    {authOpen && <AuthDialog onClose={() => { pendingWorkout.current = null; setAuthOpen(false); }} onSuccess={signedIn} />}
    {shortcutsOpen && <Dialog label="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)} className="shortcuts-dialog"><span className="eyebrow">PLAYER CONTROLS</span><h2>Keep your flow</h2><p>Use these while browsing your music.</p><dl><div><dt>Play or pause</dt><dd><kbd>Space</kbd></dd></div><div><dt>Skip back / forward 5 seconds</dt><dd><kbd>←</kbd><kbd>→</kbd></dd></div><div><dt>Mute or unmute</dt><dd><kbd>M</kbd></dd></div></dl><p>Focus a clip’s grip and use the left or right arrow to move it. Player shortcuts stay out of the way while you type or use a control.</p></Dialog>}
    {viewAttempt && user && <AttemptViewer key={`${user.id}:${viewAttempt.id}`} user={user} attempt={viewAttempt} onClose={() => setViewAttempt(null)} />}
  </div>;
}

createRoot(document.getElementById('root')).render(<StudioApp />);

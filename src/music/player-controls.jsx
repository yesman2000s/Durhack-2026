import React from 'react';

export function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function ControlIcon({ name }) {
  const paths = {
    play: <path d="m8 5 12 7-12 7Z" fill="currentColor" stroke="none" />,
    pause: <><path d="M8 5v14M16 5v14" strokeWidth="4" /></>,
    next: <><path d="m5 5 10 7-10 7Z" fill="currentColor" stroke="none" /><path d="M19 5v14" /></>,
    previous: <><path d="m19 5-10 7 10 7Z" fill="currentColor" stroke="none" /><path d="M5 5v14" /></>,
    repeat: <><path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3" /></>,
    volume: <><path d="m11 5-5 4H3v6h3l5 4Zm4 4a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12" /></>,
    mute: <><path d="m11 5-5 4H3v6h3l5 4Zm5 4 5 6m0-6-5 6" /></>,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

// Original geometric covers identify the mixes without using external assets.
export function AlbumCover({ song, small = false }) {
  return <div className={`album-cover album-${song.id}${small ? ' album-small' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 160 160" fill="none">
      <rect width="160" height="160" fill="var(--cover-bg)" />
      {song.id === 'hiphop' ? <>
        <path d="M-15 130 90 25l85 85-90 90Z" fill="var(--cover-accent)" />
        {[48, 39, 30, 21].map((radius) => <circle key={radius} cx="83" cy="78" r={radius} stroke="var(--cover-ink)" strokeWidth="2" />)}
        <circle cx="83" cy="78" r="10" fill="var(--cover-ink)" /><circle cx="83" cy="78" r="2" fill="var(--cover-bg)" />
      </> : song.id === 'electronic' ? <>
        {[0, 1, 2, 3, 4].map((i) => <path key={i} d={`M${-30 + i * 24} 170 66 8l${34 + i * 11} 152`} stroke="var(--cover-ink)" strokeWidth="2" />)}
        <circle cx="104" cy="56" r="28" fill="var(--cover-accent)" />
      </> : <>
        <path d="m-10 118 50-98h30L31 95h42l-36 83H0l30-60Zm85 0 50-98h30l-39 75h42l-36 83H85l30-60Z" fill="var(--cover-ink)" />
        <circle cx="81" cy="81" r="25" fill="var(--cover-accent)" />
      </>}
    </svg>
    {!small && <span className="cover-caption">COMPOSE / {song.genre.toUpperCase()}</span>}
  </div>;
}

export function PlayerBar({ song, player, onPrevious, onNext, changingTrack }) {
  const playing = player.status === 'playing';
  const loading = player.status === 'loading';
  const percentage = player.duration ? Math.min(100, player.elapsed / player.duration * 100) : 0;
  return <footer className="player-bar" aria-label="Music player" data-playing={playing}>
    <div className="player-track"><AlbumCover song={song} small /><div><strong>{song.title}</strong><span>{playing && <b className="playback-meter" aria-hidden="true"><i /><i /><i /></b>}{player.previewKey ? `Note ${player.previewKey.split(':')[1]} preview` : 'Your movement mix'} <i>·</i> {song.genre}</span>{player.previewKey && <button className="return-to-mix" onClick={player.playMix} disabled={loading}>Back to full mix</button>}</div></div>
    <div className="player-transport">
      <div className="transport-buttons">
        <button className="transport-icon" aria-label="Previous track" title="Previous track" disabled={changingTrack} onClick={onPrevious}><ControlIcon name="previous" /></button>
        <button className="transport-play" aria-label={loading ? 'Loading music' : playing ? 'Pause playback' : 'Play music'} aria-keyshortcuts="Space" title={!player.hasAudio ? 'Unlock a sound to start listening' : 'Play / pause (Space)'} disabled={loading || !player.hasAudio} onClick={player.toggle}>{loading ? <span className="player-spinner" /> : <ControlIcon name={playing ? 'pause' : 'play'} />}</button>
        <button className="transport-icon" aria-label="Next track" title="Next track" disabled={changingTrack} onClick={onNext}><ControlIcon name="next" /></button>
        <button className="transport-icon repeat-control" aria-label="Repeat mix" title={player.loop ? 'Turn repeat off' : 'Repeat this mix'} aria-pressed={player.loop} onClick={() => player.setLoop(!player.loop)}><ControlIcon name="repeat" /></button>
      </div>
      <div className="seek-control"><time>{formatTime(player.elapsed)}</time><input type="range" aria-label="Playback position" aria-valuetext={`${formatTime(player.elapsed)} of ${formatTime(player.duration)}`} min="0" max={player.duration || 1} step="any" value={Math.min(player.elapsed, player.duration)} disabled={!player.hasPlayer || loading} onChange={(event) => player.seek(Number(event.target.value))} style={{ '--range-fill': `${percentage}%` }} /><time>{formatTime(player.duration)}</time></div>
    </div>
    <div className="volume-control"><button className="transport-icon" aria-label={player.volume === 0 ? 'Unmute music' : 'Mute music'} aria-keyshortcuts="M" title="Mute / unmute (M)" onClick={player.toggleMute}><ControlIcon name={player.volume === 0 ? 'mute' : 'volume'} /></button><input type="range" aria-label="Music volume" min="0" max="1" step="0.01" value={player.volume} onChange={(event) => player.setVolume(Number(event.target.value))} style={{ '--range-fill': `${player.volume * 100}%` }} /><span>{Math.round(player.volume * 100)}%</span></div>
  </footer>;
}

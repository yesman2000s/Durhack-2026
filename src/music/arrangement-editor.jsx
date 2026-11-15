import React, { useEffect, useRef, useState } from 'react';
import { EXERCISE_TRACKS, LEVEL_COUNT } from '../level-progression.js';
import { BLOCK_BEATS, partForTrack } from './timeline.js';
import { visualSlots, dragSlot } from './arrangement.js';
import { formatTime } from './player-controls.jsx';
import { InstrumentArt } from './instrument-art.jsx';
import './arrangement-editor.css';

const TONES = { squat: 'coral', 'knee-raise': 'sky', 'push-up': 'gold', 'heel-raise': 'sage' };
const levels = Array.from({ length: LEVEL_COUNT }, (_, i) => i + 1);
const keyFor = (id, level) => `${id}:${level}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const soundLabel = (song, id) => ({ 'drums-low': 'Drums', 'drums-high': 'Percussion', other: 'Melody' }[partForTrack(song, id).stem] ?? partForTrack(song, id).name);

function EditorIcon({ name, size = 16 }) {
  const paths = {
    note: <><path d="M9 18V5l11-2v13M9 9l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>,
    lock: <><rect x="6" y="10" width="12" height="10" rx="2" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    play: <path d="m8 5 12 7-12 7Z" fill="currentColor" stroke="none" />,
    volume: <><path d="m11 5-5 4H3v6h3l5 4Zm4 4a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12" /></>,
    mute: <><path d="m11 5-5 4H3v6h3l5 4Zm5 4 5 6m0-6-5 6" /></>,
    grip: <><path d="M6 8h12M6 12h12M6 16h12" /></>,
    minus: <path d="M5 12h14" />,
    plus: <path d="M5 12h14M12 5v14" />,
    follow: <><path d="M12 3v18M4 8l4 4-4 4m16-8-4 4 4 4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Waveform({ bins }) {
  return <svg className="clip-waveform" viewBox="0 0 128 32" preserveAspectRatio="none" aria-hidden="true">{bins.map((amplitude, i) => {
    const height = Math.max(1, amplitude * 30);
    return <rect key={i} x={i * 4 + 1} y={(32 - height) / 2} width="2" height={height} rx="1" fill="currentColor" />;
  })}</svg>;
}

function ClipArt() {
  return <svg className="clip-art" viewBox="0 0 128 32" preserveAspectRatio="none" aria-hidden="true">{[12, 23, 18, 30, 21, 11, 28, 20, 13, 26, 18, 30, 15, 24, 13, 22].map((height, index) => <rect key={index} x={index * 8 + 2} y={(32 - height) / 2} width="4" height={height} rx="2" fill="currentColor" />)}</svg>;
}

function TimelineClip({ track, level, slot, selected, muted, playing, waveform, canEdit, scrollRef, onSelect, onMove, onDragTarget }) {
  const drag = useRef(null), frame = useRef(null), suppressClick = useRef(false);
  const unlocked = level.status === 'completed';
  useEffect(() => () => { cancelAnimationFrame(frame.current); }, []);
  function updateDrag() {
    const current = drag.current;
    if (!current?.moved) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const labelWidth = parseFloat(getComputedStyle(viewport).getPropertyValue('--track-label-width')) || 170;
    const left = bounds.left + labelWidth + 25, right = bounds.right - 25;
    if (current.clientX < left) viewport.scrollLeft -= Math.min(14, (left - current.clientX) * .3);
    else if (current.clientX > right) viewport.scrollLeft += Math.min(14, (current.clientX - right) * .3);
    const delta = current.clientX - current.startX + viewport.scrollLeft - current.startScroll;
    current.delta = clamp(delta, -slot * current.step, (LEVEL_COUNT - 1 - slot) * current.step);
    current.block.style.transform = `translateX(${current.delta}px)`;
    const nextSlot = dragSlot(slot, current.delta, current.step);
    if (nextSlot !== current.target) { current.target = nextSlot; onDragTarget({ exerciseId: track.id, slot: nextSlot }); }
    frame.current = requestAnimationFrame(updateDrag);
  }
  function pointerDown(event) {
    if (!canEdit || !unlocked || event.button !== 0 || drag.current) return;
    // On touch screens, swiping the clip scrolls the timeline; its grip moves it.
    if (event.pointerType === 'touch' && event.currentTarget.classList.contains('clip-select')) return;
    const block = event.currentTarget.closest('.arrangement-clip');
    suppressClick.current = false;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, clientX: event.clientX,
      startScroll: scrollRef.current.scrollLeft, block, step: block.parentElement.clientWidth / LEVEL_COUNT,
      target: slot, delta: 0, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.clientX = event.clientX;
    if (!current.moved && Math.abs(event.clientX - current.startX) > 5) {
      current.moved = true; current.block.dataset.dragging = 'true';
      onDragTarget({ exerciseId: track.id, slot });
      frame.current = requestAnimationFrame(updateDrag);
    }
  }
  function finishDrag(event, cancelled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null; cancelAnimationFrame(frame.current);
    current.block.style.transform = ''; delete current.block.dataset.dragging;
    if (current.moved) {
      suppressClick.current = true; onDragTarget(null);
      const delta = event.clientX - current.startX + scrollRef.current.scrollLeft - current.startScroll;
      if (!cancelled) onMove(dragSlot(slot, delta, current.step));
    }
  }
  const dragEvents = { onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: (event) => finishDrag(event),
    onPointerCancel: (event) => finishDrag(event, true), onLostPointerCapture: (event) => finishDrag(event, true) };
  return <div className={`arrangement-clip ${level.status}`} data-selected={selected} data-muted={muted} data-playing={playing} style={{ gridColumn: slot + 1, gridRow: 1 }}>
    <button className="clip-select" {...dragEvents} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onSelect(); }}
      aria-pressed={selected} aria-label={`${track.name}, note ${level.level}, ${level.status}${muted ? ', muted' : ''}${playing ? ', playing' : ''}`}>
      <span className="clip-title"><span>{String(level.level).padStart(2, '0')}</span>{level.status === 'available' ? <span className="clip-next">NEXT</span> : <EditorIcon name={muted ? 'mute' : playing ? 'volume' : unlocked ? 'check' : 'lock'} size={13} />}</span>
      {unlocked && waveform ? <Waveform bins={waveform} /> : <ClipArt />}
      <span className="clip-caption">{unlocked ? muted ? 'Muted' : playing ? 'Playing' : Number.isFinite(level.score) ? `${Math.round(level.score)} form` : 'Unlocked' : level.status === 'available' ? level.level === 1 ? '1 rep to begin' : 'Your next step' : 'Keep growing'}</span>
    </button>
    {unlocked && <button className="clip-drag" aria-label={`Drag ${track.name} note ${level.level} to rearrange`} title="Drag left or right, or use the arrow keys" disabled={!canEdit} {...dragEvents}
      onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onMove(clamp(slot + (event.key === 'ArrowLeft' ? -1 : 1), 0, LEVEL_COUNT - 1)); } }}><EditorIcon name="grip" size={13} /></button>}
  </div>;
}

export function ArrangementEditor({ song, tracks, positions, mutedNotes, selected, player, canEdit, saving, onSelect, onMove, onToggleTrack, onShortcuts, toolbar }) {
  const scrollRef = useRef(null);
  const [zoom, setZoom] = useState(1), [follow, setFollow] = useState(true), [dragTarget, setDragTarget] = useState(null);
  const secondsPerBlock = BLOCK_BEATS * 60 / song.bpm;
  const fullDuration = LEVEL_COUNT * secondsPerBlock;
  const enabled = tracks.flatMap((track) => track.levels.filter((level) => level.status === 'completed' && !mutedNotes.includes(keyFor(track.exerciseId, level.level))).map((level) => ({ exerciseId: track.exerciseId, level: level.level })));
  const availableDuration = Math.max(0, ...enabled.map((entry) => entry.level)) * secondsPerBlock;
  const position = clamp(player.beat * 60 / song.bpm, 0, availableDuration);
  const fraction = clamp(position / fullDuration, 0, 1);
  function reveal(seconds) {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const label = parseFloat(getComputedStyle(viewport).getPropertyValue('--track-label-width')) || 170;
    const timelineWidth = viewport.scrollWidth - label;
    const x = label + seconds / fullDuration * timelineWidth;
    if (x > viewport.scrollLeft + viewport.clientWidth - 45 || x < viewport.scrollLeft + label + 15) {
      viewport.scrollLeft = Math.max(0, x - label - 40);
    }
  }
  useEffect(() => { if (follow && !dragTarget && player.status === 'playing') reveal(position); }, [position, follow, player.status, zoom, dragTarget]);
  function seek(seconds) { player.seekMix(seconds); reveal(seconds); }
  function showDragTarget(target) { setDragTarget(target); if (target) setFollow(false); }
  const seekProps = { type: 'range', min: 0, max: availableDuration || 1, step: 'any', value: position,
    disabled: !player.hasAudio, onChange: (event) => seek(Number(event.target.value)),
    style: { width: `${availableDuration / fullDuration * 100}%` }, 'aria-valuetext': `${formatTime(position)} of ${formatTime(availableDuration)}` };
  return <section className="arrangement-editor" aria-label="Music arrangement">
    {toolbar}
    <details className="arrangement-options"><summary>Playback tools</summary>
    <div className="arrangement-toolbar"><div><h3>Make it your mix</h3><p>Seek, zoom and follow your music.</p></div><div className="arrangement-tools">
      <button className="follow-playhead" aria-label="Follow playhead" aria-pressed={follow} title="Keep the playing section in view" onClick={() => setFollow(!follow)}><EditorIcon name="follow" /> <span>Follow</span></button>
      <div className="arrangement-zoom" aria-label="Timeline zoom"><button aria-label="Zoom out timeline" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - .25))}><EditorIcon name="minus" /></button><strong>{Math.round(zoom * 100)}%</strong><button aria-label="Zoom in timeline" disabled={zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, value + .25))}><EditorIcon name="plus" /></button></div>
      <button className="fit-timeline" onClick={() => { setZoom(1); scrollRef.current.scrollLeft = 0; }}>Fit</button>
    </div></div>
    <div className="arrangement-overview"><div className="overview-heading"><span>Song overview</span><time>{formatTime(fullDuration)}</time></div><div className="overview-waveform">
      <svg viewBox="0 0 224 36" preserveAspectRatio="none" aria-hidden="true">{levels.map((level) => {
        const parts = enabled.filter((part) => part.level === level);
        const outlines = parts.map((part) => player.waveforms?.[part.exerciseId]?.[level - 1]).filter(Boolean);
        return <g key={level} transform={`translate(${(level - 1) * 32},0)`}><rect x=".5" y="2" width="31" height="32" rx="1" className={parts.length ? 'overview-unlocked' : 'overview-locked'} />{outlines.length ? Array.from({ length: 32 }, (_, i) => {
          const height = Math.max(1, Math.max(...outlines.map((bins) => bins[i] || 0)) * 28);
          return <rect key={i} x={i + .2} y={(36 - height) / 2} width=".6" height={height} fill="currentColor" />;
        }) : <path d="M3 18h26" className="overview-empty" />}</g>;
      })}</svg>
      <input {...seekProps} className="overview-seek" aria-label="Song overview playback position" />
      <div className="overview-position" style={{ transform: `translateX(${fraction * 100}%)` }} aria-hidden="true" />
    </div></div>
    </details>
    <div className="arrangement-scroll" ref={scrollRef} onWheel={() => setFollow(false)}
      onPointerDown={(event) => { if (event.pointerType === 'touch' || event.target === event.currentTarget) setFollow(false); }}>
      <div className="arrangement-canvas" style={{ '--editor-zoom': zoom }}>
        <div className="arrangement-ruler"><div className="ruler-label">INSTRUMENT / MOVEMENT</div><div className="ruler-track">{levels.map((level) => <div className="ruler-mark" key={level}><span>{String((level - 1) * 4 + 1).padStart(2, '0')}</span><small>{formatTime((level - 1) * secondsPerBlock)}</small></div>)}<input {...seekProps} className="ruler-seek" aria-label="Timeline playback position" /></div></div>
        {EXERCISE_TRACKS.map((track, index) => {
          const progress = tracks.find((item) => item.exerciseId === track.id);
          const slots = visualSlots(progress, positions);
          const keys = progress.levels.filter((level) => level.status === 'completed').map((level) => keyFor(track.id, level.level));
          const muted = keys.length > 0 && keys.every((key) => mutedNotes.includes(key));
          return <section key={track.id} className={`arrangement-track tone-${TONES[track.id]}`} aria-label={`${track.name} track`}><div className="arrangement-track-header"><div className="track-heading"><InstrumentArt instrument={soundLabel(song, track.id)} /><div><small>TRACK {String(index + 1).padStart(2, '0')}</small><h3>{soundLabel(song, track.id)}</h3><p>{track.name}</p></div></div><div className="track-actions"><span>{keys.length} / {LEVEL_COUNT} notes</span><button className="track-mute" aria-label={`${muted ? 'Unmute' : 'Mute'} ${soundLabel(song, track.id)} track`} aria-pressed={muted} disabled={!keys.length || saving} onClick={() => onToggleTrack(track.id)}><EditorIcon name={muted ? 'mute' : 'volume'} /></button></div></div>
            <div className="arrangement-track-clips">{progress.levels.map((level) => <TimelineClip key={level.level} track={track} level={level} slot={slots[level.level]}
              selected={selected.exerciseId === track.id && selected.level === level.level} muted={mutedNotes.includes(keyFor(track.id, level.level))}
              playing={player.status === 'playing' && Math.floor(player.beat / BLOCK_BEATS) + 1 === level.level && level.status === 'completed' && !mutedNotes.includes(keyFor(track.id, level.level)) && (!player.previewKey || player.previewKey === keyFor(track.id, level.level))}
              waveform={player.waveforms?.[track.id]?.[level.level - 1]} canEdit={canEdit} scrollRef={scrollRef}
              onSelect={() => onSelect(track.id, level.level)} onMove={(slot) => onMove(track.id, level.level, slot)} onDragTarget={showDragTarget} />)}
              {dragTarget?.exerciseId === track.id && <div className="clip-drop-target" style={{ gridColumn: dragTarget.slot + 1, gridRow: 1 }} aria-hidden="true" />}
            </div></section>;
        })}
        <div className="arrangement-playhead-layer" aria-hidden="true"><div className="arrangement-playhead" style={{ transform: `translateX(${fraction * 100}%)` }}><span className="playhead-head" /><span className="playhead-line" /></div></div>
      </div>
    </div>
    <div className="arrangement-footer"><div className="arrangement-legend"><span><i className="legend-next" /> Your next note</span><span><i className="legend-unlocked" /> Unlocked</span><span><EditorIcon name="lock" size={12} /> Coming up</span></div><span>Drag unlocked notes to rearrange. The rhythm stays in order.</span><button className="plain-button" onClick={onShortcuts}>Keyboard shortcuts</button></div>
  </section>;
}

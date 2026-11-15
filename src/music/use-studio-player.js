import { useEffect, useRef, useState } from 'react';
import { loadStem } from './beat.js';
import { BLOCK_BEATS, partForTrack } from './timeline.js';
import { createTimelinePlayer } from './player.js';
import { connectMediaSession, createPlayerKeyHandler } from './player-integrations.js';
import { waveformForBuffer } from './waveform.js';

const keyFor = ({ exerciseId, level }) => `${exerciseId}:${level}`;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function arrangement(song, tracks, mutedNotes) {
  const muted = new Set(mutedNotes);
  const enabled = tracks.map((track) => ({ exerciseId: track.exerciseId,
    levels: track.levels.filter(({ level, status }) => status === 'completed'
      && Number.isInteger(level) && level >= 1 && level <= 7
      && !muted.has(`${track.exerciseId}:${level}`)).map(({ level }) => level).sort((a, b) => a - b),
  })).filter(({ levels }) => levels.length).sort((a, b) => a.exerciseId.localeCompare(b.exerciseId));
  const secondsPerBlock = BLOCK_BEATS * 60 / song.bpm;
  return {
    enabled,
    duration: Math.max(0, ...enabled.flatMap(({ levels }) => levels)) * secondsPerBlock,
    secondsPerBlock,
    signature: JSON.stringify([song.id, song.bpm, enabled]),
  };
}

// Owns the audio lifecycle independently of visual pad positions and account UI.
// A transport has an immutable arrangement, so real mute changes replace it at
// the current clock position while moving a pad never interrupts playback.
export function useStudioPlayer({ song, tracks = [], mutedNotes = [], accountId = null, onNotice, onPrevious, onNext }) {
  const plan = arrangement(song, tracks, mutedNotes);
  const current = useRef(null);
  current.current = { ...plan, song, accountId, onNotice };
  const context = useRef(null), transport = useRef(null), buffers = useRef(new Map());
  const waveformCache = useRef(new Map());
  const generation = useRef(0), mounted = useRef(true), request = useRef(null);
  const resumeSequence = useRef(0);
  const knownAccount = useRef(accountId);
  const integration = useRef(null), integrationState = useRef(null);
  const preferences = useRef({ volume: 0.8, loop: false, audibleVolume: 0.8 });
  const [volume, updateVolume] = useState(0.8), [loop, updateLoop] = useState(false);
  const [view, setView] = useState({ status: 'idle', elapsed: 0, duration: plan.duration, beat: 0, previewKey: null, hasPlayer: false });
  const waveformKey = `${song.id}/${song.bpm}`;
  const [waveformView, setWaveformView] = useState({ key: waveformKey, accountId, values: {} });

  function notice(message) { if (mounted.current) current.current.onNotice?.(message); }
  function cancelTransport() {
    generation.current++;
    transport.current?.dispose();
    transport.current = null;
  }
  function reset(message = '') {
    cancelTransport();
    request.current = null;
    if (mounted.current) setView({ status: 'idle', elapsed: 0, duration: current.current.duration, beat: 0, previewKey: null, hasPlayer: false });
    notice(typeof message === 'string' ? message : '');
  }
  function ensureContext() {
    if (!context.current) {
      const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextImpl) throw new Error('This browser does not support music playback.');
      context.current = new AudioContextImpl();
    }
    return context.current;
  }
  function valid(token, config) {
    return mounted.current && token === generation.current
      && config.accountId === current.current.accountId
      && config.signature === current.current.signature;
  }
  function eligible(config, preview) {
    return config.enabled.map((part) => ({ ...part,
      levels: part.levels.filter((level) => !preview || (preview.exerciseId === part.exerciseId && preview.level === level)),
    })).filter(({ levels }) => levels.length);
  }

  async function load({ preview = null, elapsed = 0, shouldPlay = true, restartPastEnd = true } = {}, config = current.current) {
    const parts = eligible(config, preview);
    if (!parts.length) {
      reset(preview ? 'Enable this note to hear it.' : 'Unlock a note and include it in your mix to start listening.');
      return;
    }
    cancelTransport();
    const token = generation.current;
    const descriptor = { signature: config.signature, songId: config.song.id, accountId: config.accountId,
      preview, elapsed: Math.max(0, elapsed), shouldPlay, restartPastEnd };
    request.current = descriptor;
    const duration = preview ? config.secondsPerBlock : config.duration;
    const previewKey = preview ? keyFor(preview) : null;
    setView({ status: 'loading', elapsed: clamp(elapsed, 0, duration), duration,
      beat: ((preview ? (preview.level - 1) * config.secondsPerBlock : 0) + elapsed) / (60 / config.song.bpm), previewKey, hasPlayer: false });
    notice('Loading your music…');
    try {
      const audio = ensureContext();
      // Resume immediately from the user gesture, before fetching or decoding.
      if (shouldPlay) await audio.resume();
      if (!valid(token, config)) return;
      const decoded = await Promise.all(parts.map(async ({ exerciseId, levels }) => {
        const part = partForTrack(config.song, exerciseId);
        const cacheKey = `${config.song.id}/${part.stem}`;
        if (!buffers.current.has(cacheKey)) {
          const pending = loadStem(audio, config.song, part).catch((error) => {
            if (buffers.current.get(cacheKey) === pending) buffers.current.delete(cacheKey);
            throw error;
          });
          buffers.current.set(cacheKey, pending);
        }
        const buffer = await buffers.current.get(cacheKey);
        const envelopeKey = `${cacheKey}/${config.song.bpm}`;
        if (!waveformCache.current.has(envelopeKey)) {
          // An optional outline must never prevent otherwise valid playback.
          try { waveformCache.current.set(envelopeKey, waveformForBuffer(buffer, config.secondsPerBlock)); }
          catch { waveformCache.current.set(envelopeKey, null); }
        }
        return { exerciseId, buffer, waveform: waveformCache.current.get(envelopeKey), levels: levels.map((level) => ({ level, enabled: true })) };
      }));
      if (!valid(token, config)) return;
      const key = `${config.song.id}/${config.song.bpm}`;
      setWaveformView((previous) => ({ key, accountId: config.accountId,
        values: { ...(previous.key === key && previous.accountId === config.accountId ? previous.values : {}),
          ...Object.fromEntries(decoded.filter((part) => part.waveform).map((part) => [part.exerciseId, part.waveform])),
        },
      }));
      const wantsPlayback = descriptor.shouldPlay;
      const publish = (state) => {
        if (!valid(token, config)) return;
        descriptor.elapsed = state.elapsed;
        descriptor.shouldPlay = state.status === 'playing';
        setView({ status: state.status, elapsed: state.elapsed, duration: state.duration, beat: state.beat, previewKey, hasPlayer: true });
      };
      const player = createTimelinePlayer(audio, config.song, decoded, {
        preview: Boolean(preview), volume: preferences.current.volume, loop: preferences.current.loop,
        onChange: publish,
        onEnded: () => { if (valid(token, config)) notice('Playback finished.'); },
      });
      transport.current = player;
      const state = player.getState();
      // If muting removed the tail of a playing mix, return to its beginning
      // instead of leaving a newly-created transport at an unreachable time.
      const position = descriptor.elapsed >= state.duration && wantsPlayback && descriptor.restartPastEnd ? 0 : clamp(descriptor.elapsed, 0, state.duration);
      player.seek(position);
      if (wantsPlayback && position < state.duration) player.play();
      else publish(player.getState());
      notice(player.getState().status === 'playing' ? preview ? `Playing note ${preview.level}.` : 'Playing your mix.' : position >= state.duration ? 'Playback finished.' : 'Paused.');
    } catch (error) {
      if (!valid(token, config)) return;
      reset(error?.message || 'Music could not load. Please try again.');
    }
  }

  async function resume() {
    const active = request.current;
    if (!active) return load();
    const sequence = ++resumeSequence.current;
    const token = generation.current;
    const config = current.current;
    try {
      await ensureContext().resume();
      if (!valid(token, config) || request.current !== active || sequence !== resumeSequence.current) return;
      active.shouldPlay = true;
      transport.current?.play();
      notice(request.current?.preview ? `Playing note ${request.current.preview.level}.` : 'Playing your mix.');
    } catch (error) { if (valid(token, config)) notice(error?.message || 'Playback could not start.'); }
  }
  function pause() {
    resumeSequence.current++;
    if (request.current) request.current.shouldPlay = false;
    transport.current?.pause();
    if (request.current) notice('Paused.');
  }
  function toggle() {
    if (request.current && !transport.current) { reset(); return; }
    if (transport.current?.getState().status === 'playing') return pause();
    return resume();
  }
  function playMix() {
    if (request.current && !request.current.preview && request.current.signature === current.current.signature) {
      return resume();
    }
    return load();
  }
  function playNote(preview) {
    if (!preview || !Number.isInteger(preview.level)) return;
    if (request.current?.preview && keyFor(request.current.preview) === keyFor(preview)
      && request.current.signature === current.current.signature) {
      return resume();
    }
    return load({ preview });
  }
  function seek(seconds) {
    if (!Number.isFinite(seconds)) return;
    if (transport.current) { transport.current.seek(seconds); return; }
    if (request.current) {
      request.current.elapsed = Math.max(0, seconds);
      request.current.restartPastEnd = false;
      const previewBeat = request.current.preview ? (request.current.preview.level - 1) * BLOCK_BEATS : 0;
      const secondsPerBeat = 60 / current.current.song.bpm;
      setView((previous) => {
        const elapsed = clamp(seconds, 0, previous.duration);
        return { ...previous, elapsed, beat: previewBeat + elapsed / secondsPerBeat };
      });
      return;
    }
    return load({ elapsed: seconds, shouldPlay: false });
  }
  function seekMix(seconds) {
    if (!Number.isFinite(seconds)) return;
    const config = current.current;
    const active = request.current;
    const elapsed = clamp(seconds, 0, config.duration);
    if (active && !active.preview && active.signature === config.signature) return seek(elapsed);
    const state = transport.current?.getState();
    const shouldPlay = state ? state.status === 'playing' : active?.shouldPlay ?? false;
    return load({ elapsed, shouldPlay, restartPastEnd: false }, config);
  }
  function setVolume(value) {
    if (!Number.isFinite(value)) return;
    const next = clamp(value, 0, 1);
    preferences.current.volume = next;
    if (next > 0) preferences.current.audibleVolume = next;
    updateVolume(next);
    transport.current?.setVolume(next);
  }
  function toggleMute() { setVolume(preferences.current.volume > 0 ? 0 : preferences.current.audibleVolume || 0.8); }
  function setLoop(value) {
    const next = Boolean(value);
    preferences.current.loop = next; updateLoop(next);
    transport.current?.setLoop(next);
  }

  useEffect(() => {
    setWaveformView({ key: waveformKey, accountId, values: {} });
  }, [waveformKey, accountId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; cancelTransport(); request.current = null;
      const audio = context.current; context.current = null;
      if (audio && audio.state !== 'closed') void audio.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const config = current.current;
    if (knownAccount.current !== config.accountId) {
      knownAccount.current = config.accountId; reset(); return;
    }
    const active = request.current;
    if (!active || active.signature === config.signature) return;
    const live = transport.current?.getState();
    const sameSong = active.songId === config.song.id;
    const preview = sameSong ? active.preview : null;
    const elapsed = sameSong ? live?.elapsed ?? active.elapsed : 0;
    const shouldPlay = live ? live.status === 'playing' : active.shouldPlay;
    void load({ preview, elapsed, shouldPlay }, config);
  }, [plan.signature, accountId]);

  integrationState.current = () => ({ ...view, ...transport.current?.getState(),
    song: current.current.song, active: Boolean(request.current), hasAudio: current.current.enabled.length > 0,
    previewKey: request.current?.preview ? keyFor(request.current.preview) : null,
    play: resume, pause, stop: reset, seek, toggle, toggleMute,
    previoustrack: onPrevious, nexttrack: onNext,
  });
  useEffect(() => {
    const read = () => integrationState.current();
    const media = connectMediaSession(navigator.mediaSession, window.MediaMetadata, read);
    integration.current = media;
    const onKey = createPlayerKeyHandler(read);
    window.addEventListener('keydown', onKey);
    media.update();
    return () => { window.removeEventListener('keydown', onKey); media.dispose(); integration.current = null; };
  }, []);
  useEffect(() => { integration.current?.update(); },
    [song.id, view.status, Math.floor(view.elapsed), view.duration, view.previewKey, Boolean(onPrevious), Boolean(onNext)]);

  return {
    ...view,
    duration: view.status === 'idle' ? plan.duration : view.duration,
    volume, loop, hasAudio: plan.enabled.length > 0,
    waveforms: waveformView.key === waveformKey && waveformView.accountId === accountId ? waveformView.values : {},
    toggle, pause, resume, playMix, playNote, seek, seekMix, setVolume, setLoop, toggleMute, reset,
  };
}

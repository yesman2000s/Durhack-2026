import { planTimeline } from './timeline.js';

const LEAD_SECONDS = 0.035;
const TICK_MS = 100;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// A transport owns one immutable arrangement. Changing songs or enabled notes
// creates a new transport; visual pad positions never enter the audio plan.
export function createTimelinePlayer(context, song, parts, {
  preview = false, onChange, onEnded, volume = 0.8, loop = false,
} = {}) {
  const plan = planTimeline(song, parts);
  const origin = preview && plan.blocks.length ? plan.blocks[0].start : 0;
  const duration = Math.max(0, plan.duration - origin);
  const normalization = Math.sqrt(Math.max(1, new Set(plan.blocks.map(({ exerciseId }) => exerciseId)).size));
  const master = context.createGain();
  let currentVolume = Number.isFinite(volume) ? clamp(volume, 0, 1) : 0.8;
  let repeating = Boolean(loop);
  let status = 'paused';
  let position = 0;
  let anchor = 0;
  let generation = 0;
  let lastScheduledCycle = -1;
  let timer;
  let disposed = false;
  const active = new Map();
  const retiring = new Set();
  master.gain.value = currentVolume / normalization;
  master.connect(context.destination);

  function elapsed() {
    if (status !== 'playing' || !duration) return position;
    // Keep the requested seek position during the short scheduling lead-in.
    const time = Math.max(position, context.currentTime - anchor);
    return repeating ? time % duration : Math.min(duration, time);
  }

  function getState() {
    const time = elapsed();
    return { status, elapsed: time, duration, beat: (origin + time) / plan.secondsPerBeat,
      progress: duration ? time / duration : 0, volume: currentVolume, loop: repeating };
  }

  function emit() { if (!disposed && typeof onChange === 'function') onChange(getState()); }

  function disconnect(entry) {
    if (entry.disconnected) return;
    entry.disconnected = true;
    entry.source.onended = null;
    entry.source.disconnect();
    entry.gain.disconnect();
    retiring.delete(entry);
  }

  function cancelSources(immediate = false) {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    const now = context.currentTime;
    for (const entry of active.values()) {
      const { source, gain } = entry;
      source.onended = () => disconnect(entry);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, 0.004);
      retiring.add(entry);
      try { source.stop(immediate ? now : now + 0.02); } catch { disconnect(entry); }
      if (immediate) disconnect(entry);
    }
    active.clear();
    lastScheduledCycle = -1;
    if (immediate) for (const entry of [...retiring]) disconnect(entry);
  }

  function finishNaturally() {
    if (disposed || status !== 'playing') return;
    cancelSources();
    position = duration;
    status = 'ended';
    const finishedGeneration = generation;
    emit();
    // A consumer may dispose or restart from onChange.
    if (!disposed && generation === finishedGeneration && status === 'ended') onEnded?.();
  }

  function scheduleCycle(cycle, from = 0) {
    const token = generation;
    const cycleStart = anchor + cycle * duration;
    for (const block of plan.blocks) {
      const blockStart = block.start - origin;
      const blockEnd = block.end - origin;
      if (blockEnd <= from) continue;
      const clipStart = Math.max(blockStart, from);
      const length = blockEnd - clipStart;
      const startAt = cycleStart + clipStart;
      const source = context.createBufferSource();
      const gain = context.createGain();
      const entry = { source, gain, disconnected: false };
      source.buffer = block.buffer;
      source.connect(gain).connect(master);
      active.set(source, entry);
      source.onended = () => {
        if (disposed || token !== generation || !active.has(source)) return;
        active.delete(source);
        disconnect(entry);
        if (repeating) ensureAhead();
        else if (!active.size && elapsed() >= duration - 0.0001) finishNaturally();
      };
      const attack = Math.min(0.008, length / 3);
      const release = Math.min(0.018, length / 3);
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + attack);
      gain.gain.setValueAtTime(1, startAt + length - release);
      gain.gain.linearRampToValueAtTime(0, startAt + length);
      source.start(startAt, block.offset + clipStart - blockStart, length);
    }
    lastScheduledCycle = cycle;
  }

  function ensureAhead() {
    if (!repeating || disposed || status !== 'playing' || !duration) return;
    const clock = Math.max(position, context.currentTime - anchor);
    const cycle = Math.floor(clock / duration);
    // If a background tab's clock jumped, skip expired cycles instead of
    // scheduling their audio in the past. One future cycle stays queued so
    // ordinary looping is sample-aligned and independent of timer jitter.
    if (lastScheduledCycle < cycle - 1) lastScheduledCycle = cycle - 1;
    while (lastScheduledCycle < cycle + 1) {
      const next = lastScheduledCycle + 1;
      scheduleCycle(next, next === cycle ? clock % duration : 0);
    }
  }

  function tick(token) {
    if (disposed || status !== 'playing' || token !== generation) return;
    if (!repeating && elapsed() >= duration) return finishNaturally();
    ensureAhead();
    emit();
    if (!disposed && status === 'playing' && token === generation) timer = setTimeout(() => tick(token), TICK_MS);
  }

  function startAtPosition() {
    anchor = context.currentTime + LEAD_SECONDS - position;
    status = 'playing';
    try {
      scheduleCycle(0, position);
      ensureAhead();
    } catch (error) {
      cancelSources(true);
      status = 'paused';
      emit();
      throw error;
    }
    tick(generation);
  }

  const player = {
    play() {
      if (disposed || status === 'playing') return getState();
      if (!duration) { status = 'ended'; emit(); return getState(); }
      if (position >= duration) position = 0;
      startAtPosition();
      return getState();
    },
    pause() {
      if (disposed || status !== 'playing') return getState();
      position = elapsed();
      cancelSources();
      status = 'paused';
      emit();
      return getState();
    },
    seek(seconds) {
      if (disposed || !Number.isFinite(seconds)) return getState();
      const wasPlaying = status === 'playing';
      cancelSources();
      position = clamp(seconds, 0, duration);
      status = position >= duration && duration ? 'ended' : 'paused';
      if (wasPlaying && position < duration) startAtPosition();
      else emit();
      return getState();
    },
    setVolume(value) {
      if (disposed || !Number.isFinite(value)) return getState();
      currentVolume = clamp(value, 0, 1);
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setTargetAtTime(currentVolume / normalization, context.currentTime, 0.01);
      emit();
      return getState();
    },
    setLoop(value) {
      if (disposed || repeating === Boolean(value)) return getState();
      position = elapsed();
      const wasPlaying = status === 'playing';
      cancelSources();
      repeating = Boolean(value);
      status = 'paused';
      if (wasPlaying && position < duration) startAtPosition();
      else emit();
      return getState();
    },
    stop() {
      if (disposed) return getState();
      cancelSources();
      position = 0;
      status = 'paused';
      emit();
      return getState();
    },
    dispose() {
      if (disposed) return;
      position = elapsed();
      disposed = true;
      status = 'paused';
      cancelSources(true);
      master.disconnect();
    },
    getState,
  };
  return player;
}

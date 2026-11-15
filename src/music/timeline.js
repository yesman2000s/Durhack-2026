import { EXCERPT_BEATS } from './beat.js';

export const BLOCK_BEATS = 16;
const LEVEL_COUNT = EXCERPT_BEATS / BLOCK_BEATS;

export function partForTrack(song, track) {
  const id = typeof track === 'string' ? track : track?.exerciseId ?? track?.id;
  const percussion = song.percussionParts || song.id === 'hiphop' || song.id === 'electronic';
  const parts = percussion ? {
    squat: { stem: 'drums-low', name: 'Low percussion' },
    'knee-raise': { stem: 'bass', name: 'Bass' },
    'push-up': { stem: 'other', name: 'Melodic stem' },
    'heel-raise': { stem: 'drums-high', name: 'High percussion' },
  } : {
    squat: { stem: 'drums', name: 'Drums' },
    'knee-raise': { stem: 'bass', name: 'Bass' },
    'push-up': { stem: 'piano', name: 'Piano' },
    'heel-raise': { stem: 'guitar', name: 'Guitar' },
  };
  if (!parts[id]) throw new Error('This movement has no music track.');
  return parts[id];
}

// Visual order and drag coordinates deliberately never enter this plan. A level
// always refers to the same part of the original, synchronized song.
export function planTimeline(song, parts) {
  if (!Number.isFinite(song?.bpm) || song.bpm <= 0) throw new Error('The song tempo is invalid.');
  const secondsPerBeat = 60 / song.bpm;
  const blocks = [];
  const seen = new Set();
  for (const [partIndex, part] of parts.entries()) {
    if (part.enabled === false || !Number.isFinite(part.buffer?.duration) || part.buffer.duration <= 0) continue;
    for (const entry of part.levels ?? []) {
      const { level } = entry;
      if (entry.enabled === false || entry.unlocked === false || !Number.isInteger(level) || level < 1 || level > LEVEL_COUNT) continue;
      const exerciseId = part.exerciseId ?? part.id ?? String(partIndex);
      const key = JSON.stringify([exerciseId, level]);
      if (seen.has(key)) continue;
      seen.add(key);
      const start = (level - 1) * BLOCK_BEATS * secondsPerBeat;
      const end = Math.min(level * BLOCK_BEATS * secondsPerBeat, part.buffer.duration);
      if (end <= start) continue;
      blocks.push({ buffer: part.buffer, exerciseId, level, start, offset: start, duration: end - start, end });
    }
  }
  blocks.sort((a, b) => a.start - b.start || a.exerciseId.localeCompare(b.exerciseId));
  return { blocks, secondsPerBeat, duration: Math.max(0, ...blocks.map(({ end }) => end)) };
}

export function playTimeline(context, song, parts, onEnded = () => {}, { onProgress, preview = false } = {}) {
  const plan = planTimeline(song, parts);
  const origin = preview && plan.blocks.length ? plan.blocks[0].start : 0;
  const duration = Math.max(0, plan.duration - origin);
  const startAt = context.currentTime + 0.035;
  const active = new Map();
  let finished = false;
  let stopped = false;
  let progressTimer;
  let master;

  function reportProgress(atEnd = false) {
    if (typeof onProgress !== 'function') return;
    const elapsed = atEnd ? duration : Math.max(0, Math.min(duration, context.currentTime - startAt));
    onProgress({ elapsed, duration, beat: (origin + elapsed) / plan.secondsPerBeat, progress: duration ? elapsed / duration : 1 });
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(progressTimer);
    master?.disconnect();
    reportProgress(!stopped);
    onEnded();
  }

  function release(source) {
    const gain = active.get(source);
    if (!gain) return;
    active.delete(source);
    source.disconnect();
    gain.disconnect();
    if (!active.size) finish();
  }

  const stop = () => {
    if (finished || stopped) return;
    stopped = true;
    clearTimeout(progressTimer);
    if (!master) return finish();
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(0, now, 0.004);
    for (const source of [...active.keys()]) {
      try { source.stop(now + 0.02); } catch { release(source); }
    }
    if (!active.size) finish();
  };

  if (!plan.blocks.length) {
    queueMicrotask(finish);
    return stop;
  }

  try {
    master = context.createGain();
    master.gain.value = 0.8 / Math.sqrt(new Set(plan.blocks.map(({ exerciseId }) => exerciseId)).size);
    master.connect(context.destination);
    // Create every source before starting any, so a source's completion cannot
    // mistake an unscheduled later block for the end of the whole mix.
    for (const block of plan.blocks) {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = block.buffer;
      source.connect(gain).connect(master);
      active.set(source, gain);
      source.onended = () => release(source);
      const begin = startAt + (block.start - origin);
      const end = begin + block.duration;
      const attack = Math.min(0.008, block.duration / 3);
      const releaseTime = Math.min(0.018, block.duration / 3);
      gain.gain.setValueAtTime(0, begin);
      gain.gain.linearRampToValueAtTime(1, begin + attack);
      gain.gain.setValueAtTime(1, end - releaseTime);
      gain.gain.linearRampToValueAtTime(0, end);
    }
    for (const [index, source] of [...active.keys()].entries()) {
      const block = plan.blocks[index];
      source.start(startAt + (block.start - origin), block.offset, block.duration);
    }
  } catch (error) {
    finished = true;
    for (const [source, gain] of active) {
      source.onended = null;
      try { source.stop(); } catch { /* A source may not have started yet. */ }
      source.disconnect();
      gain.disconnect();
    }
    active.clear();
    master?.disconnect();
    throw error;
  }

  if (typeof onProgress === 'function') {
    const tick = () => {
      if (finished || stopped) return;
      reportProgress();
      progressTimer = setTimeout(tick, 50);
    };
    tick();
  }
  return stop;
}

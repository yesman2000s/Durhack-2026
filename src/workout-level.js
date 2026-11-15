import { LEVEL_COUNT } from './level-progression.js';

export function parseRequestedLevel(search) {
  const value = new URLSearchParams(search).get('level');
  if (value === null) return null;
  const level = Number(value);
  return Number.isInteger(level) && level >= 1 && level <= LEVEL_COUNT ? level : null;
}

export function selectLevel(progress, exerciseId, requestedLevel = null) {
  const track = progress?.tracks?.find((entry) => entry.exerciseId === exerciseId);
  if (!track) return { error: 'Your exercise progress could not be loaded.' };
  if (!track.target) return {
    track, level: LEVEL_COUNT,
    target: { level: LEVEL_COUNT, reps: 1, scoreToBeat: track.bestScore, practice: true },
  };
  const level = requestedLevel ?? track.target.level;
  if (level !== track.target.level) {
    const status = track.levels?.find((entry) => entry.level === level)?.status;
    return { track, level, error: status === 'completed'
      ? `Level ${level} is already complete. Continue with level ${track.target.level}.`
      : `Complete level ${track.target.level} to open this level.` };
  }
  return { track, level, target: track.target };
}

export function describeTarget(target) {
  if (!target) return 'Your next level is waiting.';
  if (target.scoreToBeat == null) return 'Complete a reviewed workout to set your first personal best.';
  if (target.scoreToBeat === 100) return 'You reached the top form score. You can still practise and save your workouts.';
  return `Beat your personal best of ${target.scoreToBeat} / 100.`;
}

export async function workoutApi(path, options = {}, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(path, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || 'Your workout could not be saved. Please try again.');
    error.status = response.status;
    throw error;
  }
  return body;
}

// The camera stream contains no microphone track. Also strip any audio tracks
// defensively so saved workout footage can never pick up a microphone later.
export function createSetRecording(stream, {
  MediaRecorderImpl = globalThis.MediaRecorder, MediaStreamImpl = globalThis.MediaStream,
} = {}) {
  if (!MediaRecorderImpl || !stream?.getVideoTracks?.().length) return null;
  const videoStream = MediaStreamImpl ? new MediaStreamImpl(stream.getVideoTracks()) : stream;
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
    .find((type) => MediaRecorderImpl.isTypeSupported?.(type));
  const recorder = new MediaRecorderImpl(videoStream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  let stopped;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  recorder.addEventListener('dataavailable', ({ data }) => { if (data?.size) chunks.push(data); });
  recorder.addEventListener('stop', () => resolveDone({
    blob: chunks.length ? new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' }) : null,
    error: stopped?.error ?? '',
  }), { once: true });
  recorder.addEventListener('error', () => {
    stopped = { error: 'The workout video could not be recorded. Your rep evidence is still saved.' };
    // An error is followed by final data and a stop event, even if state has
    // already become inactive. Resolving here would silently lose that data.
    if (recorder.state !== 'inactive') recorder.stop();
  }, { once: true });
  recorder.start(1000);
  return {
    stop() {
      if (!stopped) {
        stopped = {};
        if (recorder.state !== 'inactive') recorder.stop();
        // Track disconnection can set inactive before the final events run.
        // Keep waiting for stop so its last dataavailable chunk is included.
      }
      return done;
    },
  };
}

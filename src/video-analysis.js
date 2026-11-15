import { POSE_SAMPLE_INTERVAL_MS } from './pose-cadence.js';

const loadLandmarker = async () => (await import('./camera.js')).createLandmarker();

const MEDIA_WAIT_MS = 15000;
const END_GUARD_MS = 1;

function waitForMedia(video, event, signal, perform) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const timeout = setTimeout(() => finish(new Error('The video took too long to decode. Try a shorter MP4 or WebM.')), MEDIA_WAIT_MS);
    function finish(error) {
      clearTimeout(timeout);
      listeners.abort();
      if (error) reject(error);
      else resolve();
    }
    const options = { signal: listeners.signal, once: true };
    video.addEventListener(event, () => finish(), options);
    video.addEventListener('error', () => finish(new Error('This video could not be decoded. Try an MP4 (H.264) or WebM.')), options);
    signal.addEventListener('abort', () => finish(signal.reason), options);
    try { perform(); }
    catch (error) { finish(error); }
  });
}

export function createVideoAnalysis(video, { onFrame, onProgress, onEnd, onError, landmarkerFactory = loadLandmarker }) {
  let running = null;
  let url = null;

  function finish() {
    const session = running;
    if (!session) return;
    running = null;
    session.controller.abort();
    session.landmarker?.close();
    session.landmarker = null;
  }

  function stop() {
    finish();
    if (!url) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    url = null;
  }

  async function scan(session, durationMs) {
    const { signal } = session.controller;
    const lastTime = Math.max(0, durationMs - END_GUARD_MS);
    // Keep the clip paused and decode each requested time before inference.
    // A slow computer can take longer to analyze without skipping movement.
    try {
      for (let index = 0; !signal.aborted; index += 1) {
        const timestampMs = Math.min(lastTime, index * POSE_SAMPLE_INTERVAL_MS);
        const seconds = timestampMs / 1000;
        if (Math.abs(video.currentTime - seconds) >= 0.0005) {
          await waitForMedia(video, 'seeked', signal, () => { video.currentTime = seconds; });
        }
        signal.throwIfAborted();
        const result = session.landmarker.detectForVideo(video, timestampMs);
        onProgress?.(timestampMs, durationMs);
        if (signal.aborted) return;
        onFrame({
          landmarks: result.landmarks[0] ?? null,
          timestampMs,
          width: video.videoWidth,
          height: video.videoHeight,
          video,
        });
        if (signal.aborted) return;
        if (timestampMs >= lastTime) break;
      }
      if (!signal.aborted) {
        finish();
        onEnd?.();
      }
    } catch (error) {
      if (signal.aborted) return;
      stop();
      onError?.(error);
    }
  }

  async function start(file) {
    stop();
    const session = { controller: new AbortController(), landmarker: null };
    running = session;
    const { signal } = session.controller;
    url = URL.createObjectURL(file);
    video.muted = true;
    try {
      await waitForMedia(video, 'loadeddata', signal, () => {
        video.src = url;
        video.load();
      });
      const durationMs = video.duration * 1000;
      if (!(Number.isFinite(durationMs) && durationMs > 0 && video.videoWidth > 0 && video.videoHeight > 0)) {
        throw new Error('This file has no readable video or duration. Try an MP4 (H.264) or WebM.');
      }
      const landmarker = await landmarkerFactory().catch((cause) => {
        throw new Error('The pose model could not load. Refresh the app and try again.', { cause });
      });
      if (signal.aborted) { landmarker.close(); return; }
      session.landmarker = landmarker;
      await scan(session, durationMs);
    } catch (error) {
      if (signal.aborted) return;
      stop();
      onError?.(error);
    }
  }

  return { start, finish, stop };
}

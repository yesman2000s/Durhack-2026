import { exportSnapshot } from './evidence.js';
import { normalizeFeedback } from '../server/feedback.js';

const MAX_ANALYSES = 2;

export function coachingPayload(rep, session) {
  return {
    ...rep,
    snapshots: (rep.snapshots ?? []).map((snapshot) => snapshot.url ? exportSnapshot(snapshot) : { ...snapshot }),
    session: { ...session, previousReps: (session?.previousReps ?? []).slice(-5) },
  };
}

// Capture never waits for analysis or speech. Every rep gets an analysis; only
// unsounded audio is replaceable, so slow responses cannot become a cue backlog.
export function createRepCoach({
  onUpdate = () => {}, onAudioState = () => {}, fetchImpl = globalThis.fetch,
  audioFactory = () => new Audio(), createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
} = {}) {
  let generation = 0;
  let sequence = 0;
  let sessionId;
  let disposed = false;
  let muted = false;
  let permissionBlocked = false;
  let latestAudioSequence = -1;
  let pendingSpeech;
  let currentSpeech;
  const analyses = new Set();
  const waiting = [];
  const records = new Map();
  const idleWaiters = new Set();
  const current = (job) => !disposed && job.generation === generation && !job.controller.signal.aborted;
  const update = (job, patch) => { if (current(job)) onUpdate(job.id, patch); };
  function settleAnalyses(cancelled = false) {
    if (!cancelled && (analyses.size || waiting.length)) return;
    const result = { cancelled, failedIds: [...records.values()].filter((job) => job.status === 'error').map((job) => job.id) };
    for (const resolve of idleWaiters) resolve(result);
    idleWaiters.clear();
  }
  function audioState(status, job, error = '') {
    if (!disposed) onAudioState({ status, repId: job?.id ?? null, repNumber: job?.repNumber ?? null, error });
  }

  function releaseAudio(job) {
    if (!job) return;
    job.controller.abort();
    if (job.audio) {
      job.audio.removeEventListener('ended', job.onEnded);
      job.audio.removeEventListener('error', job.onError);
      job.audio.pause();
      job.audio.removeAttribute('src');
      job.audio.load();
    }
    if (job.url) revokeObjectURL(job.url);
    job.url = null;
  }

  function finishSpeech(job, error) {
    if (currentSpeech !== job || !current(job)) return;
    update(job, { speechStatus: error ? 'error' : 'complete', speechError: error || '' });
    currentSpeech = undefined;
    releaseAudio(job);
    if (error) audioState('error', job, error);
    else audioState(muted ? 'muted' : 'idle');
    void pumpSpeech();
  }

  async function playSpeech(job) {
    if (currentSpeech !== job || !current(job) || muted) return;
    try {
      await job.audio.play();
      if (currentSpeech !== job || !current(job) || muted) return;
      permissionBlocked = false;
      update(job, { speechStatus: 'playing', speechError: '' });
      audioState('playing', job);
    } catch (error) {
      if (currentSpeech !== job || !current(job)) return;
      if (error.name === 'NotAllowedError') {
        permissionBlocked = true;
        update(job, { speechStatus: 'blocked' });
        audioState('blocked', job);
      } else finishSpeech(job, 'Feedback could not play. You can read it below.');
    }
  }

  async function pumpSpeech() {
    if (disposed || muted || currentSpeech || !pendingSpeech) return;
    const job = pendingSpeech;
    pendingSpeech = undefined;
    currentSpeech = job;
    update(job, { speechStatus: 'loading', speechError: '' });
    audioState('loading', job);
    try {
      const response = await fetchImpl('/api/form-speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.controller.signal,
        body: JSON.stringify({ ...job.feedback, ...(Number.isInteger(job.repNumber) ? { repNumber: job.repNumber } : {}) }),
      });
      if (!current(job) || currentSpeech !== job) return;
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Feedback audio is unavailable.');
      }
      const blob = await response.blob();
      if (!current(job) || currentSpeech !== job) return;
      job.url = createObjectURL(blob);
      job.audio = audioFactory();
      job.onEnded = () => finishSpeech(job);
      job.onError = () => finishSpeech(job, 'Feedback audio could not be played.');
      job.audio.addEventListener('ended', job.onEnded);
      job.audio.addEventListener('error', job.onError);
      job.audio.src = job.url;
      if (permissionBlocked) {
        update(job, { speechStatus: 'blocked' });
        audioState('blocked', job);
      } else await playSpeech(job);
    } catch (error) {
      if (current(job) && currentSpeech === job) finishSpeech(job, error.message || 'Feedback audio is unavailable.');
    }
  }

  function queueSpeech(analysis, feedback) {
    const outdated = analysis.sequence < latestAudioSequence;
    latestAudioSequence = Math.max(latestAudioSequence, analysis.sequence);
    if (muted || outdated || (!feedback.summary && !feedback.tips.length)) {
      update(analysis, { speechStatus: 'skipped' });
      return;
    }
    if (pendingSpeech) {
      update(pendingSpeech, { speechStatus: 'superseded' });
      releaseAudio(pendingSpeech);
    }
    pendingSpeech = { ...analysis, body: null, feedback, controller: new AbortController() };
    // A loading or permission-blocked clip has not been heard yet. A playing
    // cue finishes, with at most the newest pending cue following it.
    if (currentSpeech && (!currentSpeech.audio || currentSpeech.audio.paused)) {
      update(currentSpeech, { speechStatus: 'superseded' });
      releaseAudio(currentSpeech);
      currentSpeech = undefined;
    }
    void pumpSpeech();
  }

  async function analyze(job) {
    job.status = 'analyzing';
    update(job, { status: 'analyzing', error: '' });
    try {
      const response = await fetchImpl('/api/form-score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.controller.signal,
        body: job.body,
      });
      if (!current(job)) return;
      const data = await response.json().catch(() => null);
      if (!current(job)) return;
      if (!response.ok) throw new Error(data?.error || 'Form analysis is unavailable.');
      const feedback = normalizeFeedback(data);
      if (!feedback) throw new Error('Form analysis returned an unreadable response.');
      job.status = 'complete';
      update(job, { status: 'complete', feedback, error: '' });
      queueSpeech(job, feedback);
    } catch (error) {
      if (!current(job)) return;
      job.status = 'error';
      update(job, { status: 'error', error: error.message || 'Could not reach form analysis.' });
    } finally {
      analyses.delete(job);
      job.body = null;
      if (current(job)) pumpAnalyses();
      settleAnalyses();
    }
  }

  function pumpAnalyses() {
    while (!disposed && analyses.size < MAX_ANALYSES && waiting.length) {
      const job = waiting.shift();
      if (!current(job)) continue;
      analyses.add(job);
      void analyze(job);
    }
  }

  function enqueue(rep, session = {}, retry = false) {
    if (disposed || !rep?.id) return false;
    if (sessionId !== undefined && session.id !== sessionId) reset();
    sessionId = session.id;
    const existing = records.get(rep.id);
    if (existing && (!retry || existing.status !== 'error')) return false;
    const job = {
      id: rep.id, repNumber: session.repNumber, generation, sequence: existing?.sequence ?? sequence++,
      controller: new AbortController(), status: 'queued', body: null,
    };
    records.set(job.id, job);
    try { job.body = JSON.stringify(coachingPayload(rep, session)); }
    catch {
      job.status = 'error';
      update(job, { status: 'error', error: 'This rep could not be prepared for analysis.' });
      return false;
    }
    update(job, { status: 'queued', feedback: null, error: '', speechError: '', speechStatus: 'waiting' });
    waiting.push(job);
    pumpAnalyses();
    return true;
  }

  function reset() {
    settleAnalyses(true);
    generation++;
    for (const job of [...analyses, ...waiting]) { job.controller.abort(); job.body = null; }
    analyses.clear();
    waiting.length = 0;
    records.clear();
    releaseAudio(currentSpeech);
    releaseAudio(pendingSpeech);
    currentSpeech = pendingSpeech = undefined;
    latestAudioSequence = -1;
    sessionId = undefined;
    audioState(muted ? 'muted' : 'idle');
  }

  return {
    enqueue,
    waitForIdle() {
      if (!analyses.size && !waiting.length) return Promise.resolve({ cancelled: disposed,
        failedIds: [...records.values()].filter((job) => job.status === 'error').map((job) => job.id) });
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    speak(summary, tips = []) {
      if (disposed || muted || !summary) return;
      const job = { id: null, repNumber: null, generation, sequence: sequence++, controller: new AbortController() };
      queueSpeech(job, { score: null, summary, tips });
    },
    retry: (rep, session) => enqueue(rep, session, true),
    reset,
    dispose() { disposed = true; reset(); },
    setMuted(next) {
      muted = Boolean(next);
      if (muted) {
        if (currentSpeech) update(currentSpeech, { speechStatus: 'muted' });
        if (pendingSpeech) update(pendingSpeech, { speechStatus: 'muted' });
        releaseAudio(currentSpeech);
        releaseAudio(pendingSpeech);
        currentSpeech = pendingSpeech = undefined;
      }
      audioState(muted ? 'muted' : 'idle');
    },
    resumeAudio() {
      if (muted || disposed) return Promise.resolve();
      if (currentSpeech?.audio) return playSpeech(currentSpeech);
      permissionBlocked = false;
      return Promise.resolve();
    },
  };
}

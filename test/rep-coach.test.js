import test from 'node:test';
import assert from 'node:assert/strict';
import { coachingPayload, createRepCoach } from '../src/rep-coach.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const feedback = (number = 1) => ({ score: 82, summary: `Rep ${number} returned to its starting position.`, tips: ['Lower a little more steadily.'] });
const response = (value, ok = true) => ({ ok, json: async () => value, blob: async () => new Blob(['audio'], { type: 'audio/mpeg' }) });
const rep = (id) => ({
  id: String(id), exercise: 'push-up', source: 'webcam', capturedAt: '2026-11-14T12:00:00Z',
  camera: { width: 1280, height: 720 }, trackingSide: 'left', movementStartOffsetMs: 1100,
  metrics: { range: 72, rangeUnit: 'degrees', validFrameFraction: .98 },
  motionTrace: { frames: [{ offsetMs: 1100, joints: { hip: { x: .5, y: .6, visibility: .9, presence: .8 } } }] },
  snapshots: [{ phase: 'bottom', url: 'data:image/jpeg;base64,/9j/AA==', timestampMs: 2400,
    offsetMs: 1300, width: 1280, height: 720, pose: { joints: { knee: { x: .3, y: .4, visibility: .9, presence: .7 } } } }],
});
const session = (repNumber, id = 'set-1') => ({ id, mode: 'set', repNumber, previousReps: [] });

test('whole-set spoken feedback carries next-set tips and respects mute', () => {
  const f = fixture();
  f.coach.speak('Your set averaged 82/100 across 3 scored reps.', ['Keep steady.']);
  assert.deepEqual(JSON.parse(f.speech()[0].options.body), {
    score: null, summary: 'Your set averaged 82/100 across 3 scored reps.', tips: ['Keep steady.'],
  });
  f.coach.setMuted(true);
  f.coach.speak('Another set.', ['Lower slowly.']);
  assert.equal(f.speech().length, 1);
  f.coach.dispose();
});

function fixture() {
  const requests = [];
  const updates = [];
  const reviews = new Map();
  const audioStates = [];
  const audios = [];
  const revoked = [];
  const created = [];
  let blockAudio = false;
  let pendingPlay;
  class FakeAudio extends EventTarget {
    paused = true;
    ended = false;
    error = null;
    plays = 0;
    pauses = 0;
    async play() {
      this.plays++;
      if (blockAudio) throw Object.assign(new Error('Autoplay blocked'), { name: 'NotAllowedError' });
      assert.ok(audios.every((other) => other === this || other.paused), 'audio clips must never overlap');
      this.paused = false;
      this.ended = false;
      const pending = pendingPlay;
      pendingPlay = undefined;
      if (pending) await pending;
    }
    pause() { this.pauses++; this.paused = true; }
    load() { this.ended = false; this.error = null; }
    removeAttribute() { this.src = ''; }
    end() { this.paused = true; this.ended = true; this.dispatchEvent(new Event('ended')); }
  }
  const coach = createRepCoach({
    fetchImpl(url, options) {
      return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
    },
    onUpdate(id, patch) { updates.push({ id, ...patch }); reviews.set(id, { ...reviews.get(id), ...patch }); },
    onAudioState(state) { audioStates.push(state); },
    audioFactory() { const audio = new FakeAudio(); audios.push(audio); return audio; },
    createObjectURL(blob) { const url = `blob:${created.length + 1}`; created.push({ blob, url }); return url; },
    revokeObjectURL(url) { revoked.push(url); },
  });
  return { coach, requests, updates, reviews, audioStates, audios, created, revoked,
    scores: () => requests.filter(({ url }) => url === '/api/form-score'),
    speech: () => requests.filter(({ url }) => url === '/api/form-speech'),
    blockAudio: (value) => { blockAudio = value; },
    deferPlay() {
      let resolve, reject;
      pendingPlay = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { resolve, reject };
    },
  };
}

test('analysis sends complete evidence and images, with at most five previous rep summaries', () => {
  const input = rep(1);
  const context = { ...session(7), previousReps: Array.from({ length: 6 }, (_, index) => ({ repNumber: index + 1 })) };
  const output = coachingPayload(input, context);
  assert.deepEqual(output.metrics, input.metrics);
  assert.deepEqual(output.motionTrace, input.motionTrace);
  assert.deepEqual(output.snapshots[0].pose, input.snapshots[0].pose);
  assert.equal(output.snapshots[0].imageBase64, '/9j/AA==');
  assert.equal(output.snapshots[0].width, 1280);
  assert.equal(output.snapshots[0].url, undefined);
  assert.deepEqual(output.session.previousReps.map(({ repNumber }) => repNumber), [2, 3, 4, 5, 6]);
  assert.equal(input.snapshots[0].url, 'data:image/jpeg;base64,/9j/AA==');
});

test('every rep is analyzed once with two concurrent requests and no blocking of capture', async () => {
  const f = fixture();
  f.coach.setMuted(true);
  for (let index = 1; index <= 5; index++) assert.equal(f.coach.enqueue(rep(index), session(index)), true);
  assert.equal(f.scores().length, 2);
  assert.equal(f.reviews.get('3').status, 'queued');
  assert.equal(f.coach.enqueue(rep(1), session(1)), false);
  for (let index = 0; index < 5; index++) {
    f.scores()[index].resolve(response(feedback(index + 1)));
    await turn();
  }
  assert.deepEqual(f.scores().map(({ options }) => JSON.parse(options.body).id), ['1', '2', '3', '4', '5']);
  assert.ok([...f.reviews.values()].every(({ status }) => status === 'complete'));
  assert.equal(f.speech().length, 0);
  f.coach.dispose();
});

test('reset cancels queued work and ignores responses already awaiting JSON parsing', async () => {
  const f = fixture();
  for (let index = 1; index <= 3; index++) f.coach.enqueue(rep(index), session(index));
  let resolveJson;
  f.scores()[0].resolve({ ok: true, json: () => new Promise((resolve) => { resolveJson = resolve; }) });
  await turn();
  f.coach.reset();
  const afterReset = f.updates.length;
  assert.ok(f.scores().every(({ options }) => options.signal.aborted));
  f.coach.enqueue(rep(4), session(1, 'set-2'));
  resolveJson(feedback());
  f.scores()[1].resolve(response(feedback()));
  await turn();
  assert.ok(f.updates.slice(afterReset).every(({ id }) => id === '4'));
  assert.equal(f.scores().length, 3);
  assert.equal(f.speech().length, 0);
  f.coach.dispose();
});

test('out-of-order responses keep every written review without speaking an older correction', async () => {
  const f = fixture();
  f.coach.enqueue(rep(1), session(1));
  f.coach.enqueue(rep(2), session(2));
  f.scores()[1].resolve(response(feedback(2)));
  await turn();
  f.scores()[0].resolve(response(feedback(1)));
  await turn();
  assert.equal(f.reviews.get('1').status, 'complete');
  assert.equal(f.reviews.get('2').status, 'complete');
  assert.equal(f.reviews.get('1').speechStatus, 'skipped');
  assert.equal(f.speech().length, 1);
  assert.equal(JSON.parse(f.speech()[0].options.body).repNumber, 2);
  f.coach.dispose();
});

test('speech finishes the current cue and retains only the latest unsounded response', async () => {
  const f = fixture();
  for (let index = 1; index <= 3; index++) f.coach.enqueue(rep(index), session(index));
  f.scores()[0].resolve(response(feedback(1)));
  await turn();
  f.speech()[0].resolve(response(null));
  await turn();
  assert.equal(f.audios[0].paused, false);
  f.scores()[1].resolve(response(feedback(2)));
  f.scores()[2].resolve(response(feedback(3)));
  await turn();
  assert.equal(f.speech().length, 1);
  assert.equal(f.reviews.get('2').speechStatus, 'superseded');
  f.audios[0].end();
  await turn();
  assert.equal(f.speech().length, 2);
  assert.equal(JSON.parse(f.speech()[1].options.body).repNumber, 3);
  f.speech()[1].resolve(response(null));
  await turn();
  assert.equal(f.audios.length, 1, 'successive clips reuse the gesture-unlocked element');
  assert.equal(f.audios[0].paused, false);
  assert.equal(f.audios[0].plays, 2);
  assert.deepEqual(f.revoked, ['blob:1']);
  assert.ok([...f.reviews.values()].every(({ status }) => status === 'complete'));
  f.coach.dispose();
  assert.deepEqual(f.revoked, ['blob:1', 'blob:2']);
});

test('an autoplay-blocked response can be resumed explicitly and reset releases the clip', async () => {
  const f = fixture();
  f.blockAudio(true);
  f.coach.enqueue(rep(1), session(1));
  f.scores()[0].resolve(response(feedback()));
  await turn();
  f.speech()[0].resolve(response(null));
  await turn();
  assert.equal(f.audioStates.at(-1).status, 'blocked');
  f.blockAudio(false);
  await f.coach.resumeAudio();
  assert.equal(f.audioStates.at(-1).status, 'playing');
  f.coach.reset();
  assert.equal(f.audios[0].paused, true);
  assert.deepEqual(f.revoked, ['blob:1']);
  const count = f.updates.length;
  f.audios[0].end();
  assert.equal(f.updates.length, count);
});

test('a cancelled speech blob cannot create or play stale audio', async () => {
  const f = fixture();
  f.coach.enqueue(rep(1), session(1));
  f.scores()[0].resolve(response(feedback()));
  await turn();
  let resolveBlob;
  f.speech()[0].resolve({ ok: true, blob: () => new Promise((resolve) => { resolveBlob = resolve; }) });
  await turn();
  f.coach.reset();
  resolveBlob(new Blob(['late audio']));
  await turn();
  assert.equal(f.created.length, 0);
  assert.equal(f.audios.length, 0);
});

test('analysis failures can be retried; speech failures preserve the written review', async () => {
  const f = fixture();
  f.coach.enqueue(rep(1), session(1));
  f.scores()[0].resolve(response({ error: 'Configure Gemini first.' }, false));
  await turn();
  assert.equal(f.reviews.get('1').status, 'error');
  assert.equal(f.coach.retry(rep(1), session(1)), true);
  f.scores()[1].resolve(response(feedback()));
  await turn();
  f.speech()[0].resolve(response({ error: 'Configure speech first.' }, false));
  await turn();
  assert.equal(f.reviews.get('1').status, 'complete');
  assert.equal(f.reviews.get('1').speechError, 'Configure speech first.');
  assert.equal(f.coach.retry(rep(1), session(1)), false);
  f.coach.dispose();
});

test('mute stops speech without cancelling analysis, and a new session cancels old work', async () => {
  const f = fixture();
  f.coach.enqueue(rep(1), session(1));
  f.scores()[0].resolve(response(feedback()));
  await turn();
  f.speech()[0].resolve(response(null));
  await turn();
  f.coach.setMuted(true);
  assert.equal(f.audios[0].paused, true);
  f.coach.enqueue(rep(2), session(2));
  f.scores()[1].resolve(response(feedback(2)));
  await turn();
  assert.equal(f.reviews.get('2').status, 'complete');
  assert.equal(f.speech().length, 1);
  f.coach.enqueue(rep(3), session(3));
  f.coach.enqueue(rep(4), session(1, 'another-set'));
  assert.equal(f.scores()[2].options.signal.aborted, true);
  f.coach.dispose();
  assert.equal(f.coach.enqueue(rep(5), session(2, 'another-set')), false);
});

test('unmuting does not revive an old response that predates a newer muted review', async () => {
  const f = fixture();
  f.coach.setMuted(true);
  f.coach.enqueue(rep(1), session(1));
  f.coach.enqueue(rep(2), session(2));
  f.scores()[1].resolve(response(feedback(2)));
  await turn();
  f.coach.setMuted(false);
  f.scores()[0].resolve(response(feedback(1)));
  await turn();
  assert.equal(f.speech().length, 0);
  assert.ok([...f.reviews.values()].every(({ status }) => status === 'complete'));
  f.coach.dispose();
});

test('finish barrier waits for queued and running reviews, reports failures, and supports retry', async () => {
  const f = fixture();
  f.coach.setMuted(true);
  for (let index = 1; index <= 3; index++) f.coach.enqueue({ ...rep(index), attemptId: 'account-attempt' }, session(index));
  assert.equal(JSON.parse(f.scores()[0].options.body).attemptId, 'account-attempt');
  let settled = false;
  const done = f.coach.waitForIdle().then((value) => { settled = true; return value; });
  f.scores()[0].resolve(response(feedback()));
  await turn();
  assert.equal(settled, false);
  f.scores()[1].resolve(response({ error: 'Temporary review failure' }, false));
  await turn();
  assert.equal(settled, false);
  f.scores()[2].resolve(response(feedback()));
  assert.deepEqual(await done, { cancelled: false, failedIds: ['2'] });
  assert.equal(f.coach.retry(rep(2), session(2)), true);
  const retried = f.coach.waitForIdle();
  f.scores()[3].resolve(response(feedback()));
  assert.deepEqual(await retried, { cancelled: false, failedIds: [] });
  f.coach.dispose();
});

test('generation reset cancels a pending finish barrier instead of reporting a successful new attempt', async () => {
  const f = fixture();
  f.coach.enqueue(rep(1), session(1));
  const old = f.coach.waitForIdle();
  f.coach.reset();
  f.coach.enqueue(rep(2), session(1, 'new-attempt'));
  assert.equal((await old).cancelled, true);
  f.coach.dispose();
});

test('motivational speech uses the same non-overlapping player and valid feedback payload', async () => {
  const f = fixture();
  f.coach.speak('One steady rep at a time.');
  assert.deepEqual(JSON.parse(f.speech()[0].options.body), { score: null, summary: 'One steady rep at a time.', tips: [] });
  f.speech()[0].resolve(response(null));
  await turn();
  assert.equal(f.audios[0].paused, false);
  f.coach.enqueue(rep(1), session(1));
  f.scores()[0].resolve(response(feedback()));
  await turn();
  assert.equal(f.speech().length, 1);
  f.audios[0].end();
  await turn();
  assert.equal(f.speech().length, 2);
  f.coach.dispose();
});

test('gesture-time unlocking plays valid silence synchronously and reuses that element for later feedback', async (t) => {
  const f = fixture();
  t.after(() => f.coach.dispose());
  const unlocking = f.coach.unlockAudio();
  assert.equal(f.audios.length, 1);
  const audio = f.audios[0];
  assert.equal(audio.plays, 1, 'play is invoked before the gesture handler returns');
  const wav = Buffer.from(audio.src.split(',')[1], 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.ok(wav.subarray(44).every((sample) => sample === 128));
  assert.equal(await unlocking, true);
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');
  f.coach.enqueue(rep(1), session(1));
  f.scores()[0].resolve(response(feedback()));
  await turn();
  f.speech()[0].resolve(response(null));
  await turn();
  assert.equal(f.audios.length, 1);
  assert.equal(audio.plays, 2);
  assert.equal(audio.paused, false);
  assert.equal(audio.src, 'blob:1');
  assert.equal(f.audioStates.at(-1).status, 'playing');
});

test('late silent-prime completion or rejection cannot clear or pause real feedback', async (t) => {
  for (const rejected of [false, true]) {
    const f = fixture();
    t.after(() => f.coach.dispose());
    const deferred = f.deferPlay();
    const unlocking = f.coach.unlockAudio();
    assert.equal(f.coach.readFeedback(feedback()), true);
    f.speech()[0].resolve(response(null));
    await turn();
    const audio = f.audios[0], pauses = audio.pauses, states = f.audioStates.length;
    assert.equal(audio.src, 'blob:1');
    assert.equal(audio.paused, false);
    if (rejected) deferred.reject(Object.assign(new Error('Old autoplay denial'), { name: 'NotAllowedError' }));
    else deferred.resolve();
    assert.equal(await unlocking, false);
    assert.equal(audio.src, 'blob:1');
    assert.equal(audio.paused, false);
    assert.equal(audio.pauses, pauses);
    assert.equal(f.audioStates.length, states);
    audio.dispatchEvent(new Event('ended'));
    assert.equal(f.audioStates.at(-1).status, 'playing', 'stale ended event does not end a new source');
    audio.end();
    assert.equal(f.audioStates.at(-1).status, 'idle');
  }
});

test('mute, reset and disposal invalidate a pending audio unlock without late changes', async (t) => {
  for (const action of ['mute', 'reset', 'dispose']) {
    const f = fixture();
    t.after(() => f.coach.dispose());
    const deferred = f.deferPlay();
    const unlocking = f.coach.unlockAudio();
    if (action === 'mute') f.coach.setMuted(true);
    else f.coach[action]();
    const audio = f.audios[0], pauses = audio.pauses, states = f.audioStates.length;
    assert.equal(audio.paused, true);
    assert.equal(audio.src, '');
    deferred.resolve();
    assert.equal(await unlocking, false);
    assert.equal(audio.pauses, pauses);
    assert.equal(audio.src, '');
    assert.equal(f.audioStates.length, states);
    if (action !== 'reset') {
      assert.equal(await f.coach.unlockAudio(), false);
      assert.equal(f.coach.readFeedback(feedback()), false);
      assert.equal(f.speech().length, 0);
    }
  }
});

test('a blocked prime can recover from a later gesture on the same prepared feedback element', async (t) => {
  const f = fixture();
  t.after(() => f.coach.dispose());
  f.blockAudio(true);
  assert.equal(await f.coach.unlockAudio(), false);
  assert.equal(f.audioStates.at(-1).status, 'blocked');
  f.coach.readFeedback(feedback(), { repId: '1', repNumber: 1 });
  f.speech()[0].resolve(response(null));
  await turn();
  assert.equal(f.audioStates.at(-1).status, 'blocked');
  assert.equal(f.audios[0].plays, 1, 'blocked feedback waits for the gesture');
  f.blockAudio(false);
  assert.equal(await f.coach.unlockAudio(), true);
  assert.equal(f.audios.length, 1);
  assert.equal(f.audios[0].paused, false);
  assert.equal(f.audioStates.at(-1).repId, '1');
  assert.equal(f.audioStates.at(-1).status, 'playing');
});

test('readFeedback replays saved feedback without re-analysis and accepts missing summaries', async (t) => {
  const f = fixture();
  t.after(() => f.coach.dispose());
  const saved = { score: 82, tips: [] };
  assert.equal(f.coach.readFeedback(saved, { repId: 'saved-rep', repNumber: 2 }), true);
  assert.equal(f.scores().length, 0);
  assert.deepEqual(JSON.parse(f.speech()[0].options.body), { ...saved, repNumber: 2 });
  f.speech()[0].resolve(response({ error: 'Temporary speech failure.' }, false));
  await turn();
  assert.equal(f.audioStates.at(-1).status, 'error');
  assert.equal(f.reviews.get('saved-rep').speechError, 'Temporary speech failure.');
  assert.equal(f.coach.readFeedback(saved, { repId: 'saved-rep', repNumber: 2 }), true);
  f.speech()[1].resolve(response(null));
  await turn();
  assert.equal(f.audios[0].paused, false);
  assert.equal(f.reviews.get('saved-rep').speechError, '');
  assert.equal(f.scores().length, 0);
  f.audios[0].end();
  assert.equal(f.coach.readFeedback({ score: null, tips: [] }), true, 'unscored legacy feedback uses server filming fallback');
  assert.equal(f.speech().length, 3);
});

test('explicit feedback reads finish the current narration and retain only the latest next request', async (t) => {
  const f = fixture();
  t.after(() => f.coach.dispose());
  f.coach.readFeedback(feedback(1), { repId: '1', repNumber: 1 });
  f.speech()[0].resolve(response(null));
  await turn();
  f.coach.readFeedback(feedback(2), { repId: '2', repNumber: 2 });
  f.coach.readFeedback(feedback(3), { repId: '3', repNumber: 3 });
  assert.equal(f.speech().length, 1);
  assert.equal(f.reviews.get('2').speechStatus, 'superseded');
  f.audios[0].end();
  await turn();
  assert.equal(f.speech().length, 2);
  assert.equal(JSON.parse(f.speech()[1].options.body).repNumber, 3);
  f.speech()[1].resolve(response(null));
  await turn();
  assert.equal(f.audios.length, 1);
  assert.equal(f.audios[0].paused, false);
  assert.equal(f.scores().length, 0);
});

test('invalid saved feedback and unavailable media support report errors without analysis', async (t) => {
  const f = fixture();
  t.after(() => f.coach.dispose());
  assert.equal(f.coach.readFeedback({ score: 101, tips: [] }), false);
  assert.equal(f.audioStates.at(-1).status, 'error');
  assert.equal(f.requests.length, 0);
  const states = [];
  const coach = createRepCoach({ audioFactory() { throw new Error('Audio unavailable'); }, onAudioState: (state) => states.push(state) });
  t.after(() => coach.dispose());
  assert.equal(await coach.unlockAudio(), false);
  assert.equal(states.at(-1).status, 'error');
});

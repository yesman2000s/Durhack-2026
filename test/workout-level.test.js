import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetRecording, describeTarget, parseRequestedLevel, selectLevel, workoutApi } from '../src/workout-level.js';

const progress = { tracks: [{ exerciseId: 'squat', baseline: 70, completedLevels: 1,
  target: { level: 2, reps: 2, minScore: 67, scoreToBeat: 73 },
  levels: [{ level: 1, status: 'completed' }, { level: 2, status: 'available' }, { level: 3, status: 'locked' }] }] };

test('level selection uses server availability and never advances a locked or completed request', () => {
  assert.equal(selectLevel(progress, 'squat').level, 2);
  assert.equal(selectLevel(progress, 'squat', 2).target, progress.tracks[0].target);
  assert.match(selectLevel(progress, 'squat', 1).error, /already complete/);
  assert.match(selectLevel(progress, 'squat', 3).error, /Complete level 2/);
  assert.equal(selectLevel(progress, 'push-up').target, undefined);
  assert.match(selectLevel({ tracks: [{ exerciseId: 'squat', target: null }] }, 'squat').error, /seven levels/);
});

test('URL levels reject fractional, missing, and out-of-range values', () => {
  assert.equal(parseRequestedLevel('?exercise=squat&level=7'), 7);
  for (const search of ['', '?level=', '?level=8', '?level=0', '?level=1.5', '?level=oops']) assert.equal(parseRequestedLevel(search), null);
  assert.match(describeTarget(progress.tracks[0].target), /2 reps at 67/);
});

test('API preserves server failures for retry and includes same-origin authentication', async () => {
  let options;
  await assert.rejects(workoutApi('/api/attempts', { method: 'POST' }, async (_, next) => {
    options = next;
    return { ok: false, status: 409, json: async () => ({ error: 'A rep is still being reviewed.' }) };
  }), (error) => error.status === 409 && error.message === 'A rep is still being reviewed.');
  assert.equal(options.credentials, 'same-origin');
});

test('set recording keeps the real video tracks, excludes audio, and waits for final data before saving', async () => {
  const videoTrack = { kind: 'video' };
  const audioTrack = { kind: 'audio' };
  let instance;
  class FakeStream { constructor(tracks) { this.tracks = tracks; } }
  class FakeRecorder extends EventTarget {
    static isTypeSupported(type) { return type === 'video/webm'; }
    constructor(stream, options) { super(); this.stream = stream; this.mimeType = options.mimeType; instance = this; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        const data = new Event('dataavailable');
        data.data = new Blob(['actual-video-bytes'], { type: this.mimeType });
        this.dispatchEvent(data);
        this.dispatchEvent(new Event('stop'));
      });
    }
  }
  const recording = createSetRecording({ getVideoTracks: () => [videoTrack], getTracks: () => [videoTrack, audioTrack] }, {
    MediaRecorderImpl: FakeRecorder, MediaStreamImpl: FakeStream,
  });
  assert.deepEqual(instance.stream.tracks, [videoTrack]);
  const stopped = recording.stop();
  assert.equal(recording.stop(), stopped, 'stopping twice must retain the same final recording');
  const { blob, error } = await stopped;
  assert.equal(await blob.text(), 'actual-video-bytes');
  assert.equal(blob.type, 'video/webm');
  assert.equal(error, '');
});

test('unsupported camera recording is explicit and does not substitute a simulated clip', () => {
  assert.equal(createSetRecording(null), null);
  assert.equal(createSetRecording({ getVideoTracks: () => [] }), null);
});

test('disconnected webcam waits for its queued final chunk even when the recorder is already inactive', async () => {
  let instance;
  class FakeRecorder extends EventTarget {
    constructor() { super(); instance = this; this.mimeType = 'video/webm'; }
    start() { this.state = 'recording'; }
    stop() { throw new Error('Already inactive'); }
  }
  const recording = createSetRecording({ getVideoTracks: () => [{}] }, { MediaRecorderImpl: FakeRecorder, MediaStreamImpl: null });
  instance.state = 'inactive';
  let settled = false;
  const result = recording.stop().then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false, 'inactive must not discard queued recording bytes');
  const data = new Event('dataavailable');
  data.data = new Blob(['last-frames']);
  instance.dispatchEvent(data);
  instance.dispatchEvent(new Event('stop'));
  assert.equal(await (await result).blob.text(), 'last-frames');
});

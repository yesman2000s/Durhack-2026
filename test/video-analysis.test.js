import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoAnalysis } from '../src/video-analysis.js';

class FakeVideo extends EventTarget {
  videoWidth = 1280;
  videoHeight = 720;
  duration = .12;
  time = 0;
  src = '';
  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = value;
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }
  load() {
    this.time = 0;
    if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadeddata')));
  }
  pause() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

function model() {
  return {
    closed: 0, samples: [],
    detectForVideo(video, time) { this.samples.push(time); return { landmarks: [[{ x: .5, y: .5 }]] }; },
    close() { this.closed += 1; },
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('replacing an upload cancels pending analysis and releases its model and URL', async (t) => {
  const revoked = [];
  let urlId = 0;
  t.mock.method(URL, 'createObjectURL', () => `blob:${++urlId}`);
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  const pending = [];
  const frames = [];
  let ended = 0;
  const analyzer = createVideoAnalysis(new FakeVideo(), {
    landmarkerFactory: () => new Promise((resolve) => pending.push(resolve)),
    onFrame: (frame) => frames.push(frame), onEnd: () => ended++,
    onError: (error) => assert.fail(error.message),
  });
  const first = analyzer.start({});
  await nextTurn();
  const second = analyzer.start({});
  await nextTurn();
  assert.deepEqual(revoked, ['blob:1']);
  assert.equal(pending.length, 2);
  const firstModel = model();
  pending[0](firstModel);
  await first;
  assert.equal(firstModel.closed, 1);
  assert.equal(firstModel.samples.length, 0);
  const secondModel = model();
  pending[1](secondModel);
  await second;
  assert.equal(secondModel.closed, 1);
  assert.equal(frames.length, 3);
  assert.equal(ended, 1);
  analyzer.stop();
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.equal(secondModel.closed, 1);
});

test('cancelling from progress does not publish a stale capture frame', async () => {
  const landmarker = model();
  let frames = 0;
  let ends = 0;
  const analyzer = createVideoAnalysis(new FakeVideo(), {
    landmarkerFactory: async () => landmarker,
    onProgress: () => analyzer.stop(),
    onFrame: () => frames++, onEnd: () => ends++,
    onError: (error) => assert.fail(error.message),
  });
  await analyzer.start(new Blob(['video']));
  assert.equal(frames, 0);
  assert.equal(ends, 0);
  assert.equal(landmarker.closed, 1);
});

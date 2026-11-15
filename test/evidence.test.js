import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureImage, framePose, makeEvidence } from '../src/evidence.js';

const metrics = {
  startKneeAngleDeg: 176, kneeAngleAtBottomDeg: 96, finishKneeAngleDeg: 173,
  torsoLeanAtBottomDeg: 32, descentMs: 2050, ascentMs: 970,
};

test('packages phase snapshots in motion order with a common capture clock', () => {
  const rep = { side: 'left', startedAtMs: 250, metrics, cues: [] };
  const images = new Map([['finish', { timestampMs: 3700 }], ['bottom', { timestampMs: 2300 }], ['start', { timestampMs: 100 }]]);
  const evidence = makeEvidence({ rep, images, captureStartMs: 100, source: 'simulated', camera: { width: 960, height: 540 } });
  assert.deepEqual(evidence.snapshots.map(({ phase, offsetMs }) => [phase, offsetMs]), [['start', 0], ['bottom', 2200], ['finish', 3600]]);
  assert.equal(evidence.movementStartOffsetMs, 150);
  assert.equal(evidence.metrics.kneeExcursionDeg, 80);
  assert.equal(evidence.metrics.returnAngleErrorDeg, 3);
  assert.equal(evidence.source, 'simulated');
  assert.equal(Object.hasOwn(evidence, 'videoStartOffsetMs'), false);
});

test('video exports preserve the source offset without changing the rep clock', () => {
  const images = new Map([['start', { timestampMs: 4083.333 }], ['finish', { timestampMs: 6183.333 }]]);
  const rep = { side: 'left', startedAtMs: 4583.333, returnedAtMs: 6083.333, metrics };
  const evidence = makeEvidence({ rep, images, captureStartMs: 4083.333, source: 'video' });
  assert.equal(evidence.videoStartOffsetMs, 4083);
  assert.equal(evidence.movementStartOffsetMs, 500);
  assert.deepEqual(evidence.snapshots.map(({ offsetMs }) => offsetMs), [0, 2100]);
});

test('exports exercise measurements and marks only the guided attempt', () => {
  const rep = {
    exercise: 'push-up', side: 'right', startedAtMs: 250, returnedAtMs: 1700,
    metrics: { range: 55, rangeUnit: 'degrees', outwardMs: 700, returnMs: 750 }, cues: [],
  };
  const args = { rep, images: new Map(), captureStartMs: 100, source: 'webcam', camera: { width: 960, height: 540 } };
  const evidence = makeEvidence({ ...args, trainingGuide: true });
  assert.equal(evidence.exercise, 'push-up');
  assert.equal(evidence.trainingGuide, true);
  assert.deepEqual(evidence.metrics, rep.metrics);
  assert.equal(Object.hasOwn(makeEvidence(args), 'trainingGuide'), false);
});

test('preserves 720p snapshot detail and resizes larger frames with the correct aspect ratio', () => {
  const calls = [];
  const ctx = { drawImage(...args) { calls.push(args); } };
  const canvas = {
    width: 0, height: 0,
    getContext() { return ctx; },
    toDataURL(format, quality) {
      assert.equal(format, 'image/jpeg');
      assert.equal(quality, .9);
      return 'data:image/jpeg;base64,cGhvdG8=';
    },
  };
  const source = {};
  assert.deepEqual(captureImage(source, 1280, 720, canvas), {
    url: 'data:image/jpeg;base64,cGhvdG8=', width: 1280, height: 720,
  });
  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.equal(ctx.imageSmoothingQuality, 'high');
  assert.deepEqual(calls.at(-1), [source, 0, 0, 1280, 720]);
  const portrait = captureImage(source, 2160, 3840, canvas);
  assert.deepEqual([portrait.width, portrait.height], [720, 1280]);
  const small = captureImage(source, 320, 240, canvas);
  assert.deepEqual([small.width, small.height], [320, 240]);
});

test('omits unavailable images instead of exporting a blank or invalid-sized JPEG', () => {
  const canvas = { getContext() { throw new Error('Must not encode'); } };
  for (const [width, height] of [[0, 720], [1280, -1], [NaN, 720], [1280, Infinity]]) {
    assert.equal(captureImage({}, width, height, canvas), null);
  }
  assert.equal(captureImage({ readyState: 1 }, 1280, 720, canvas), null);
  assert.equal(captureImage(null, 1280, 720, canvas), null);
});

test('snapshot poses retain presence confidence for optional joints', () => {
  const landmarks = [];
  landmarks[15] = { x: .4, y: .5, visibility: .9, presence: .1 };
  landmarks[29] = { x: .5, y: .8, visibility: .9, presence: NaN };
  landmarks[31] = { x: .6, y: .8, visibility: .9 };
  const { joints } = framePose({ landmarks }, { side: 'left' });
  assert.equal(joints.wrist.presence, .1);
  assert.equal(joints.heel.presence, 0);
  assert.equal(Object.hasOwn(joints.toe, 'presence'), false);
});

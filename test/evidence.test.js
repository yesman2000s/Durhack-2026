import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvidence } from '../src/evidence.js';

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

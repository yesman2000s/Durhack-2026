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
});

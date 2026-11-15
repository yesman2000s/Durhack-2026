import test from 'node:test';
import assert from 'node:assert/strict';
import { framePose, makeEvidence } from '../src/evidence.js';
import { measureThighToShin } from '../src/leg-proportions.js';
import { makeMotionTrace, recordPose } from '../src/motion-trace.js';

function frame(timestampMs, hipX = 0.3) {
  const landmarks = [];
  landmarks[24] = { x: hipX, y: 0.5, visibility: 0.9 };
  landmarks[26] = { x: 0.5, y: 0.5, visibility: 0.9 };
  landmarks[28] = { x: 0.5, y: 0.7, visibility: 0.9 };
  return { timestampMs, width: 1920, height: 1080, landmarks };
}

test('measures both segments in source pixels on the tracked side', () => {
  const widescreen = frame(0);
  assert.equal(measureThighToShin(widescreen, 'right'), 1.778);
  assert.equal(measureThighToShin({ ...widescreen, width: 1080 }, 'right'), 1);
  assert.equal(measureThighToShin(widescreen, 'left'), null);
  widescreen.landmarks[28].visibility = 0.1;
  assert.equal(measureThighToShin(widescreen, 'right'), null);
  widescreen.landmarks[28] = { ...widescreen.landmarks[26] };
  assert.equal(measureThighToShin(widescreen, 'right'), null);
});

test('does not measure a high-visibility leg with low or invalid presence confidence', () => {
  const sample = frame(0);
  for (const presence of [.1, NaN, Infinity]) {
    sample.landmarks[26].presence = presence;
    assert.equal(measureThighToShin(sample, 'right'), null);
  }
  sample.landmarks[26].presence = .9;
  assert.equal(measureThighToShin(sample, 'right'), 1.778);
});

test('exports a per-image ratio and uses the median during movement for the rep', () => {
  const live = { side: 'right' };
  const trace = [];
  for (const sample of [frame(100, 0.3), frame(600, 0.33), frame(700, 0.4), frame(800, 0.35), frame(900, 0.1)]) {
    recordPose(trace, sample, live);
  }
  const pose = framePose(frame(800, 0.35), live);
  const rep = { startedAtMs: 600, returnedAtMs: 800, side: 'right', metrics: { standingThighToShinRatio: 1.778 }, cues: [] };
  const images = new Map([['bottom', { timestampMs: 800, pose }]]);
  const evidence = makeEvidence({ rep, images, motionTrace: makeMotionTrace(trace, 100, 600), captureStartMs: 100 });
  assert.equal(evidence.snapshots[0].pose.thighToShinRatio, 1.333);
  assert.equal(evidence.motionTrace.frames.at(-1).thighToShinRatio, 3.556);
  assert.equal(evidence.metrics.thighToShinRatio, 1.333);
  assert.equal(evidence.metrics.standingThighToShinRatio, 1.778);
});

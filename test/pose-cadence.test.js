import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPoseSampleTime, POSE_SAMPLE_INTERVAL_MS } from '../src/pose-cadence.js';

test('samples at about 12 Hz from common camera rates without drifting to a slower divisor', () => {
  for (const cameraFps of [24, 25, 30, 60]) {
    let deadline = 0;
    const samples = [];
    for (let i = 0; i < cameraFps * 5; i++) {
      const now = i * 1000 / cameraFps;
      if (now + 4 < deadline) continue;
      samples.push(now);
      deadline = nextPoseSampleTime(deadline, now);
    }
    assert.equal(samples.length, 60, `camera fps ${cameraFps}`);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i] - samples[i - 1] < 130, `camera fps ${cameraFps}`);
    }
  }
});

test('skips obsolete sample opportunities after a stall', () => {
  const now = 1_026;
  const next = nextPoseSampleTime(100, now);
  assert.ok(next > now && next <= now + POSE_SAMPLE_INTERVAL_MS);
});

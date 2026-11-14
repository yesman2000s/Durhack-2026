import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMotionTrace, poseAtTime, recordPose } from '../src/motion-trace.js';
import { demoLandmarks } from '../src/demo.js';

test('keeps the original standing sample and finishes the trace on the captured return', () => {
  const trace = [];
  const live = { side: 'left', torsoLeanDeg: 10 };
  for (const timestampMs of [100, 350, 750, 1050, 1450, 1470]) {
    recordPose(trace, { timestampMs, landmarks: demoLandmarks(timestampMs === 1050 ? 0.7 : 0) }, live, timestampMs === 1470);
  }

  const playback = makeMotionTrace(trace, 100, 900);
  assert.deepEqual(playback.frames.map(({ offsetMs }) => offsetMs), [0, 650, 950, 1350, 1370]);
  assert.ok(playback.frames[2].joints.hip.y > playback.frames[0].joints.hip.y);
  assert.deepEqual(playback.frames.at(-1).joints, playback.frames[0].joints);
});

test('replay bridges short gaps and leaves missing portions of the movement blank', () => {
  const first = { x: 0.25, y: 0.5, visibility: 0.9 };
  const second = { x: 0.5, y: 0.75, visibility: 0.8 };
  const frames = [
    { offsetMs: 0, joints: { hip: first } },
    { offsetMs: 100, joints: { hip: second } },
    { offsetMs: 500, joints: { hip: first } },
  ];
  assert.deepEqual(poseAtTime(frames, 50).hip, { x: 0.375, y: 0.625, visibility: 0.8 });
  assert.equal(poseAtTime(frames, 300), null);
  assert.deepEqual(poseAtTime(frames, 500).hip, first);
});

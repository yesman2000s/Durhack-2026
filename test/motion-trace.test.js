import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaybackJointVisible, makeMotionTrace, poseAtTime, recordPose, traceJoints } from '../src/motion-trace.js';
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

test('replay eases into a measured reversal without overshooting or changing the trace', () => {
  const frames = [0.2, 0.5, 0.75, 0.5].map((y, index) => ({
    offsetMs: [0, 75, 170, 265][index],
    joints: { hip: { x: 0.5, y, visibility: 0.9 } },
  }));
  const original = structuredClone(frames);
  const beforeBottom = poseAtTime(frames, 160).hip.y;
  assert.ok(beforeBottom > 0.73 && beforeBottom < 0.75);
  let last = 0.5;
  for (let time = 76; time <= 170; time++) {
    const { y } = poseAtTime(frames, time).hip;
    assert.ok(y >= last && y <= 0.75);
    last = y;
  }
  assert.equal(poseAtTime(frames, 170).hip.y, 0.75);
  assert.ok(poseAtTime(frames, 180).hip.y > 0.73);
  assert.deepEqual(frames, original);
});

test('replay leaves an unreliable joint out of interpolated poses', () => {
  const joint = { x: 0.25, y: 0.5, visibility: 0.9 };
  const frames = [
    { offsetMs: 0, joints: { hip: joint, knee: joint } },
    { offsetMs: 80, joints: { hip: { ...joint, y: 0.6 }, knee: { ...joint, visibility: 0.2 } } },
  ];
  const joints = poseAtTime(frames, 40);
  assert.ok(joints.hip);
  assert.equal(joints.knee, undefined);
});

test('capture and replay preserve presence so an uncertain optional joint stays hidden', () => {
  const landmarks = demoLandmarks(0);
  landmarks[15].presence = .12;
  landmarks[13].visibility = NaN;
  landmarks[23].presence = .8;
  const joints = traceJoints(landmarks, 'left');
  assert.equal(joints.wrist.presence, .12);
  assert.equal(isPlaybackJointVisible('wrist', joints.wrist), false);
  assert.equal(isPlaybackJointVisible('elbow', joints.elbow), false);
  const frames = [
    { offsetMs: 0, joints },
    { offsetMs: 80, joints: { ...joints, hip: { ...joints.hip, presence: .7 } } },
  ];
  assert.equal(poseAtTime(frames, 40).wrist, undefined);
  assert.equal(poseAtTime(frames, 40).hip.presence, .7);
  assert.equal(isPlaybackJointVisible('hip', { x: .5, y: .5, visibility: .9, presence: NaN }), false);
});

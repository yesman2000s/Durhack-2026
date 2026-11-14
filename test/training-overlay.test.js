import assert from 'node:assert/strict';
import test from 'node:test';
import { demoLandmarks } from '../src/demo.js';
import { mobilityDemoLandmarks } from '../src/mobility-demo.js';
import { createTrainingOverlay, guidePlaybackTimes } from '../src/training-overlay.js';

function overlayFixture(t) {
  const pending = new Map();
  let nextId = 0;
  let time = 0;
  t.mock.method(performance, 'now', () => time);
  const request = (callback) => {
    pending.set(++nextId, callback);
    return nextId;
  };
  const cancel = (id) => pending.delete(id);
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = request;
  globalThis.cancelAnimationFrame = cancel;
  t.after(() => {
    if (previousRequest) globalThis.requestAnimationFrame = previousRequest;
    else delete globalThis.requestAnimationFrame;
    if (previousCancel) globalThis.cancelAnimationFrame = previousCancel;
    else delete globalThis.cancelAnimationFrame;
  });

  const lineEndpoints = [];
  let clears = 0;
  const ctx = {
    clearRect() { clears++; lineEndpoints.length = 0; },
    lineTo(x, y) { lineEndpoints.push([x, y]); },
    beginPath() {}, moveTo() {}, arc() {}, setLineDash() {}, stroke() {}, fill() {},
  };
  const canvas = { width: 960, height: 540, getContext: () => ctx };
  const overlay = createTrainingOverlay(canvas);
  const step = (ms) => {
    time = ms;
    const [id, callback] = [...pending][0];
    pending.delete(id);
    callback(ms);
  };
  return { canvas, overlay, step, pending, lineEndpoints, clearCount: () => clears };
}

test('training overlay draws one exercise, preserves source landmarks and clears on cancel', (t) => {
  const { overlay, canvas, step, pending, lineEndpoints, clearCount } = overlayFixture(t);
  const landmarks = demoLandmarks(0);
  const recorded = structuredClone(landmarks);
  const frame = { landmarks, width: 960, height: 540, crop: { left: 220, width: 520 } };
  let ended = 0;

  assert.equal(overlay.start(frame, 'left', 'knee-raise', 'bodyweight', () => ended++), true);
  assert.equal(canvas.width, 520);
  step(100);
  assert.ok(lineEndpoints.length >= 8);
  const startingPose = structuredClone(lineEndpoints);
  step(1900);
  assert.notDeepEqual(lineEndpoints, startingPose);
  step(4800);
  assert.equal(ended, 1);
  assert.equal(pending.size, 0);
  assert.equal(lineEndpoints.length, 0);
  assert.deepEqual(landmarks, recorded);

  assert.equal(overlay.start(frame, 'right', 'heel-raise', 'bodyweight', () => ended++), true);
  step(4900);
  const beforeCancel = clearCount();
  overlay.clear();
  assert.equal(clearCount(), beforeCancel + 1);
  assert.equal(pending.size, 0);
  assert.equal(ended, 1);
  assert.equal(overlay.start({ ...frame, landmarks: null }, 'right', 'heel-raise'), false);
});

test('squat illustration follows reliable horizontal foot motion and holds its floor through dropped frames', (t) => {
  const { overlay, step, lineEndpoints } = overlayFixture(t);
  const width = 960;
  const height = 540;
  const standing = demoLandmarks(0);
  const frame = { landmarks: standing, width, height, crop: { left: 220, width: 520 } };
  const update = (timestampMs, landmarks, side = 'left') => overlay.update({ ...frame, timestampMs, landmarks }, side);
  const ankle = () => lineEndpoints[5];
  function steppedPose(left, right, foot) {
    const pose = demoLandmarks(.72);
    for (const [sideOffset, distance] of [[0, left], [1, right]]) {
      for (const index of [27, 29, 31]) {
        const joint = pose[index + sideOffset];
        joint.x += distance / width;
        joint.y += foot / height;
      }
    }
    return pose;
  }

  assert.equal(overlay.start(frame, 'left', 'squat'), true);
  step(15);
  const [startX, floorY] = ankle();
  update(80, steppedPose(32, -50, 31));
  step(100);
  const [followingX, followingY] = ankle();
  assert.ok(followingX > startX + 5 && followingX < startX + 32);
  assert.equal(followingY, floorY);

  update(150, null);
  update(170, steppedPose(-30, -50, 12), 'right');
  const disagreement = steppedPose(-30, 0, 12);
  disagreement[27].x += 90 / width;
  disagreement[31].visibility = .1;
  update(190, disagreement);
  step(200);
  assert.deepEqual(ankle(), [followingX, floorY]);

  const reliable = steppedPose(32, -50, 0);
  reliable[27].x += 120 / width;
  update(250, reliable);
  step(275);
  const [resumedX, resumedY] = ankle();
  assert.ok(resumedX > followingX && resumedX < startX + 32);
  assert.equal(resumedY, floorY);

  for (let timestampMs = 375; timestampMs <= 975; timestampMs += 100) {
    update(timestampMs, steppedPose(100, -50, 0));
  }
  step(1000);
  const [boundedX, boundedY] = ankle();
  assert.ok(boundedX > resumedX && boundedX < startX + 47);
  assert.equal(boundedY, floorY);
});

test('the floor push-up guide lowers around fixed contacts and mirrors with the tracked side', (t) => {
  const { overlay, step, lineEndpoints } = overlayFixture(t);
  const width = 960;
  const height = 540;
  for (const [index, side, offset] of [[0, 'left', 0], [1, 'right', 1]]) {
    const landmarks = mobilityDemoLandmarks(0, 'push-up');
    if (offset) for (const point of landmarks) point.x = 1 - point.x;
    assert.equal(overlay.start({ landmarks, width, height }, side, 'push-up'), true);
    const start = index * 2100;
    step(start);
    const [startingShoulder, , wrist, , , , , toe] = structuredClone(lineEndpoints);
    step(start + 2100);
    const [bottomShoulder, , bottomWrist, , , , , bottomToe] = lineEndpoints;

    assert.ok(bottomShoulder[1] > startingShoulder[1] + 35);
    assert.deepEqual(bottomWrist, wrist);
    assert.deepEqual(bottomToe, toe);
    assert.equal(Math.sign(wrist[0] - toe[0]), side === 'left' ? 1 : -1);
    assert.ok(Math.abs(wrist[0] - landmarks[15 + offset].x * width) < .1);
    assert.ok(Math.abs(toe[1] - landmarks[31 + offset].y * height) < .1);
    overlay.clear();
  }
});

test('source-time playback shows a guide with an obscured toe and supports backward scrubbing', (t) => {
  const { overlay, canvas, pending, lineEndpoints } = overlayFixture(t);
  const landmarks = mobilityDemoLandmarks(0, 'push-up');
  landmarks[31].visibility = .1;
  landmarks[32].visibility = .1;
  const frame = { width: 960, height: 540, crop: { left: 340, width: 260 }, landmarks, timestampMs: 9000 };
  assert.equal(overlay.start(frame, 'left', 'push-up', 'bodyweight', undefined, { manual: true }), true);
  assert.equal(pending.size, 0);
  assert.ok(lineEndpoints.length > 5);
  const standing = structuredClone(lineEndpoints);
  assert.equal(overlay.renderAt(guidePlaybackTimes.lowerEndMs), true);
  assert.notDeepEqual(lineEndpoints, standing);
  assert.ok(lineEndpoints.every(([x, y]) => x >= 0 && x <= canvas.width && y >= 0 && y <= canvas.height));
  assert.equal(overlay.renderAt(0), true);
  assert.deepEqual(lineEndpoints, standing);
  overlay.clear();
  assert.equal(overlay.renderAt(0), false);
});

test('a live guide can stay visible after its demonstration until the rep ends', (t) => {
  const { overlay, step, pending, lineEndpoints } = overlayFixture(t);
  const frame = { width: 960, height: 540, landmarks: demoLandmarks(0) };
  let ended = 0;
  assert.equal(overlay.start(frame, 'left', 'squat', 'bodyweight', () => ended++, { keepAfterEnd: true }), true);
  step(0);
  const standing = structuredClone(lineEndpoints);
  step(2100);
  assert.notDeepEqual(lineEndpoints, standing);
  step(4800);
  assert.equal(pending.size, 0);
  assert.deepEqual(lineEndpoints, standing);
  assert.equal(ended, 0);
  overlay.clear();
  assert.equal(lineEndpoints.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCameraFrame } from '../src/camera-frame.js';

test('freezes full-frame pixels before inference and snapshot selection', () => {
  const source = { readyState: 2, pixels: 'standing' };
  const reads = [];
  const canvas = {
    width: 0, height: 0,
    getContext() { return { drawImage(input, ...bounds) { canvas.pixels = input.pixels; reads.push(bounds); } }; },
  };
  const captured = copyCameraFrame(source, 1280, 720, canvas);
  source.pixels = 'lowering';
  assert.equal(captured.pixels, 'standing');
  assert.deepEqual(reads, [[0, 0, 1280, 720]]);
  assert.equal(captured.width, 1280);
  assert.equal(captured.height, 720);
  assert.equal(copyCameraFrame(source, 1280, 720, canvas), captured);
  assert.equal(captured.pixels, 'lowering');
});

test('does not reuse stale pixels when a camera frame is unavailable', () => {
  const canvas = { getContext() { throw new Error('Must not draw'); } };
  assert.equal(copyCameraFrame({ readyState: 1 }, 1280, 720, canvas), null);
  assert.equal(copyCameraFrame({}, 0, 720, canvas), null);
  assert.equal(copyCameraFrame({}, 1280, NaN, canvas), null);
  assert.equal(copyCameraFrame({}, Infinity, 720, canvas), null);
});

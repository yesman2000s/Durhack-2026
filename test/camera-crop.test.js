import test from 'node:test';
import assert from 'node:assert/strict';
import { centerCameraCrop, poseInCenter, sourceLandmarks } from '../src/camera-crop.js';

test('maps the centered landscape crop to the full snapshot without stretching it', () => {
  const crop = centerCameraCrop(1280, 720);
  assert.deepEqual(crop, { left: 298, width: 684 });
  const landmarks = [
    { x: 0.25, y: 0.5, z: 0.1, visibility: 0.9 },
    { x: 1.03, y: 0.6, z: 0.2, visibility: 0.9 },
  ];
  const result = sourceLandmarks(landmarks, 1280, crop);
  assert.equal(result[0].x * 1280, 469);
  assert.equal(result[0].y, 0.5);
  assert.equal(result[0].z, 0.1 * 684 / 1280);
  assert.equal(result[0].visibility, 0.9);
  assert.equal(result[1].visibility, 0);
  assert.equal(landmarks[1].visibility, 0.9);
});

test('the setup guide accepts a central stance and leaves portrait cameras unchanged', () => {
  const landmarks = [];
  landmarks[23] = { x: 0.48, visibility: 0.9 };
  landmarks[27] = { x: 0.52, visibility: 0.9 };
  const crop = centerCameraCrop(1280, 720);
  assert.equal(poseInCenter(landmarks, 1280, crop), true);
  landmarks[23].x = 0.28;
  landmarks[27].x = 0.3;
  assert.equal(poseInCenter(landmarks, 1280, crop), false);

  const portraitCrop = centerCameraCrop(450, 800);
  assert.deepEqual(portraitCrop, { left: 0, width: 450 });
  assert.equal(poseInCenter(landmarks, 450, portraitCrop), true);
  assert.equal(sourceLandmarks(landmarks, 450, portraitCrop), landmarks);
});

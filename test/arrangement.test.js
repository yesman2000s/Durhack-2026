import test from 'node:test';
import assert from 'node:assert/strict';
import { visualSlots, moveClipPositions, dragSlot } from '../src/music/arrangement.js';

const track = (exerciseId, completed = 2) => ({ exerciseId, levels: Array.from({ length: 7 }, (_, index) => ({
  level: index + 1, status: index < completed ? 'completed' : index === completed ? 'available' : 'locked',
})) });

test('completed clips own saved slots and future levels fill every remaining space once', () => {
  const squat = track('squat');
  const slots = visualSlots(squat, { 'squat:1': 5, 'squat:2': 3, 'squat:3': 6 });
  assert.equal(slots[1], 5);
  assert.equal(slots[2], 3);
  assert.equal(slots[3], 2);
  assert.deepEqual(Object.values(slots).sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(squat.levels.map(({ level }) => level), [1, 2, 3, 4, 5, 6, 7]);
});

test('invalid, duplicate and conflicting slots are normalized without covering a clip', () => {
  const squat = track('squat', 4);
  squat.levels.push({ level: 1, status: 'completed' }, { level: 99, status: 'completed' });
  const slots = visualSlots(squat, { 'squat:1': -1, 'squat:2': 1.5, 'squat:3': 6, 'squat:4': 6 });
  assert.deepEqual(Object.values(slots).sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(slots[1], 0);
  assert.equal(slots[2], 1);
  assert.equal(slots[3], 6);
  assert.equal(slots[4], 2);
  assert.deepEqual(visualSlots(null), {});
});

test('moving onto another unlocked clip swaps them and retains other instruments', () => {
  const tracks = [track('squat'), track('push-up', 3)];
  const positions = { 'squat:1': 4, 'squat:2': 1, 'push-up:1': 6 };
  const original = structuredClone(tracks);
  const moved = moveClipPositions(tracks, positions, 'squat', 1, 1);
  assert.equal(moved['squat:1'], 1);
  assert.equal(moved['squat:2'], 4);
  assert.equal(moved['push-up:1'], 6);
  assert.equal(moved['push-up:2'], 1);
  assert.deepEqual(positions, { 'squat:1': 4, 'squat:2': 1, 'push-up:1': 6 });
  assert.deepEqual(tracks, original);
});

test('moving into a future slot persists only unlocked notes and future clips remain reachable', () => {
  const tracks = [track('squat')];
  const positions = { 'squat:7': 4, 'unknown:1': 3 };
  const moved = moveClipPositions(tracks, positions, 'squat', 1, 99);
  assert.deepEqual(moved, { 'squat:1': 6, 'squat:2': 1 });
  const slots = visualSlots(tracks[0], moved);
  assert.deepEqual(Object.values(slots).sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(slots[7], 0);
  assert.deepEqual(moveClipPositions(tracks, moved, 'squat', 1, -20), { 'squat:1': 0, 'squat:2': 1 });
});

test('locked, missing, invalid and unchanged moves do not cause a settings write', () => {
  const tracks = [track('squat')];
  const positions = { 'squat:1': 0 };
  for (const [exerciseId, level, slot] of [['squat', 1, 0], ['squat', 3, 2], ['missing', 1, 2], ['squat', 1.5, 2], ['squat', 1, NaN]]) {
    assert.equal(moveClipPositions(tracks, positions, exerciseId, level, slot), positions);
  }
});

test('horizontal dragging snaps symmetrically, includes scroll distance and stays within the lane', () => {
  assert.equal(dragSlot(3, 49, 100), 3);
  assert.equal(dragSlot(3, 50, 100), 4);
  assert.equal(dragSlot(3, -50, 100), 2);
  assert.equal(dragSlot(1, 20 + 180, 100), 3);
  assert.equal(dragSlot(1, -500, 100), 0);
  assert.equal(dragSlot(5, 500, 100), 6);
  assert.equal(dragSlot(2, NaN, 100), 2);
  assert.equal(dragSlot(2, 500, 0), 2);
  assert.equal(dragSlot(NaN, 20, 100), 0);
});

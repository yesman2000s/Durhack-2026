import test from 'node:test';
import assert from 'node:assert/strict';
import { SquatTracker } from '../src/squat-tracker.js';
import { MobilityTracker } from '../src/mobility-tracker.js';
import { demoLandmarks } from '../src/demo.js';
import { exampleProgress, mobilityDemoLandmarks } from '../src/mobility-demo.js';

const exercises = ['squat', 'push-up', 'knee-raise', 'heel-raise'];
const trackerFor = (exercise) => exercise === 'squat' ? new SquatTracker() : new MobilityTracker(exercise);
const poseFor = (exercise, progress) => exercise === 'squat' ? demoLandmarks(progress) : mobilityDemoLandmarks(progress, exercise);

for (const exercise of exercises) {
  test(`${exercise} captures consecutive set reps without repeating a full setup hold`, () => {
    const tracker = trackerFor(exercise);
    const events = [];
    for (let timestampMs = 0; timestampMs <= 10720; timestampMs += 80) {
      const elapsed = timestampMs - 1440;
      // Only 550ms at the top between cycles, less than the 1s setup hold.
      const progress = elapsed < 0 ? 0 : exampleProgress(elapsed % 4600);
      const state = tracker.update({ landmarks: poseFor(exercise, progress), timestampMs,
        width: 960, height: 540, armed: true, continuous: true });
      events.push(...state.events);
    }
    const reps = events.filter(({ type }) => type === 'rep-complete').map(({ rep }) => rep);
    assert.equal(reps.length, 2);
    assert.equal(events.filter(({ type }) => type === 'rep-discarded').length, 0);
    assert.deepEqual(reps.map(({ id }) => id), [1, 2]);
    for (const rep of reps) {
      assert.deepEqual(rep.frames.map(({ phase }) => phase), ['start', 'descent', 'bottom', 'ascent', 'finish']);
      assert.ok(rep.startedAtMs < rep.returnedAtMs);
      assert.ok(rep.frames.every(({ timestampMs }, index) => index === 0 || timestampMs >= rep.frames[index - 1].timestampMs));
    }
    assert.ok(reps[1].startedAtMs > reps[0].finishedAtMs);
  });
}

test('continuous capture remains opt-in for mobility and clears on reset', () => {
  for (const continuous of [false, true]) {
    const tracker = new MobilityTracker('push-up');
    let completed = false;
    for (let timestampMs = 0; timestampMs < 6500; timestampMs += 80) {
      const state = tracker.update({ landmarks: poseFor('push-up', exampleProgress(timestampMs - 1440)),
        timestampMs, width: 960, height: 540, continuous });
      if (state.events.some(({ type }) => type === 'rep-complete')) {
        assert.equal(Boolean(tracker.reference), continuous);
        completed = true;
        break;
      }
    }
    assert.equal(completed, true);
    tracker.reset();
    assert.equal(tracker.reference, null);
    assert.equal(tracker.continuous, false);
  }
});

test('a missing-pose gap still requires calibration in continuous capture', () => {
  const tracker = new MobilityTracker('push-up');
  for (let timestampMs = 0; timestampMs <= 1440; timestampMs += 80) {
    tracker.update({ landmarks: poseFor('push-up', 0), timestampMs, width: 960, height: 540, continuous: true });
  }
  assert.ok(tracker.reference);
  tracker.update({ landmarks: null, timestampMs: 2000, width: 960, height: 540, continuous: true });
  assert.equal(tracker.reference, null);
  const state = tracker.update({ landmarks: poseFor('push-up', 0), timestampMs: 2080,
    width: 960, height: 540, continuous: true });
  assert.equal(state.setup.ready, false);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exampleProgress, mobilityDemoLandmarks } from '../src/mobility-demo.js';
import { MobilityTracker } from '../src/mobility-tracker.js';

const WIDTH = 960;
const HEIGHT = 540;
const START = 3900;
const EXERCISES = ['push-up', 'knee-raise', 'heel-raise'];

function oppositeSide(points) {
  for (const point of points) point.x = 1 - point.x;
  for (const index of [11, 13, 15, 23, 25, 27, 29, 31]) {
    [points[index], points[index + 1]] = [points[index + 1], points[index]];
  }
}

const fixtures = [
  ...EXERCISES.map((exercise) => ({ exercise, name: exercise, expectedSide: 'left' })),
  { exercise: 'push-up', name: 'mirrored floor push-up', adjust: oppositeSide, expectedSide: 'right' },
  { exercise: 'knee-raise', name: 'opposite profile', adjust: oppositeSide, expectedSide: 'right' },
  { exercise: 'heel-raise', name: 'brief pose loss', loss: [4800, 4940], expectedSide: 'left' },
  { exercise: 'push-up', name: 'sustained pose loss', loss: [4800, 5400], expectedDiscard: 'tracking-gap' },
  { exercise: 'knee-raise', name: 'partial return', progress: (elapsed) => elapsed > 2400 ? Math.max(0.4, exampleProgress(elapsed)) : exampleProgress(elapsed) },
  {
    exercise: 'push-up', name: 'slow setup drift', expectedSide: 'left', minimumReadyAt: 2000,
    adjust(points, time) {
      for (const point of points) point.x += 60 * Math.min(1, time / 1200) / WIDTH;
    },
  },
];

const cases = fixtures.map(({ exercise, name, expectedSide, expectedDiscard, adjust, loss, progress = exampleProgress, minimumReadyAt = 1000 }) => {
  const tracker = new MobilityTracker(exercise);
  const frames = [];
  const expected = [];
  let armed = false;
  for (let time = 0; time <= 10000; time += 83) {
    const missing = loss && time >= loss[0] && time < loss[1];
    const landmarks = missing ? null : mobilityDemoLandmarks(progress(time - START), exercise);
    if (landmarks) adjust?.(landmarks, time);
    const frame = { landmarks, timestampMs: time, width: WIDTH, height: HEIGHT, armed };
    frames.push(frame);
    const state = tracker.update(frame);
    expected.push(state);
    if (state.setup.ready) armed = true;
  }
  const firstReady = expected.findIndex(({ setup }) => setup.ready);
  assert.ok(firstReady >= 0 && frames[firstReady].timestampMs >= minimumReadyAt, name);
  const events = expected.flatMap((state) => state.events);
  const completed = events.filter(({ type }) => type === 'rep-complete');
  assert.equal(completed.length, expectedSide ? 1 : 0, name);
  assert.equal(completed[0]?.rep.side, expectedSide, name);
  assert.equal(events.find(({ type }) => type === 'rep-discarded')?.reason, expectedDiscard, name);
  if (expectedSide) {
    assert.deepEqual(completed[0].rep.frames.map(({ phase }) => phase), ['start', 'descent', 'bottom', 'ascent', 'finish'], name);
  }
  return { exercise, name, frames, expected };
});

const compareInPython = String.raw`
import json
import sys
sys.path.insert(0, 'python')
from mobility_tracker import MobilityTracker

for case in json.load(sys.stdin):
    tracker = MobilityTracker(case['exercise'])
    for frame, expected in zip(case['frames'], case['expected'], strict=True):
        actual = tracker.update(frame['landmarks'], frame['timestampMs'], frame['width'], frame['height'], armed=frame['armed'])
        if actual != expected:
            raise AssertionError((case['name'], frame['timestampMs'], actual, expected))
    print(f"{case['name']}: {len(case['frames'])} frames match")
`;

const result = spawnSync(process.argv[2] ?? 'python', ['-B', '-X', 'utf8', '-c', compareInPython], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  input: JSON.stringify(cases),
  encoding: 'utf8',
});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { demoLandmarks } from "../src/demo.js";
import { SquatTracker } from "../src/squat-tracker.js";

const smooth = (fraction) => (1 - Math.cos(Math.PI * fraction)) / 2;

function frameDepth(time) {
  if (time < 0) return 0;
  if (time < 1900) return smooth(time / 1900);
  if (time < 2250) return 1;
  if (time < 3400) return 1 - smooth((time - 2250) / 1150);
  return 0;
}

function mirrorSide(landmarks) {
  const mirrored = landmarks.map((point) => ({ ...point, x: 1 - point.x }));
  for (const left of [11, 13, 15, 23, 25, 27, 29, 31]) {
    [mirrored[left], mirrored[left + 1]] = [mirrored[left + 1], mirrored[left]];
  }
  return mirrored;
}

const fixtures = [
  { name: "left profile", expectedSide: "left" },
  { name: "brief loss", loss: [3440, 3560], expectedSide: "left" },
  { name: "long loss", loss: [3440, 3840], expectedDiscard: "tracking-gap" },
  { name: "right profile", mirror: true, expectedSide: "right" },
  {
    name: "slightly oblique profile",
    armedAt: 2240,
    expectedSide: "left",
    adjust(landmarks) {
      landmarks[12].x = landmarks[11].x - 0.34 * 193 / 960;
      landmarks[24].x = landmarks[23].x - 0.25 * 193 / 960;
    },
  },
  {
    name: "turn away from a slightly oblique profile",
    armedAt: 2240,
    expectedDiscard: "tracking-gap",
    adjust(landmarks, _depth, timestampMs) {
      const turning = timestampMs >= 3440 && timestampMs <= 3920;
      landmarks[12].x = landmarks[11].x - (turning ? 0.44 : 0.34) * 193 / 960;
      landmarks[24].x = landmarks[23].x - (turning ? 0.34 : 0.25) * 193 / 960;
    },
  },
  {
    name: "partly occluded profile in motion",
    interval: 80,
    armedAt: 2240,
    expectedSide: "left",
    adjust(landmarks, depth) {
      if (depth < 0.25) return;
      landmarks[0].visibility = 0.2;
      landmarks[11].visibility = 0.42;
      landmarks[12].x -= 0.057;
      landmarks[25].visibility = 0.49;
      landmarks[29].visibility = 0.3;
      landmarks[31].visibility = 0.2;
    },
  },
  {
    name: "early loss and transient ankle spike",
    interval: 80,
    loss: [2880, 2960],
    expectedSide: "left",
    adjust(landmarks, _depth, timestampMs) {
      if (timestampMs === 3520) landmarks[27].x += 0.054;
    },
  },
  {
    name: "sustained tracked-side loss",
    interval: 80,
    expectedDiscard: "tracking-gap",
    adjust(landmarks, _depth, timestampMs) {
      if (timestampMs >= 3440 && timestampMs <= 3920) landmarks[25].visibility = 0.15;
    },
  },
  {
    name: "shifted return with one dropped frame",
    interval: 80,
    until: 7400,
    loss: [5840, 5920],
    expectedSide: "left",
    points(_depth, time) {
      const elapsed = time - 2240;
      const rising = smooth(Math.max(0, Math.min(1, (elapsed - 2250) / 1150)));
      const depth = elapsed < 2250 ? frameDepth(elapsed) : 1 - .81 * rising;
      return demoLandmarks(depth).map((joint) => ({
        ...joint,
        x: joint.x + .014 * rising,
        y: joint.y + .026 * rising,
      }));
    },
  },
  {
    name: "wide shoulder estimate with a visible side-view leg",
    interval: 80,
    armedAt: 2240,
    expectedSide: "left",
    adjust(points, depth, time) {
      points[12].x = points[11].x - 0.45 * 193 / 960;
      points[24].x = points[23].x - 0.14 * 193 / 960;
      if (time >= 3360 && time <= 3760) {
        points[27].x += 0.051 + 0.002 * Math.sin(time / 80);
        points[29].x += 0.007;
        points[31].x += 0.009;
      }
      if (time >= 3920 && depth > 0.97) points[11].visibility = 0.18;
    },
  },
];
const cases = fixtures.map(({ name, loss, mirror, interval = 40, until = 6500, armedAt = 0, points = demoLandmarks, adjust, expectedSide, expectedDiscard }) => {
  const frames = [];
  const tracker = new SquatTracker();
  const expected = [];
  for (let timestampMs = 0; timestampMs < until; timestampMs += interval) {
    const missing = loss && timestampMs >= loss[0] && timestampMs < loss[1];
    const depth = frameDepth(timestampMs - 2240);
    let landmarks = missing ? null : points(depth, timestampMs);
    if (landmarks && adjust) adjust(landmarks, depth, timestampMs);
    if (landmarks && mirror) landmarks = mirrorSide(landmarks);
    const frame = { landmarks, timestampMs, width: 960, height: 540, armed: timestampMs >= armedAt };
    frames.push(frame);
    expected.push(tracker.update(frame));
  }
  const events = expected.flatMap((state) => state.events);
  assert.equal(events.find(({ type }) => type === "rep-complete")?.rep.side, expectedSide, name);
  assert.equal(events.find(({ type }) => type === "rep-discarded")?.reason, expectedDiscard, name);
  return { name, frames, expected };
});

const compareInPython = String.raw`
import json
import sys
sys.path.insert(0, "python")
from squat_tracker import SquatTracker

for case in json.load(sys.stdin):
    tracker = SquatTracker()
    for index, (frame, expected) in enumerate(zip(case["frames"], case["expected"], strict=True)):
        actual = tracker.update(frame["landmarks"], frame["timestampMs"], frame["width"], frame["height"], armed=frame["armed"])
        if actual != expected:
            raise AssertionError((case["name"], index, actual, expected))
    print(f"{case['name']}: {len(case['frames'])} frames match")
`;

const result = spawnSync(process.argv[2] ?? "python", ["-B", "-X", "utf8", "-c", compareInPython], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  input: JSON.stringify(cases),
  encoding: "utf8",
});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;

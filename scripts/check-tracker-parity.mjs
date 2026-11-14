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
];
const cases = fixtures.map(({ name, loss, mirror, expectedSide, expectedDiscard }) => {
  const frames = [];
  const tracker = new SquatTracker();
  const expected = [];
  for (let timestampMs = 0; timestampMs < 6500; timestampMs += 40) {
    const missing = loss && timestampMs >= loss[0] && timestampMs < loss[1];
    let landmarks = missing ? null : demoLandmarks(frameDepth(timestampMs - 2240));
    if (landmarks && mirror) landmarks = mirrorSide(landmarks);
    const frame = { landmarks, timestampMs, width: 960, height: 540 };
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
        actual = tracker.update(frame["landmarks"], frame["timestampMs"], frame["width"], frame["height"])
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

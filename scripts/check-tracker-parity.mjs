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

function rapidMotion(downMs, upMs, amplitude = 1) {
  return (_depth, time) => {
    const elapsed = time - 3000;
    if (elapsed <= 0 || elapsed >= downMs + upMs) return demoLandmarks(0);
    const depth = elapsed < downMs ? smooth(elapsed / downMs) : 1 - smooth((elapsed - downMs) / upMs);
    return demoLandmarks(depth * amplitude);
  };
}

const fixtures = [
  { name: "left profile", expectedSide: "left" },
  { name: "brief loss", loss: [3440, 3560], expectedSide: "left" },
  {
    name: "brief low-presence tracked joint", expectedSide: "left",
    adjust(landmarks, _depth, time) { if (time >= 3440 && time < 3560) landmarks[25].presence = 0.1; },
  },
  { name: "long loss", loss: [3440, 3920], expectedDiscard: "tracking-gap" },
  { name: "right profile", mirror: true, expectedSide: "right" },
  {
    name: "body moves to a new spot during the squat",
    interval: 80,
    expectedSide: "left",
    adjust(landmarks, _depth, time) {
      if (time < 3520) return;
      for (const joint of landmarks) {
        joint.x += 0.08;
        joint.y -= 0.09;
      }
    },
  },
  {
    name: "near foot relocates and stays in its new position on the return",
    interval: 80,
    expectedSide: "right",
    mirror: true,
    adjust(landmarks, _depth, time) {
      if (time >= 3440) for (const index of [27, 29, 31]) landmarks[index].x += 0.054;
    },
  },
  {
    name: "repositioning a lifted foot alone does not start a rep",
    interval: 80,
    points(_depth, time) {
      const landmarks = demoLandmarks(0);
      const progress = Math.max(0, Math.min(1, (time - 2480) / 920));
      const lift = Math.sin(Math.PI * progress);
      for (const index of [27, 29, 31]) {
        landmarks[index].x += 0.055 * progress;
        landmarks[index].y -= 0.10 * lift;
      }
      landmarks[25].x += 0.075 * lift;
      landmarks[28].visibility = 0.2;
      return landmarks;
    },
  },
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
  {
    name: "fast lowering at 12 Hz",
    interval: 1000 / 12,
    armedAt: 2500,
    points: rapidMotion(250, 1200),
    expectedSide: "left",
  },
  {
    name: "fast rise at 12 Hz",
    interval: 1000 / 12,
    armedAt: 2500,
    points: rapidMotion(1100, 250),
    expectedSide: "left",
  },
  {
    name: "fast reversal with irregular frames",
    interval: [72, 96, 83, 105, 61],
    armedAt: 2500,
    points: rapidMotion(300, 260),
    expectedSide: "left",
  },
  {
    name: "single deep pose glitch at 12 Hz",
    interval: 1000 / 12,
    armedAt: 2500,
    points: (_depth, time) => demoLandmarks(time === 3250 ? 1 : 0),
    expectedSide: undefined,
    allowDiscard: true,
  },
  {
    name: "soft-kneed setup with sway, missing frames and overlapping feet",
    interval: 80,
    until: 7800,
    armedAt: 2800,
    misses: [320, 640],
    expectedSide: "left",
    points(_depth, time) {
      const landmarks = demoLandmarks(0.30 + 0.70 * frameDepth(time - 2800));
      for (const [near, span] of [[11, 0.36], [23, 0.27], [25, 0.16]]) {
        landmarks[near + 1].x = landmarks[near].x - span * 193 / 960;
      }
      for (const index of [29, 30, 31, 32]) landmarks[index].visibility = 0.25;
      return landmarks.map((joint) => ({
        ...joint,
        x: joint.x + 0.004 * Math.sin(time / 330),
        y: joint.y + 0.008 * Math.sin(time / 240),
      }));
    },
  },
  {
    name: "several brief pose interruptions during a rep",
    interval: 80,
    until: 7400,
    misses: [3440, 3920, 4240, 4800, 5280],
    points: (depth) => demoLandmarks(0.08 + 0.92 * depth),
    expectedSide: "left",
  },
  {
    name: "320 ms interruption during a rep",
    interval: 80,
    loss: [3440, 3680],
    expectedSide: "left",
  },
  {
    name: "isolated front-like pose before a short tracking gap",
    interval: 80,
    misses: [3920, 4000],
    expectedSide: "left",
    adjust(landmarks, _depth, time) {
      if (time !== 3840) return;
      for (const [near, span] of [[11, 0.46], [23, 0.34], [25, 0.34]]) {
        landmarks[near + 1].x = landmarks[near].x - span * 193 / 960;
      }
    },
  },
  {
    name: "short ambiguous rotation while the same planted leg descends",
    interval: 80,
    expectedSide: "left",
    adjust(landmarks, _depth, time) {
      if (time < 3280 || time > 3520) return;
      landmarks[12].x = landmarks[11].x - 0.46 * 193 / 960;
      landmarks[24].x = landmarks[23].x - 0.34 * 193 / 960;
    },
  },
  {
    name: "weak near leg survives short bottleneck without changing sides",
    interval: 80,
    until: 7600,
    misses: [4000, 4080, 4160],
    expectedSide: "left",
    adjust(landmarks, _depth, time) {
      if (time !== 3840 && time !== 3920) return;
      landmarks[25].visibility = 0.27;
      for (const far of [24, 26, 28]) landmarks[far].visibility = 0.98;
    },
  },
  {
    name: "short burst of implausible leg geometry during the bottom",
    interval: 80,
    until: 7600,
    expectedSide: "left",
    adjust(landmarks, _depth, time) {
      if (time < 4000 || time > 4320) return;
      for (const index of [25, 27, 29, 31]) {
        landmarks[index].x = landmarks[23].x + 0.30 * (landmarks[index].x - landmarks[23].x);
        landmarks[index].y = landmarks[23].y + 0.30 * (landmarks[index].y - landmarks[23].y);
      }
    },
  },
  {
    name: "shorter estimated legs after returning upright",
    interval: 80,
    until: 7400,
    expectedSide: "left",
    adjust(landmarks, _depth, time) {
      if (time < 5760) return;
      for (const [hip, lower] of [[23, [25, 27, 29, 31]], [24, [26, 28, 30, 32]]]) {
        for (const index of lower) {
          landmarks[index].y = landmarks[hip].y + 0.78 * (landmarks[index].y - landmarks[hip].y);
        }
      }
    },
  },
  {
    name: "immediate rearm during a shortened standing pose",
    interval: 80,
    until: 12600,
    rearm: true,
    expectedSide: "left",
    points(depth, time) {
      return demoLandmarks(time < 6200 ? depth : frameDepth(time - 7360));
    },
    adjust(landmarks, _depth, time) {
      if (time < 5760 || time >= 6640) return;
      for (const [hip, lower] of [[23, [25, 27, 29, 31]], [24, [26, 28, 30, 32]]]) {
        for (const index of lower) {
          landmarks[index].y = landmarks[hip].y + 0.78 * (landmarks[index].y - landmarks[hip].y);
        }
      }
    },
  },
];
const cases = fixtures.map(({ name, loss, misses = [], mirror, interval = 40, until = 6500, armedAt = 0, points = demoLandmarks, adjust, expectedSide, expectedDiscard, allowDiscard, rearm = false }) => {
  const frames = [];
  const tracker = new SquatTracker();
  const expected = [];
  const intervals = Array.isArray(interval) ? interval : [interval];
  let isArmed = true;
  for (let time = 0, index = 0; time < until; time += intervals[index++ % intervals.length]) {
    const timestampMs = Math.round(time);
    const missing = misses.includes(timestampMs) || (loss && timestampMs >= loss[0] && timestampMs < loss[1]);
    const depth = frameDepth(timestampMs - 2240);
    let landmarks = missing ? null : points(depth, timestampMs);
    if (landmarks && adjust) adjust(landmarks, depth, timestampMs);
    if (landmarks && mirror) landmarks = mirrorSide(landmarks);
    const frame = { landmarks, timestampMs, width: 960, height: 540, armed: timestampMs >= armedAt && isArmed };
    frames.push(frame);
    const state = tracker.update(frame);
    expected.push(state);
    if (rearm) {
      isArmed ||= state.setup.ready;
      if (state.events.some(({ type }) => type === "rep-complete")) isArmed = false;
    }
  }
  const events = expected.flatMap((state) => state.events);
  assert.equal(events.find(({ type }) => type === "rep-complete")?.rep.side, expectedSide, name);
  if (rearm) assert.equal(events.filter(({ type }) => type === "rep-complete").length, 2, name);
  if (!allowDiscard) assert.equal(events.find(({ type }) => type === "rep-discarded")?.reason, expectedDiscard, name);
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

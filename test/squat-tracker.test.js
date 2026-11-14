import test from "node:test";
import assert from "node:assert/strict";
import { SquatTracker } from "../src/squat-tracker.js";
import { demoLandmarks } from "../src/demo.js";

const standingMs = 2240;
const stepMs = 40;
const smooth = (v) => (1 - Math.cos(Math.PI * v)) / 2;

function depthAt(t) {
  if (t < 0) return 0;
  if (t < 1900) return smooth(t / 1900);
  if (t < 2250) return 1;
  if (t < 3400) return 1 - smooth((t - 2250) / 1150);
  return 0;
}

function run({ points = demoLandmarks, armed = () => true, lost = () => false, until = 6500 } = {}) {
  const tracker = new SquatTracker();
  const states = [];
  for (let t = 0; t <= until; t += stepMs) {
    states.push(tracker.update({
      landmarks: lost(t) ? null : points(depthAt(t - standingMs), t),
      timestampMs: t,
      width: 960,
      height: 540,
      armed: armed(t),
    }));
  }
  return { states, events: states.flatMap((state) => state.events) };
}

test("calibrates for two seconds and keeps five ordered evidence frames through a complete rep", () => {
  const { states, events } = run();
  assert.equal(states[49].setup.ready, false);
  assert.equal(states[50].setup.ready, true);
  assert.equal(states[50].live.side, "left");
  const completed = events.filter(({ type }) => type === "rep-complete");
  assert.equal(completed.length, 1);
  const rep = completed[0].rep;
  assert.deepEqual(rep.frames.map(({ phase }) => phase), ["start", "descent", "bottom", "ascent", "finish"]);
  assert.deepEqual(rep.frames.map(({ timestampMs }) => timestampMs).toSorted((a, b) => a - b),
    rep.frames.map(({ timestampMs }) => timestampMs));
  const bottomCaptures = events.filter(({ type, phase }) => type === "capture" && phase === "bottom");
  assert.ok(bottomCaptures.length > 1);
  assert.equal(rep.frames[2].timestampMs, bottomCaptures.at(-1).timestampMs);
  assert.ok(Math.abs(rep.frames[2].timestampMs - (standingMs + 1900)) < 300);
  assert.ok(rep.metrics.averageAscentLegLengthsPerSec > rep.metrics.averageDescentLegLengthsPerSec);
  assert.ok(rep.metrics.kneeAngleAtBottomDeg < 80);
  assert.ok(rep.metrics.hipDropLegLengths > 0.45);
  assert.equal(rep.metrics.validFrameFraction, 1);
  assert.equal(rep.metrics.maxTrackingGapMs, stepMs);
  assert.equal(rep.metrics.durationMs, rep.metrics.descentMs + rep.metrics.pauseMs + rep.metrics.ascentMs);
  assert.equal(states.at(-1).phase, "ready");
});

test("rejects a front-facing setup and does not start an unarmed rep", () => {
  const front = run({
    points(depth) {
      const joints = demoLandmarks(depth);
      for (const index of [12, 24]) joints[index].x += 0.12;
      return joints;
    },
  });
  assert.equal(front.states.at(-1).setup.checks.inFrame, true);
  assert.equal(front.states.at(-1).setup.checks.sideOn, false);
  assert.equal(front.events.length, 0);

  const unarmed = run({ armed: (t) => t >= 3500 });
  assert.equal(unarmed.states[50].setup.ready, true);
  assert.equal(unarmed.events.length, 0);
});

test("brief pose loss does not substitute the far side or introduce a speed spike", () => {
  const { states, events } = run({
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time >= 3440 && time <= 3520) joints[25].visibility = 0.2;
      return joints;
    },
  });
  assert.equal(states[3440 / stepMs].live, null);
  const rep = events.find(({ type }) => type === "rep-complete")?.rep;
  assert.equal(rep?.side, "left");
  assert.ok(rep.metrics.validFrameFraction >= 0.9 && rep.metrics.validFrameFraction < 1);
  assert.equal(rep.metrics.maxTrackingGapMs, 160);
  assert.ok(rep.metrics.peakDescentLegLengthsPerSec < 1);
});

test("a gap over 300 ms cancels capture and requires standing calibration again", () => {
  const { states, events } = run({ lost: (t) => t >= 3400 && t < 3800 });
  assert.ok(events.some(({ type, reason }) => type === "rep-discarded" && reason === "tracking-gap"));
  assert.ok(!events.some(({ type }) => type === "rep-complete"));
  assert.equal(states[95].phase, "setup");
  assert.equal(states[95].setup.ready, false);
});

test("a small bend followed by standing does not produce a completed rep", () => {
  const { events } = run({ points: (depth) => demoLandmarks(depth * 0.19) });
  assert.ok(!events.some(({ type }) => type === "rep-complete"));
  assert.ok(!events.some(({ phase }) => phase === "finish"));
});

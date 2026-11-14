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

function shiftedReturn(_depth, time) {
  const elapsed = time - standingMs;
  const rising = smooth(Math.max(0, Math.min(1, (elapsed - 2250) / 1150)));
  const depth = elapsed < 2250 ? depthAt(elapsed) : 1 - .81 * rising;
  return demoLandmarks(depth).map((joint) => ({
    ...joint,
    x: joint.x + .014 * rising,
    y: joint.y + .026 * rising,
  }));
}

function barbellPose(depth, time, hipSpan = 0.14) {
  const points = demoLandmarks(depth);
  points[12].x = points[11].x - 0.45 * 193 / 960;
  points[24].x = points[23].x - hipSpan * 193 / 960;
  for (const [shoulder, elbow, wrist, sign] of [[11, 13, 15, 1], [12, 14, 16, -1]]) {
    points[elbow].x = points[shoulder].x + sign * 0.06;
    points[elbow].y = points[shoulder].y + 0.045;
    points[wrist].x = points[shoulder].x + sign * 0.025;
    points[wrist].y = points[shoulder].y - 0.023;
  }
  if (time >= 3360 && time <= 3760) {
    // Ankle landmark drifts across a stationary shoe, without the contact points moving with it.
    points[27].x += 0.051 + 0.002 * Math.sin(time / 80);
    points[29].x += 0.007;
    points[31].x += 0.009;
  }
  if (time >= 3920 && depth > 0.97) points[11].visibility = 0.18;
  return points;
}

function run({ points = demoLandmarks, armed = () => true, lost = () => false, until = 6500, interval = stepMs } = {}) {
  const tracker = new SquatTracker();
  const states = [];
  for (let t = 0; t <= until; t += interval) {
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

test("accepts a slightly oblique profile without changing measurements from the tracked side", () => {
  const armAt = (t) => t >= standingMs;
  const trackedRep = (result) => result.events.find(({ type }) => type === "rep-complete")?.rep;
  const profile = trackedRep(run({ armed: armAt }));
  assert.ok(profile);
  for (const [shoulderSpan, hipSpan] of [[0.31, 0.21], [0.34, 0.25]]) {
    const result = run({
      armed: armAt,
      points(depth) {
        const points = demoLandmarks(depth);
        points[12].x = points[11].x - shoulderSpan * 193 / 960;
        points[24].x = points[23].x - hipSpan * 193 / 960;
        return points;
      },
    });
    assert.equal(result.states[2000 / stepMs].setup.ready, true);
    assert.deepEqual(trackedRep(result), profile);
  }

  const wide = run({
    points(depth) {
      const points = demoLandmarks(depth);
      points[12].x = points[11].x - 0.39 * 193 / 960;
      points[24].x = points[23].x - 0.30 * 193 / 960;
      return points;
    },
  });
  assert.equal(wide.states[2000 / stepMs].setup.checks.sideOn, false);
  assert.equal(trackedRep(wide), undefined);
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

test("movement remains trackable when face and toes are obscured and the far shoulder drifts", () => {
  const { events } = run({
    interval: 80,
    armed: (time) => time >= standingMs,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (depth < 0.25) return joints;
      joints[0].visibility = 0.2;
      joints[11].visibility = 0.42;
      joints[12].x -= 0.057;
      joints[25].visibility = 0.49;
      joints[29].visibility = 0.3;
      joints[31].visibility = 0.2;
      // Pose models jitter by a few pixels when limbs overlap in profile.
      const jitter = Math.sin(time / 55);
      joints[23].x += jitter * 0.002;
      joints[25].y += jitter * 0.003;
      return joints;
    },
  });
  assert.equal(events.filter(({ type }) => type === "rep-discarded").length, 0);
  const completed = events.filter(({ type }) => type === "rep-complete");
  assert.equal(completed.length, 1);
  const { rep } = completed[0];
  assert.equal(rep.side, "left");
  assert.deepEqual(rep.frames.map(({ phase }) => phase), ["start", "descent", "bottom", "ascent", "finish"]);
  assert.ok(Math.abs(rep.frames[2].timestampMs - (standingMs + 1900)) < 300);
  assert.ok(rep.metrics.kneeAngleAtBottomDeg < 80);
});

test("barbell arm placement and a wandering ankle estimate preserve a side-view rep", () => {
  const { states, events } = run({ interval: 80, armed: (time) => time >= standingMs, points: barbellPose });
  assert.equal(states[2000 / 80].setup.ready, true);
  assert.equal(events.some(({ type }) => type === "rep-discarded"), false);
  const completed = events.filter(({ type }) => type === "rep-complete");
  assert.equal(completed.length, 1);
  const { rep } = completed[0];
  assert.equal(rep.side, "left");
  assert.deepEqual(rep.frames.map(({ phase }) => phase), ["start", "descent", "bottom", "ascent", "finish"]);
  assert.ok(rep.metrics.kneeAngleAtBottomDeg < 80);
  assert.ok(rep.metrics.hipDropLegLengths > 0.45);
  assert.equal(rep.metrics.hipAngleAtBottomDeg, null);
  assert.equal(rep.metrics.torsoLeanAtBottomDeg, null);
});

test("the barbell position does not excuse a front-facing stance or a planted foot relocation", () => {
  const frontal = run({
    interval: 80,
    points: (depth, time) => barbellPose(depth, time, 0.36),
  });
  assert.equal(frontal.states[2000 / 80].setup.checks.sideOn, false);
  assert.equal(frontal.events.length, 0);

  const stepping = run({
    interval: 80,
    points(depth, time) {
      const joints = barbellPose(depth, time);
      if (time >= 3360 && time <= 3760) {
        // All three shoe joints agree that the foot has moved.
        joints[29].x += 0.046;
        joints[31].x += 0.046;
      }
      return joints;
    },
  });
  assert.ok(stepping.events.some(({ type, reason }) => type === "rep-discarded" && reason === "foot-moved"));
  assert.ok(!stepping.events.some(({ type }) => type === "rep-complete"));
});

test("an early dropped pose and one ankle spike do not cancel the rep", () => {
  const { events } = run({
    interval: 80,
    lost: (time) => time === 2880,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time === 3520) joints[27].x += 0.054;
      return joints;
    },
  });
  assert.equal(events.filter(({ type }) => type === "rep-discarded").length, 0);
  const rep = events.find(({ type }) => type === "rep-complete")?.rep;
  assert.ok(rep);
  assert.equal(rep.frames.length, 5);
  assert.ok(rep.metrics.maxTrackingGapMs <= 240);
  assert.ok(rep.metrics.peakDescentLegLengthsPerSec < 1);
});

test("sustained loss of the tracked knee cancels despite a visible far side", () => {
  const { events } = run({
    interval: 80,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time >= 3440 && time <= 3920) joints[25].visibility = 0.15;
      return joints;
    },
  });
  assert.ok(events.some(({ type, reason }) => type === "rep-discarded" && reason === "tracking-gap"));
  assert.ok(!events.some(({ type }) => type === "rep-complete"));
});

test("a softly bent standing pose remains usable after a small pre-capture stance shift", () => {
  const { states, events } = run({
    interval: 80,
    until: 7600,
    armed: (time) => time >= 2880,
    points(_depth, time) {
      const depth = 0.15 + 0.85 * depthAt(time - 3040);
      const shift = Math.max(0, Math.min(1, (time - 2240) / 400));
      return demoLandmarks(depth).map((joint) => ({ ...joint, y: joint.y + 0.037 * shift }));
    },
  });
  const calibrated = states[2000 / 80];
  assert.equal(calibrated.setup.ready, true);
  assert.ok(calibrated.live.standingKneeAngleDeg > 155 && calibrated.live.standingKneeAngleDeg < 165);
  assert.equal(states[2800 / 80].setup.ready, true);
  const rep = events.find(({ type }) => type === "rep-complete")?.rep;
  assert.ok(rep);
  assert.equal(rep.frames.at(-1).phase, "finish");
  assert.ok(Math.abs(rep.metrics.finishKneeAngleDeg - calibrated.live.standingKneeAngleDeg) < 3);
});

test("a small shift and a brief lost pose while returning upright still yield one complete rep", () => {
  const { states, events } = run({ interval: 80, until: 7400, points: shiftedReturn, lost: (time) => time === 5840 });
  assert.equal(states[2000 / 80].setup.ready, true);
  assert.deepEqual(events.filter(({ type }) => type === "rep-discarded"), []);
  const completed = events.filter(({ type }) => type === "rep-complete");
  assert.equal(completed.length, 1);
  const { rep } = completed[0];
  assert.deepEqual(rep.frames.map(({ phase }) => phase), ["start", "descent", "bottom", "ascent", "finish"]);
  assert.ok(rep.finishedAtMs >= 5920 && rep.finishedAtMs < 6900);
  assert.ok(rep.metrics.finishKneeAngleDeg >= 155 && rep.metrics.finishKneeAngleDeg <= 162);
  assert.equal(rep.metrics.maxTrackingGapMs, 160);
  assert.ok(rep.metrics.ascentMs >= 720 && rep.metrics.ascentMs <= 1350);
});

test("a slow controlled descent reaches the bottom without replacing the starting stance", () => {
  const { events } = run({
    interval: 80,
    until: 10000,
    armed: (time) => time >= standingMs,
    points(_depth, time) {
      const elapsed = time - standingMs;
      if (elapsed < 0) return demoLandmarks(0);
      if (elapsed < 4750) return demoLandmarks(smooth(elapsed / 4750));
      if (elapsed < 5050) return demoLandmarks(1);
      return demoLandmarks(1 - smooth(Math.min(1, (elapsed - 5050) / 1500)));
    },
  });
  const completed = events.filter(({ type }) => type === "rep-complete");
  assert.equal(completed.length, 1);
  const { rep } = completed[0];
  assert.ok(rep.metrics.startKneeAngleDeg >= 169);
  assert.ok(rep.metrics.descentMs >= 3400);
  assert.ok(rep.metrics.kneeAngleAtBottomDeg < 80);
});

test("a long occlusion near the returned stance still discards the rep", () => {
  const { events } = run({
    interval: 80,
    until: 7400,
    points: shiftedReturn,
    lost: (time) => time >= 5600 && time < 6080,
  });
  assert.ok(events.some(({ type, reason }) => type === "rep-discarded" && reason === "tracking-gap"));
  assert.ok(!events.some(({ type }) => type === "rep-complete"));
});

test("rising partway and holding a bent stance does not count as standing", () => {
  const { states, events } = run({ interval: 80, until: 7400, points: (depth, time) => (
    demoLandmarks(time < standingMs + 2250 ? depth : Math.max(depth, .37))
  ) });
  assert.equal(states.at(-1).phase, "ascending");
  assert.ok(!events.some(({ type }) => type === "rep-complete"));
  assert.ok(!events.some(({ phase }) => phase === "finish"));
});

test("a sustained step and a turn during capture still invalidate the rep", () => {
  const movedFoot = run({
    interval: 80,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time >= 3440 && time <= 3920) {
        for (const index of [27, 29, 31]) joints[index].x += 0.054;
      }
      return joints;
    },
  });
  assert.ok(movedFoot.events.some(({ type, reason }) => type === "rep-discarded" && reason === "foot-moved"));
  assert.ok(!movedFoot.events.some(({ type }) => type === "rep-complete"));

  const turned = run({
    interval: 80,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time >= 3440 && time <= 3920) {
        for (const index of [12, 24]) joints[index].x -= 0.07;
      }
      return joints;
    },
  });
  assert.ok(turned.events.some(({ type, reason }) => type === "rep-discarded" && reason === "tracking-gap"));
  assert.ok(!turned.events.some(({ type }) => type === "rep-complete"));
});

test("a small bend followed by standing does not produce a completed rep", () => {
  const { events } = run({ points: (depth) => demoLandmarks(depth * 0.19) });
  assert.ok(!events.some(({ type }) => type === "rep-complete"));
  assert.ok(!events.some(({ phase }) => phase === "finish"));
});

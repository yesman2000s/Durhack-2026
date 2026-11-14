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

const fastStartMs = 3000;

function timedRepDepth(time, downMs, upMs, amplitude = 1) {
  const elapsed = time - fastStartMs;
  if (elapsed <= 0 || elapsed >= downMs + upMs) return 0;
  const amount = elapsed < downMs ? smooth(elapsed / downMs) : 1 - smooth((elapsed - downMs) / upMs);
  return amplitude * amount;
}

function runAtCadence({ downMs, upMs, intervals, amplitude = 1, spikeAt = null }) {
  const tracker = new SquatTracker();
  const samples = [];
  for (let t = 0, i = 0; t <= fastStartMs + downMs + upMs + 1600; t += intervals[i++ % intervals.length]) {
    const time = Math.round(t);
    const depth = time === spikeAt ? 1 : timedRepDepth(time, downMs, upMs, amplitude);
    const state = tracker.update({ landmarks: demoLandmarks(depth), timestampMs: time, width: 960, height: 540, armed: time >= 2500 });
    samples.push({ time, depth, state });
  }
  return { samples, events: samples.flatMap(({ state }) => state.events) };
}

function kneeAngleAtDepth(depth) {
  const points = demoLandmarks(depth);
  const [hip, knee, ankle] = [23, 25, 27].map((index) => points[index]);
  const a = { x: (hip.x - knee.x) * 960, y: (hip.y - knee.y) * 540 };
  const b = { x: (ankle.x - knee.x) * 960, y: (ankle.y - knee.y) * 540 };
  return Math.atan2(Math.abs(a.x * b.y - a.y * b.x), a.x * b.x + a.y * b.y) * 180 / Math.PI;
}

function softStandingProfile(time, hipSpan = 0.27, shoulderSpan = 0.36, kneeSpan = 0.16) {
  const depth = 0.30 + 0.70 * depthAt(time - 2800);
  const joints = demoLandmarks(depth);
  for (const [near, span] of [[11, shoulderSpan], [23, hipSpan], [25, kneeSpan]]) {
    joints[near + 1].x = joints[near].x - span * 193 / 960;
  }
  // Keep the leg shape intact while the image position sways just a few pixels.
  return joints.map((joint) => ({
    ...joint,
    x: joint.x + 0.004 * Math.sin(time / 330),
    y: joint.y + 0.008 * Math.sin(time / 240),
  }));
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
  assert.equal(bottomCaptures.length, 1);
  assert.equal(rep.frames[2].timestampMs, bottomCaptures[0].timestampMs);
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

test("calibrates an upright soft-kneed profile through modest sway and isolated setup misses", () => {
  const { states, events } = run({
    interval: 80,
    until: 7800,
    armed: (time) => time >= 2800,
    points: (_depth, time) => softStandingProfile(time),
    lost: (time) => [640, 1440].includes(time),
  });
  assert.equal(states[2000 / 80].setup.ready, false, "missing frames are not counted as steady standing");
  assert.equal(states[2720 / 80].setup.ready, true);
  assert.equal(states[2720 / 80].live.side, "left");
  assert.ok(states[2720 / 80].live.standingKneeAngleDeg >= 145 && states[2720 / 80].live.standingKneeAngleDeg < 153);
  assert.ok(events.filter(({ type }) => type === "rep-complete").length === 1);

  const frontal = run({ interval: 80, points: (_depth, time) => softStandingProfile(time, 0.32, 0.42, 0.36) });
  assert.equal(frontal.states[2720 / 80].setup.checks.sideOn, false);
  assert.ok(!frontal.events.some(({ type }) => type === "rep-complete"));
});

test("accepts several short missed poses without reporting them as usable samples", () => {
  const missed = [3440, 3920, 4240, 4800, 5280];
  const { states, events } = run({
    interval: 80,
    until: 7400,
    points: (depth) => demoLandmarks(0.08 + 0.92 * depth),
    lost: (time) => missed.includes(time),
  });
  assert.ok(missed.every((time) => states[time / 80].live === null));
  const finished = events.filter(({ type }) => type === "rep-complete");
  assert.equal(finished.length, 1);
  const { rep } = finished[0];
  assert.ok(rep.metrics.validFrameFraction >= 0.85 && rep.metrics.validFrameFraction < 0.9);
  assert.equal(rep.metrics.maxTrackingGapMs, 160);
  assert.ok(rep.frames.every(({ timestampMs }) => !missed.includes(timestampMs)));
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

test("a sustained pose gap over 400 ms cancels capture and requires standing calibration again", () => {
  const { states, events } = run({ lost: (t) => t >= 3400 && t < 3880 });
  assert.ok(events.some(({ type, reason }) => type === "rep-discarded" && reason === "tracking-gap"));
  assert.ok(!events.some(({ type }) => type === "rep-complete"));
  assert.equal(states[97].phase, "setup");
  assert.equal(states[97].setup.ready, false);
});

test("a brief mid-rep interruption is bridged without keeping a missing frame", () => {
  const { events } = run({ interval: 80, lost: (time) => time >= 3440 && time < 3680 });
  const rep = events.find(({ type }) => type === "rep-complete")?.rep;
  assert.ok(rep);
  assert.equal(rep.metrics.maxTrackingGapMs, 320);
  assert.ok(rep.frames.every(({ timestampMs }) => timestampMs < 3440 || timestampMs >= 3680));
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

for (const fixture of [
  { name: "a fast lowering and relaxed rise", downMs: 250, upMs: 1200, intervals: [1000 / 12] },
  { name: "a relaxed lowering and fast rise", downMs: 1100, upMs: 250, intervals: [1000 / 12] },
  { name: "a fast lowering and fast rise", downMs: 250, upMs: 250, intervals: [1000 / 12] },
  { name: "a fast rep with irregular camera sampling", downMs: 300, upMs: 260, intervals: [72, 96, 83, 105, 61] },
]) {
  test(`retains the actual snapshot phases for ${fixture.name}`, () => {
    const { samples, events } = runAtCadence(fixture);
    assert.ok(samples.some(({ time, state }) => time < fastStartMs && state.setup.ready));
    assert.equal(events.some(({ type }) => type === "rep-discarded"), false);
    const completed = events.filter(({ type }) => type === "rep-complete");
    assert.equal(completed.length, 1);
    const { rep } = completed[0];
    assert.deepEqual(rep.frames.map(({ phase }) => phase), ["start", "descent", "bottom", "ascent", "finish"]);
    let bottomKneeAngle;
    for (const { phase, timestampMs } of rep.frames.slice(1, -1)) {
      const selected = events.findIndex((event) => event.type === "capture" && event.phase === phase);
      const recorded = events.slice(0, selected).find((event) => event.type === "capture-candidate" && event.timestampMs === timestampMs);
      assert.ok(recorded, `${phase} was sampled before it was selected`);
      const { depth } = samples.find(({ time }) => time === timestampMs);
      assert.ok(Math.abs(recorded.kneeAngleDeg - kneeAngleAtDepth(depth)) <= 0.051);
      if (phase === "bottom") bottomKneeAngle = recorded.kneeAngleDeg;
    }
    assert.equal(rep.metrics.kneeAngleAtBottomDeg, bottomKneeAngle);
    const timestamps = Object.fromEntries(rep.frames.map(({ phase, timestampMs }) => [phase, timestampMs]));
    const deepestTime = fastStartMs + fixture.downMs;
    const standingTime = deepestTime + fixture.upMs;
    assert.ok(timestamps.descent > fastStartMs && timestamps.descent < deepestTime);
    assert.ok(Math.abs(timestamps.bottom - deepestTime) <= Math.max(...fixture.intervals));
    assert.ok(timestamps.ascent > deepestTime && timestamps.ascent < standingTime);
    assert.ok(timestamps.finish >= standingTime);
    assert.ok(rep.metrics.kneeAngleAtBottomDeg < 95);
    assert.ok(rep.metrics.hipDropLegLengths > 0.34);
    assert.ok(rep.metrics.ascentMs > 0 && rep.metrics.descentMs > 0);
    assert.ok(rep.metrics.maxTrackingGapMs <= Math.ceil(Math.max(...fixture.intervals)));
  });
}

test("a one-frame deep landmark glitch and a shallow bounce are insufficient for a fast rep", () => {
  const oneFrame = runAtCadence({ downMs: 250, upMs: 250, intervals: [1000 / 12], amplitude: 0, spikeAt: 3250 });
  const shallow = runAtCadence({ downMs: 250, upMs: 250, intervals: [1000 / 12], amplitude: 0.25 });
  for (const { events } of [oneFrame, shallow]) {
    assert.ok(!events.some(({ type }) => type === "rep-complete"));
    assert.ok(!events.some(({ phase }) => phase === "finish"));
  }
});

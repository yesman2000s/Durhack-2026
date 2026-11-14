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

test("calibrates after a full second and keeps five ordered phases through a complete rep", () => {
  const { states, events } = run();
  assert.equal(states[24].setup.ready, false);
  assert.equal(states[25].setup.ready, true);
  assert.equal(states[25].live.side, "left");
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

test("a clear frontal pose before countdown requires a new full second in profile", () => {
  const { states } = run({
    interval: 80,
    armed: () => false,
    until: 2000,
    points(_depth, time) {
      const joints = demoLandmarks(0);
      if (time === 640) {
        for (const index of [12, 24, 26]) joints[index].x += 0.12;
      }
      return joints;
    },
  });
  assert.equal(states[640 / 80].setup.checks.sideOn, false);
  assert.equal(states[1680 / 80].setup.ready, false);
  assert.equal(states[1760 / 80].setup.ready, true);
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
    lost: (time) => [320, 640].includes(time),
  });
  assert.equal(states[960 / 80].setup.ready, false, "missing frames are not counted as steady standing");
  assert.equal(states[1360 / 80].setup.ready, true);
  assert.equal(states[1360 / 80].live.side, "left");
  assert.ok(states[1360 / 80].live.standingKneeAngleDeg >= 145 && states[1360 / 80].live.standingKneeAngleDeg < 153);
  assert.ok(events.filter(({ type }) => type === "rep-complete").length === 1);

  const frontal = run({ interval: 80, points: (_depth, time) => softStandingProfile(time, 0.32, 0.42, 0.36) });
  assert.equal(frontal.states[2720 / 80].setup.checks.sideOn, false);
  assert.ok(!frontal.events.some(({ type }) => type === "rep-complete"));
});

test("quickly calibrates a true profile when far joints hide and nearer estimates wobble modestly", () => {
  const { states } = run({
    interval: 80,
    armed: () => false,
    until: 1600,
    points(_depth, time) {
      const joints = demoLandmarks(0.11);
      for (const far of [12, 24, 26, 28, 30, 32]) joints[far].visibility = 0.18;
      joints[29].visibility = 0.25;
      joints[31].visibility = 0.25;
      joints[23].x += 0.002 * Math.sin(time / 75);
      joints[25].y += 0.003 * Math.sin(time / 85);
      joints[27].x += 0.002 * Math.sin(time / 112);
      return joints;
    },
  });
  assert.equal(states[880 / 80].setup.ready, false);
  assert.equal(states[960 / 80].setup.ready, false);
  assert.equal(states[1040 / 80].setup.ready, true);
  assert.equal(states[1040 / 80].live.side, "left");
});

test("an ankle near the bottom edge cannot stand in for missing shoe landmarks", () => {
  const { states } = run({
    interval: 80,
    armed: () => false,
    until: 1500,
    points() {
      const joints = demoLandmarks(0);
      for (const joint of joints) joint.y += 0.17;
      for (const index of [29, 30, 31, 32]) joints[index].visibility = 0.25;
      return joints;
    },
  });
  assert.equal(states.at(-1).setup.ready, false);
  assert.match(states.at(-1).setup.message, /feet/i);
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

test("an isolated front-like pose at depth does not turn a short gap into a real turn", () => {
  const unreliable = [3840, 3920, 4000];
  const { states, events } = run({
    interval: 80,
    lost: (time) => time === 3920 || time === 4000,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time === 3840) {
        for (const [near, span] of [[11, 0.46], [23, 0.34], [25, 0.34]]) {
          joints[near + 1].x = joints[near].x - span * 193 / 960;
        }
      }
      return joints;
    },
  });
  assert.equal(states[3840 / 80].live, null);
  const completed = events.filter(({ type }) => type === "rep-complete");
  assert.equal(completed.length, 1);
  const { rep } = completed[0];
  assert.equal(rep.side, "left");
  assert.equal(rep.metrics.maxTrackingGapMs, 320);
  assert.ok(rep.frames.every(({ timestampMs }) => !unreliable.includes(timestampMs)));
});

test("keeps descending through a few misleading shoulder and hip readings", () => {
  const unreliable = [3280, 3360, 3440, 3520];
  const { states, events } = run({
    interval: 80,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (unreliable.includes(time)) {
        joints[12].x = joints[11].x - 0.46 * 193 / 960;
        joints[24].x = joints[23].x - 0.34 * 193 / 960;
      }
      return joints;
    },
  });
  for (const time of unreliable) {
    const state = states[time / 80];
    assert.equal(state.phase, "descending");
    assert.equal(state.live, null);
    assert.ok(!state.events.some(({ type }) => type === "capture-candidate"));
  }
  const rep = events.find(({ type }) => type === "rep-complete")?.rep;
  assert.equal(rep?.frames.length, 5);
  assert.ok(rep.frames.every(({ timestampMs }) => !unreliable.includes(timestampMs)));
});

test("uses weak near-leg continuity to bridge a bottom occlusion without switching sides or saving weak frames", () => {
  const weak = [3840, 3920];
  const missing = [4000, 4080, 4160];
  const { states, events } = run({
    interval: 80,
    until: 7600,
    lost: (time) => missing.includes(time),
    points(depth, time) {
      const joints = demoLandmarks(depth);
      // The other leg is highly visible, but cannot replace the calibrated chain.
      if (weak.includes(time)) {
        joints[25].visibility = 0.27;
        for (const far of [24, 26, 28]) joints[far].visibility = 0.98;
      }
      return joints;
    },
  });
  for (const time of weak) {
    const state = states[time / 80];
    assert.equal(state.continuitySide, "left");
    assert.equal(state.live, null);
    assert.ok(!state.events.some(({ type }) => type === "capture-candidate"));
  }
  const completed = events.filter(({ type }) => type === "rep-complete");
  assert.equal(completed.length, 1);
  const { rep } = completed[0];
  assert.equal(rep.side, "left");
  assert.ok(rep.metrics.validFrameFraction >= 0.85 && rep.metrics.validFrameFraction < 1);
  assert.equal(rep.metrics.maxTrackingGapMs, 480);
  assert.ok(rep.frames.every(({ timestampMs }) => !weak.includes(timestampMs) && !missing.includes(timestampMs)));
});

test("skips briefly collapsed leg geometry and resumes with the same leg near the bottom", () => {
  const bad = [4000, 4080, 4160, 4240, 4320];
  const { states, events } = run({
    interval: 80,
    until: 7600,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (bad.includes(time)) {
        for (const index of [25, 27, 29, 31]) {
          joints[index].x = joints[23].x + 0.30 * (joints[index].x - joints[23].x);
          joints[index].y = joints[23].y + 0.30 * (joints[index].y - joints[23].y);
        }
      }
      return joints;
    },
  });
  assert.ok(bad.every((time) => states[time / 80].live === null));
  const rep = events.find(({ type }) => type === "rep-complete")?.rep;
  assert.equal(rep?.side, "left");
  assert.equal(rep.metrics.maxTrackingGapMs, 480);
  assert.ok(rep.frames.every(({ timestampMs }) => !bad.includes(timestampMs)));
});

test("does not confuse shortened upright leg landmarks with a step after the rise", () => {
  const { events } = run({
    interval: 80,
    until: 7400,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time >= 5760) {
        for (const [hip, lower] of [[23, [25, 27, 29, 31]], [24, [26, 28, 30, 32]]]) {
          for (const index of lower) joints[index].y = joints[hip].y + 0.78 * (joints[index].y - joints[hip].y);
        }
      }
      return joints;
    },
  });
  const rep = events.find(({ type }) => type === "rep-complete")?.rep;
  assert.equal(rep?.frames.length, 5);
  assert.equal(events.some(({ type }) => type === "rep-discarded"), false);
});

test("rearming keeps the planted reference when a standing sample shortens both legs", () => {
  const tracker = new SquatTracker();
  const events = [];
  let armed = true;
  let finishedAt;
  let returnedAt;
  let rearmedAt;
  for (let time = 0; time <= 12600; time += 80) {
    const depth = time < 6200 ? depthAt(time - standingMs) : depthAt(time - 7360);
    const landmarks = demoLandmarks(depth);
    if (time >= 5760 && time < 6640) {
      for (const [hip, lower] of [[23, [25, 27, 29, 31]], [24, [26, 28, 30, 32]]]) {
        for (const index of lower) {
          landmarks[index].y = landmarks[hip].y + 0.78 * (landmarks[index].y - landmarks[hip].y);
        }
      }
    }
    const state = tracker.update({ landmarks, timestampMs: time, width: 960, height: 540, armed });
    if (!armed && state.setup.ready) {
      armed = true;
      rearmedAt ??= time;
    }
    events.push(...state.events);
    const completion = state.events.find(({ type }) => type === "rep-complete");
    if (completion) {
      finishedAt ??= time;
      returnedAt ??= completion.rep.returnedAtMs;
      armed = false;
    }
  }
  assert.ok(rearmedAt > finishedAt);
  assert.ok(rearmedAt - returnedAt >= 1000);
  assert.equal(events.filter(({ type }) => type === "rep-complete").length, 2);
  assert.equal(events.some(({ type }) => type === "rep-discarded"), false);
});

test("whole-pose translation does not change squat phases, depth or tempo", () => {
  const completed = ({ events }) => events.find(({ type }) => type === "rep-complete")?.rep;
  const baseline = completed(run({ interval: 80 }));
  const shifted = run({
    interval: 80,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time >= 3520) {
        for (const joint of joints) {
          joint.x += 0.08;
          joint.y -= 0.09;
        }
      }
      return joints;
    },
  });
  const rep = completed(shifted);
  assert.ok(rep);
  assert.ok(!shifted.events.some(({ type }) => type === "rep-discarded"));
  assert.deepEqual(rep.frames, baseline.frames);
  for (const field of ["hipDropLegLengths", "kneeAngleAtBottomDeg", "peakAscentLegLengthsPerSec",
    "peakDescentLegLengthsPerSec", "averageAscentLegLengthsPerSec", "averageDescentLegLengthsPerSec"]) {
    assert.equal(rep.metrics[field], baseline.metrics[field], field);
  }
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

test("barbell stance changes stay trackable, while a front-facing setup is still rejected", () => {
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
  assert.ok(!stepping.events.some(({ type }) => type === "rep-discarded"));
  const rep = stepping.events.find(({ type }) => type === "rep-complete")?.rep;
  assert.deepEqual(rep?.frames.map(({ phase }) => phase), ["start", "descent", "bottom", "ascent", "finish"]);
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

test("an isolated ankle spike does not count as squat onset", () => {
  const anomaly = 2640;
  const { states, events } = run({
    interval: 80,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time === anomaly) joints[27].x += 0.09;
      return joints;
    },
  });
  assert.equal(states[anomaly / 80].phase, "ready");
  assert.ok(!states[anomaly / 80].events.some(({ type }) => type === "capture"));
  assert.equal(events.filter(({ type }) => type === "rep-complete").length, 1);
  assert.equal(events.some(({ type }) => type === "rep-discarded"), false);
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

test("a sustained foot change during descent carries through the finish", () => {
  const movedFoot = run({
    interval: 80,
    points(depth, time) {
      const joints = demoLandmarks(depth);
      if (time >= 3440) {
        for (const index of [27, 29, 31]) joints[index].x += 0.054;
      }
      return joints;
    },
  });
  assert.ok(!movedFoot.events.some(({ type }) => type === "rep-discarded"));
  const rep = movedFoot.events.find(({ type }) => type === "rep-complete")?.rep;
  assert.equal(rep?.frames.length, 5);
});

test("a sustained turn during capture still invalidates the rep", () => {
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

test("lifting and repositioning a foot without lowering the hips does not trigger a squat", () => {
  for (const farFootVisible of [true, false]) {
    const { states, events } = run({
      interval: 80,
      points(_depth, time) {
        const joints = demoLandmarks(0);
        const progress = Math.max(0, Math.min(1, (time - 2480) / 920));
        const lift = Math.sin(Math.PI * progress);
        for (const index of [27, 29, 31]) {
          joints[index].x += 0.055 * progress;
          joints[index].y -= 0.10 * lift;
        }
        joints[25].x += 0.075 * lift;
        if (!farFootVisible) joints[28].visibility = 0.2;
        return joints;
      },
    });
    assert.ok(states[2000 / 80].setup.ready);
    assert.ok(!events.some(({ type }) => type === "capture" || type === "rep-complete"));
  }
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

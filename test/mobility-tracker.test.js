import test from 'node:test';
import assert from 'node:assert/strict';
import { MobilityTracker } from '../src/mobility-tracker.js';

const WIDTH = 960, HEIGHT = 540;
const BASE = {
  shoulder: [480, 170], elbow: [527, 178], wrist: [570, 170],
  hip: [476, 286], knee: [476, 374], ankle: [475, 456], heel: [466, 469], toe: [500, 469],
};
const PLANK = {
  shoulder: [582, 298], elbow: [584, 365], wrist: [583, 430],
  hip: [456.4, 349.5], knee: [350.2, 393], ankle: [260, 430], heel: [247, 421], toe: [275, 441],
};
const IDS = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 };
const cosine = (fraction) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, fraction)))) / 2;

function landmarksFor(exercise, amount, { side = 'left', frontal = false, onlyFarMoves = false } = {}) {
  const move = (name) => ({
    'push-up': {
      shoulder: [22, 72], elbow: [-42, 33], hip: [13.4, 43.9], knee: [6.2, 20.2],
    },
    'knee-raise': {
      knee: [85, -94], ankle: [85, -87], heel: [85, -87], toe: [85, -87],
    },
    'heel-raise': {
      shoulder: [2, -24], elbow: [1, -15], hip: [3, -24], knee: [5, -24],
      ankle: [8, -21], heel: [8, -25],
    },
  })[exercise][name] ?? [0, 0];

  const point = (x, y, visibility) => ({ x: x / WIDTH, y: y / HEIGHT, visibility });
  const landmarks = Array.from({ length: 33 }, () => point(480, 120, 0));
  const push = exercise === 'push-up';
  landmarks[0] = push ? point(620 + amount * 22, 300 + amount * 72, .99)
    : point(502 + amount * 2, 121 - (exercise === 'heel-raise' ? amount * 24 : 0), .99);
  const sideOffset = side === 'left' ? 0 : 1;
  for (const [name, [x, y]] of Object.entries(push ? PLANK : BASE)) {
    const [dx, dy] = move(name);
    const farDx = frontal ? 95 : -7;
    const nearAmount = onlyFarMoves ? 0 : amount;
    const farAmount = exercise === 'knee-raise' && !onlyFarMoves ? 0 : amount;
    landmarks[IDS[name] + sideOffset] = point(x + dx * nearAmount, y + dy * nearAmount, 0.99);
    landmarks[IDS[name] + (1 - sideOffset)] = point(x + farDx + dx * farAmount, y - 3 + dy * farAmount, 0.8);
  }
  return landmarks;
}

function run(exercise, { interval = 80, duration = 6000, amplitude = 1, side = 'left', miss = [], frontal, onlyFarMoves, adjust } = {}) {
  const tracker = new MobilityTracker(exercise);
  const frames = [], events = [];
  let armed = false;
  for (let time = 0; time <= duration; time += interval) {
    const elapsed = time - 1440;
    const amount = (elapsed < 1200 ? cosine(elapsed / 1200) : elapsed < 1500 ? 1 : 1 - cosine((elapsed - 1500) / 1000)) * amplitude;
    const landmarks = miss.includes(time) ? null : landmarksFor(exercise, amount, { side, frontal, onlyFarMoves });
    if (landmarks) adjust?.(landmarks, time);
    const state = tracker.update({ landmarks, timestampMs: time, width: WIDTH, height: HEIGHT, armed });
    if (state.setup.ready) armed = true;
    frames.push({ time, ...state });
    events.push(...state.events);
  }
  return { frames, events };
}

for (const [exercise, unit, min, max] of [
  ['push-up', 'degrees', 45, 145],
  ['knee-raise', 'degrees', 72, 110],
  ['heel-raise', 'leg-lengths', 0.08, 0.19],
]) {
  test(`${exercise} captures real movement evidence after a full second of profile setup`, () => {
    const { frames, events } = run(exercise);
    assert.equal(frames.find(({ setup }) => setup.ready)?.time, 1040);
    const results = events.filter(({ type }) => type === 'rep-complete');
    assert.equal(results.length, 1);
    const { rep } = results[0];
    assert.equal(rep.exercise, exercise);
    assert.equal(rep.side, 'left');
    assert.equal(rep.metrics.rangeUnit, unit);
    assert.ok(rep.metrics.range > min && rep.metrics.range < max, String(rep.metrics.range));
    assert.ok(rep.metrics.outwardMs > 700 && rep.metrics.returnMs > 500);
    assert.ok(rep.metrics.averageOutwardSpeedPerSec > 0 && rep.metrics.averageReturnSpeedPerSec > 0);
    assert.equal(rep.metrics.durationMs, rep.metrics.outwardMs + rep.metrics.holdMs + rep.metrics.returnMs);
    assert.equal(rep.metrics.validFrameFraction, 1);
    assert.equal(rep.metrics.maxTrackingGapMs, 80);
    assert.deepEqual(rep.frames.map(({ phase }) => phase), ['start', 'descent', 'bottom', 'ascent', 'finish']);
    const times = rep.frames.map(({ timestampMs }) => timestampMs);
    assert.ok(times.every((value, index) => !index || value >= times[index - 1]));
    assert.ok(Math.abs(times[2] - 2640) <= 100);
    assert.ok(rep.frames.slice(1, 4).every(({ timestampMs }) =>
      events.some((event) => event.type === 'capture-candidate' && event.timestampMs === timestampMs)));
  });
}

test('keeps the calibrated camera side, works in the opposite direction, and ignores the far knee', () => {
  const far = run('knee-raise', { side: 'right', onlyFarMoves: true });
  assert.equal(far.frames.find(({ setup }) => setup.ready)?.live.side, 'right');
  assert.ok(!far.events.some(({ type }) => type === 'rep-complete' || type === 'capture-candidate'));
  const { events } = run('knee-raise', { side: 'right', adjust(landmarks) {
    for (const joint of landmarks) joint.x = 1 - joint.x;
  } });
  assert.equal(events.find(({ type }) => type === 'rep-complete')?.rep.side, 'right');
});

test('rejects a frontal setup and a shallow effort for all three exercises', () => {
  for (const exercise of ['push-up', 'knee-raise', 'heel-raise']) {
    const frontal = run(exercise, { frontal: true });
    assert.ok(frontal.frames.every(({ setup }) => !setup.ready && !setup.checks.sideOn));
    const shallow = run(exercise, { amplitude: 0.15 });
    assert.ok(shallow.frames.some(({ setup }) => setup.ready));
    assert.ok(!shallow.events.some(({ type }) => type === 'rep-complete'));
  }
});

test('push-up setup requires a steady top plank instead of slow travel', () => {
  const tracker = new MobilityTracker('push-up');
  const frames = [];
  for (let time = 0; time <= 3000; time += 80) {
    const landmarks = landmarksFor('push-up', 0);
    const gradualShift = 60 * Math.min(1, time / 1200);
    for (const point of landmarks) point.x += gradualShift / WIDTH;
    frames.push({ time, ...tracker.update({ landmarks, timestampMs: time, width: WIDTH, height: HEIGHT, armed: false }) });
  }
  assert.ok(frames.filter(({ time }) => time <= 1200).every(({ setup }) => !setup.ready));
  assert.ok(frames.some(({ time, setup }) => time >= 1200 && setup.ready));
});

test('push-up requires a floor plank, elbow bend and descending hips', () => {
  for (const [name, transform] of [
    ['standing with arms extended', (landmarks) => {
      const upright = landmarksFor('knee-raise', 0);
      landmarks.splice(0, landmarks.length, ...upright);
    }],
    ['hands elevated well above the toes', (landmarks) => {
      for (const i of [0, 11, 12, 13, 14, 15, 16]) landmarks[i].y -= 95 / HEIGHT;
    }],
    ['kneeling', (landmarks) => {
      for (const i of [25, 26]) landmarks[i].y += 45 / HEIGHT;
    }],
  ]) {
    const { frames, events } = run('push-up', { adjust: transform });
    assert.ok(frames.every(({ setup }) => !setup.ready), name);
    assert.ok(!events.some(({ type }) => type === 'rep-complete'), name);
  }

  const { events } = run('push-up', { adjust(landmarks) {
    for (const i of [23, 24, 25, 26]) landmarks[i].y = (PLANK[i < 25 ? 'hip' : 'knee'][1] + (i % 2 === 0 ? -3 : 0)) / HEIGHT;
  } });
  assert.ok(!events.some(({ type }) => type === 'rep-complete'));
});

test('push-up accepts mirrored camera side, arm/foot model jitter and an obscured toe', () => {
  const { frames, events } = run('push-up', { side: 'right', adjust(landmarks, time) {
    for (const joint of landmarks) joint.x = 1 - joint.x;
    landmarks[32].visibility = .18;
    if (time >= 2240 && time <= 2560) {
      landmarks[16].x += 12 / WIDTH;
      landmarks[16].y += 4 / HEIGHT;
      landmarks[28].x += 9 / WIDTH;
    }
  } });
  assert.equal(frames.find(({ setup }) => setup.ready)?.live.side, 'right');
  const rep = events.find(({ type }) => type === 'rep-complete')?.rep;
  assert.ok(rep);
  assert.equal(rep.side, 'right');
  assert.equal(rep.frames.length, 5);
  assert.ok(!events.some(({ type }) => type === 'rep-discarded'));
});

test('freestanding raises work with hidden arms; visible heel raises require both feet', () => {
  for (const exercise of ['knee-raise', 'heel-raise']) {
    const { events } = run(exercise, { adjust(landmarks) {
      for (const i of [13, 14, 15, 16]) landmarks[i].visibility = .05;
    } });
    assert.ok(events.some(({ type }) => type === 'rep-complete'), exercise);
  }
  const singleHeel = run('heel-raise', { adjust(landmarks) {
    for (const [name, id] of [['ankle', 28], ['heel', 30]]) {
      landmarks[id].x = (BASE[name][0] - 7) / WIDTH;
      landmarks[id].y = (BASE[name][1] - 3) / HEIGHT;
    }
  } });
  assert.ok(singleHeel.frames.some(({ setup }) => setup.ready));
  assert.ok(!singleHeel.events.some(({ type }) => type === 'rep-complete'));
});

test('traverses a short occlusion without counting it as usable evidence, discards prolonged loss', () => {
  const missing = [2240, 2320];
  const short = run('heel-raise', { miss: missing });
  const rep = short.events.find(({ type }) => type === 'rep-complete')?.rep;
  assert.ok(rep);
  assert.equal(rep.metrics.maxTrackingGapMs, 240);
  assert.ok(rep.metrics.validFrameFraction < 1);
  assert.ok(rep.frames.every(({ timestampMs }) => !missing.includes(timestampMs)));
  const long = run('heel-raise', { miss: [2240, 2320, 2400, 2480, 2560, 2640] });
  assert.ok(long.events.some(({ type, reason }) => type === 'rep-discarded' && reason === 'tracking-gap'));
  assert.ok(!long.events.some(({ type }) => type === 'rep-complete'));
});

test('a sustained hand or support-foot relocation invalidates an active rep', () => {
  for (const [exercise, moved] of [['push-up', [15]], ['push-up', [27, 29, 31]], ['knee-raise', [28]], ['heel-raise', [31]]]) {
    const { events } = run(exercise, { adjust(landmarks, time) {
      if (time >= 2240 && time <= 2640) for (const landmark of moved) landmarks[landmark].x += 0.07;
    } });
    assert.ok(events.some(({ type, reason }) => type === 'rep-discarded' && reason === 'foot-moved'), `${exercise} ${moved}`);
    assert.ok(!events.some(({ type }) => type === 'rep-complete'), `${exercise} ${moved}`);
  }
});

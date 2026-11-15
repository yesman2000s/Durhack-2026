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

test('push-up calibrates and completes from varied personal top positions', () => {
  const variants = [
    ['soft elbows', (points) => { for (const index of [13, 14]) points[index].x -= 28 / WIDTH; }],
    ['hands further forward', (points) => {
      for (const index of [15, 16]) points[index].x += 90 / WIDTH;
      for (const index of [13, 14]) points[index].x += 45 / WIDTH;
    }],
    ['slightly raised hips', (points) => { for (const index of [23, 24]) points[index].y -= 45 / HEIGHT; }],
    ['oblique view with a visible near arm', (points) => {
      points[12].x = points[11].x + 95 / WIDTH;
      points[24].x = points[23].x + 70 / WIDTH;
    }],
    ...[-10, 10].map((degrees) => [`camera rolled ${degrees} degrees`, (points) => {
      const radians = degrees * Math.PI / 180;
      for (const point of points) {
        const x = point.x * WIDTH - WIDTH / 2, y = point.y * HEIGHT - HEIGHT / 2;
        point.x = (WIDTH / 2 + x * Math.cos(radians) - y * Math.sin(radians)) / WIDTH;
        point.y = (HEIGHT / 2 + x * Math.sin(radians) + y * Math.cos(radians)) / HEIGHT;
      }
    }]),
  ];
  for (const [name, adjust] of variants) {
    for (const mirrored of [false, true]) {
      const label = `${name}${mirrored ? ', mirrored' : ''}`;
      const { frames, events } = run('push-up', { adjust(points) {
        adjust(points);
        if (mirrored) for (const point of points) point.x = 1 - point.x;
      } });
      assert.equal(frames.find(({ setup }) => setup.ready)?.time, 1040, label);
      const completed = events.filter(({ type }) => type === 'rep-complete');
      assert.equal(completed.length, 1, label);
      assert.equal(completed[0].rep.frames.length, 5, label);
      assert.ok(!events.some(({ type }) => type === 'rep-discarded'), label);
    }
  }
});

test('the broader push-up setup still rejects a held bottom, seated posture and deep pike', () => {
  for (const [name, makePose] of [
    ['bottom of a push-up', () => landmarksFor('push-up', 1)],
    ['seated with arms extended', () => {
      const points = landmarksFor('knee-raise', 0);
      for (const index of [25, 26, 27, 28, 29, 30, 31, 32]) points[index].x += 90 / WIDTH;
      return points;
    }],
    ['deep pike', () => {
      const points = landmarksFor('push-up', 0);
      for (const index of [23, 24]) points[index].y -= 120 / HEIGHT;
      return points;
    }],
  ]) {
    const tracker = new MobilityTracker('push-up');
    for (let time = 0; time <= 2000; time += 80) {
      const state = tracker.update({ landmarks: makePose(), timestampMs: time, width: WIDTH, height: HEIGHT });
      assert.equal(state.setup.ready, false, name);
      assert.equal(state.events.length, 0, name);
    }
  }
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

test('requires landmark presence as well as visibility and rejects nonfinite confidence', () => {
  for (const exercise of ['push-up', 'knee-raise', 'heel-raise']) {
    for (const estimates of [{ presence: 0.1 }, { presence: NaN }, { visibility: Infinity }]) {
      const { frames, events } = run(exercise, { adjust(landmarks) {
        for (const index of [25, 26]) Object.assign(landmarks[index], estimates);
      } });
      assert.ok(frames.every(({ setup }) => !setup.ready), `${exercise} ${Object.keys(estimates)}`);
      assert.equal(events.length, 0);
    }
    const missingAt = 2240;
    const { events } = run(exercise, { adjust(landmarks, time) {
      if (time === missingAt) landmarks[25].presence = 0.1;
    } });
    const rep = events.find(({ type }) => type === 'rep-complete')?.rep;
    assert.ok(rep, exercise);
    assert.ok(rep.metrics.validFrameFraction < 1, exercise);
    assert.ok(!events.some(({ type, timestampMs }) => type === 'capture-candidate' && timestampMs === missingAt));
  }
});

test('ignores a displaced limb segment even when total leg length and confidence still look valid', () => {
  for (const [exercise, adjust] of [
    ['knee-raise', (points) => {
      // Moving a knee along the hip-to-ankle line preserves overall leg length.
      points[25].x = points[23].x * 0.78 + points[27].x * 0.22;
      points[25].y = points[23].y * 0.78 + points[27].y * 0.22;
    }],
    ['push-up', (points) => { points[13].x -= 150 / WIDTH; }],
  ]) {
    const badTime = 2240;
    const { frames, events } = run(exercise, { adjust(landmarks, time) {
      if (time === badTime) adjust(landmarks);
    } });
    assert.equal(frames.find(({ time }) => time === badTime).live, null, exercise);
    assert.ok(!events.some(({ type, timestampMs }) => type === 'capture-candidate' && timestampMs === badTime));
    const rep = events.find(({ type }) => type === 'rep-complete')?.rep;
    assert.ok(rep, exercise);
    assert.ok(rep.metrics.validFrameFraction < 1);
    assert.ok(rep.frames.every(({ timestampMs }) => timestampMs !== badTime));
  }
});

test('invalid camera dimensions do not advance the frame clock or corrupt setup', () => {
  const tracker = new MobilityTracker('heel-raise');
  const frame = { landmarks: landmarksFor('heel-raise', 0), timestampMs: 0, width: WIDTH, height: HEIGHT };
  assert.equal(tracker.update({ ...frame, width: Infinity }).setup.ready, false);
  assert.equal(tracker.lastAt, null);
  for (let timestampMs = 0; timestampMs <= 1040; timestampMs += 80) tracker.update({ ...frame, timestampMs });
  assert.equal(tracker.phase, 'ready');
});

test('keeps comfortable reps through oblique projection and naturally changing limb lengths', () => {
  for (const exercise of ['push-up', 'knee-raise', 'heel-raise']) {
    const { events } = run(exercise, { amplitude: 0.65, adjust(landmarks, time) {
      // Horizontal foreshortening approximates a camera away from perfect profile.
      for (const point of landmarks) point.x = 0.5 + (point.x - 0.5) * 0.82;
      for (const index of [12, 24]) landmarks[index].x = landmarks[index - 1].x - 34 / WIDTH;
      if (exercise === 'knee-raise') {
        // Allow the raised thigh's projection to shorten as it turns in depth.
        const projection = 1 - 0.28 * cosine((time - 1440) / 1200);
        landmarks[25].x = landmarks[23].x + (landmarks[25].x - landmarks[23].x) * projection;
        landmarks[25].y = landmarks[23].y + (landmarks[25].y - landmarks[23].y) * projection;
      }
    } });
    assert.ok(events.some(({ type }) => type === 'rep-complete'), exercise);
    assert.ok(!events.some(({ type }) => type === 'rep-discarded'), exercise);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelinePlayer } from '../src/music/player.js';

const song = { bpm: 120 };
const part = (levels, exerciseId = 'squat') => ({ buffer: { duration: 56 }, exerciseId,
  levels: levels.map((level) => ({ level, enabled: true })) });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} ≠ ${expected}`);

function audioContext() {
  const sources = [], gains = [];
  const node = () => ({ disconnects: 0, connect(next) { return next; }, disconnect() { this.disconnects++; } });
  return {
    currentTime: 4, destination: {}, sources, gains,
    createGain() {
      const result = { ...node(), gain: { events: [],
        setValueAtTime(...args) { this.events.push(['set', ...args]); },
        linearRampToValueAtTime(...args) { this.events.push(['ramp', ...args]); },
        cancelScheduledValues(...args) { this.events.push(['cancel', ...args]); },
        setTargetAtTime(...args) { this.events.push(['target', ...args]); },
      } };
      gains.push(result); return result;
    },
    createBufferSource() {
      const result = { ...node(), stops: [], start(...args) { this.started = args; }, stop(...args) { this.stops.push(args); } };
      sources.push(result); return result;
    },
  };
}

test('pause retains position and resume starts at the precise source offset without old callbacks ending it', (t) => {
  const context = audioContext(); let ended = 0;
  const player = createTimelinePlayer(context, song, [part([1, 2])], { onEnded: () => ended++ });
  t.after(() => player.dispose());
  assert.equal(player.getState().status, 'paused');
  assert.equal(player.getState().duration, 16);
  assert.equal(context.sources.length, 0);
  player.play(); player.play();
  assert.equal(context.sources.length, 2);
  const oldCallbacks = context.sources.map((source) => source.onended);
  context.currentTime = 7.035;
  player.pause();
  near(player.getState().elapsed, 3);
  assert.equal(player.getState().status, 'paused');
  assert.ok(context.sources.every((source) => source.stops.length === 1));
  context.currentTime = 11;
  player.play();
  near(context.sources[2].started[0], 11.035);
  near(context.sources[2].started[1], 3);
  near(context.sources[2].started[2], 5);
  near(context.sources[3].started[0], 16.035);
  oldCallbacks.forEach((callback) => callback());
  assert.equal(ended, 0);
  assert.equal(player.getState().status, 'playing');
});

test('seeking clips the current block, keeps muted gaps, and never plays locked or disabled notes', (t) => {
  const context = audioContext();
  const input = part([1, 2, 3, 4, 7]);
  input.levels[2].enabled = false;
  input.levels[4].unlocked = false;
  const player = createTimelinePlayer(context, song, [input]);
  t.after(() => player.dispose());
  player.play();
  context.currentTime = 5;
  player.seek(11);
  const resumed = context.sources.slice(3);
  assert.equal(resumed.length, 2);
  near(resumed[0].started[0], 5.035);
  near(resumed[0].started[1], 11);
  near(resumed[0].started[2], 5);
  near(resumed[1].started[0], 18.035);
  near(resumed[1].started[1], 24);
  player.seek(20);
  const afterGap = context.sources.at(-1);
  near(afterGap.started[0], 9.035);
  near(afterGap.started[1], 24);
  assert.equal(player.getState().duration, 32);
  near(player.getState().beat, 40);
});

test('single-note preview time is relative but seeks and beat highlights retain canonical positions', (t) => {
  const context = audioContext();
  const player = createTimelinePlayer(context, song, [part([7])], { preview: true });
  t.after(() => player.dispose());
  assert.equal(player.getState().duration, 8);
  assert.equal(player.getState().beat, 96);
  player.seek(3); player.play();
  assert.deepEqual(context.sources[0].started, [4.035, 51, 5]);
  context.currentTime = 5.035;
  near(player.getState().elapsed, 4);
  near(player.getState().beat, 104);
  near(player.getState().progress, 0.5);
});

test('repeat queues the next cycle without a gap and can be disabled mid-cycle', (t) => {
  const context = audioContext(); let ended = 0;
  const player = createTimelinePlayer(context, song, [part([1])], { loop: true, onEnded: () => ended++ });
  t.after(() => player.dispose());
  player.play();
  assert.deepEqual(context.sources.map(({ started }) => started), [[4.035, 0, 8], [12.035, 0, 8]]);
  context.currentTime = 12.035;
  context.sources[0].onended();
  near(player.getState().elapsed, 0);
  near(context.sources[2].started[0], 20.035);
  assert.equal(ended, 0);
  context.currentTime = 13.035;
  player.setLoop(false);
  const finalSource = context.sources.at(-1);
  near(finalSource.started[1], 1);
  near(finalSource.started[2], 7);
  context.currentTime = finalSource.started[0] + finalSource.started[2];
  finalSource.onended();
  assert.equal(player.getState().status, 'ended');
  assert.equal(ended, 1);
});

test('volume changes update the live master gain, including mute, without pausing or rescheduling', (t) => {
  const context = audioContext();
  const player = createTimelinePlayer(context, song, [part([1]), part([1], 'knee-raise')]);
  t.after(() => player.dispose());
  player.play();
  const count = context.sources.length;
  player.setVolume(0);
  assert.equal(player.getState().volume, 0);
  assert.equal(player.getState().status, 'playing');
  assert.deepEqual(context.gains[0].gain.events.at(-1), ['target', 0, 4, 0.01]);
  player.setVolume(2);
  assert.equal(player.getState().volume, 1);
  near(context.gains[0].gain.events.at(-1)[1], 1 / Math.sqrt(2));
  player.setVolume(Number.NaN);
  assert.equal(player.getState().volume, 1);
  assert.equal(context.sources.length, count);
});

test('stop and explicit end seek do not report a natural completion; replay starts from zero', (t) => {
  const context = audioContext(); let ended = 0;
  const player = createTimelinePlayer(context, song, [part([1])], { onEnded: () => ended++ });
  t.after(() => player.dispose());
  player.play(); player.seek(100);
  assert.equal(player.getState().elapsed, 8);
  assert.equal(player.getState().status, 'ended');
  assert.equal(ended, 0);
  player.play();
  assert.equal(context.sources.at(-1).started[1], 0);
  player.stop(); player.stop();
  assert.equal(player.getState().status, 'paused');
  assert.equal(player.getState().elapsed, 0);
  assert.equal(ended, 0);
});

test('progress uses the audio clock and disposal cancels all timers, sources, and future notifications', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = audioContext(), updates = [];
  const player = createTimelinePlayer(context, song, [part([1, 2])], { onChange: (state) => updates.push(state) });
  player.play();
  context.currentTime = 6.035;
  t.mock.timers.tick(100);
  near(updates.at(-1).elapsed, 2);
  player.pause(); player.play();
  const callbacks = context.sources.map((source) => source.onended).filter(Boolean);
  player.dispose(); player.dispose();
  const calls = updates.length, sources = context.sources.length;
  callbacks.forEach((callback) => callback());
  context.currentTime = 100;
  t.mock.timers.tick(1000);
  player.play(); player.seek(4); player.setVolume(0.5); player.setLoop(true); player.stop();
  assert.equal(updates.length, calls);
  assert.equal(context.sources.length, sources);
  assert.ok(context.sources.every((source) => source.disconnects === 1));
  assert.ok(context.gains.every((gain) => gain.disconnects === 1));
});

test('empty arrangements stay silent and scheduling failures leave a reusable paused transport', (t) => {
  const emptyContext = audioContext(); let ended = 0;
  const empty = createTimelinePlayer(emptyContext, song, [], { loop: true, onEnded: () => ended++ });
  t.after(() => empty.dispose());
  empty.play(); empty.play();
  assert.equal(empty.getState().duration, 0);
  assert.equal(emptyContext.sources.length, 0);
  assert.equal(ended, 0);
  const context = audioContext();
  const createSource = context.createBufferSource;
  context.createBufferSource = () => {
    const source = createSource();
    source.start = () => { throw new Error('Audio device unavailable'); };
    return source;
  };
  const player = createTimelinePlayer(context, song, [part([1])]);
  t.after(() => player.dispose());
  assert.throws(() => player.play(), /Audio device unavailable/);
  assert.equal(player.getState().status, 'paused');
  assert.ok(context.sources.every((source) => source.disconnects === 1));
  context.createBufferSource = createSource;
  player.play();
  assert.equal(player.getState().status, 'playing');
});

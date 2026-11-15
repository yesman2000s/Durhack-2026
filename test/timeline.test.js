import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_BEATS, partForTrack, planTimeline, playTimeline } from '../src/music/timeline.js';
import { songs } from '../src/music/songs.js';

const song = { bpm: 120 };
const buffer = { duration: 56 };
const part = (levels, exerciseId = 'squat') => ({ buffer, exerciseId, levels: levels.map((level) => ({ level, enabled: true })) });

function audioContext() {
  const sources = [];
  const gains = [];
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
      gains.push(result);
      return result;
    },
    createBufferSource() {
      const result = { ...node(), stops: [], start(...args) { this.started = args; }, stop(...args) { this.stops.push(args); } };
      sources.push(result);
      return result;
    },
  };
}

test('each movement uses a distinct, shipped stem in every genre', () => {
  const movements = ['squat', 'knee-raise', 'push-up', 'heel-raise'];
  assert.deepEqual(movements.map((id) => partForTrack(songs[2], { id }).stem), ['drums', 'bass', 'piano', 'guitar']);
  for (const track of songs.slice(0, 2)) {
    assert.deepEqual(movements.map((id) => partForTrack(track, id).stem), ['drums-low', 'bass', 'other', 'drums-high']);
  }
  assert.throws(() => partForTrack(songs[0], 'unknown'), /no music track/);
});

test('rearranging visual blocks preserves canonical playback times and original offsets', () => {
  assert.equal(BLOCK_BEATS, 16);
  const original = [part([1, 2, 7]), part([1, 3], 'knee-raise')];
  const reordered = original.toReversed().map((entry) => ({ ...entry, levels: entry.levels.toReversed().map((block, visualPosition) => ({ ...block, visualPosition })) }));
  assert.deepEqual(planTimeline(song, reordered), planTimeline(song, original));
  assert.deepEqual(planTimeline(song, original).blocks.map(({ level, start, offset }) => [level, start, offset]), [
    [1, 0, 0], [1, 0, 0], [2, 8, 8], [3, 16, 16], [7, 48, 48],
  ]);
  assert.equal(planTimeline(song, original).duration, 56);
});

test('muted and explicitly locked blocks leave gaps and never extend playback', () => {
  const input = part([1, 2, 3, 4, 7]);
  input.levels[0].enabled = false;
  input.levels[2].enabled = false;
  input.levels[4].unlocked = false;
  const plan = planTimeline(song, [input]);
  assert.deepEqual(plan.blocks.map(({ level, start, end }) => [level, start, end]), [[2, 8, 16], [4, 24, 32]]);
  assert.equal(plan.duration, 32);
  assert.equal(planTimeline(song, [{ ...input, enabled: false }]).duration, 0);
});

test('invalid, repeated, and out-of-buffer blocks cannot create excess playback', () => {
  const input = { ...part([0, 1, 1, 2, 3, 8, 1.5]), buffer: { duration: 10 } };
  const plan = planTimeline(song, [input]);
  assert.deepEqual(plan.blocks.map(({ level, duration }) => [level, duration]), [[1, 8], [2, 2]]);
  assert.equal(plan.duration, 10);
  assert.throws(() => planTimeline({ bpm: 0 }, []), /tempo/);
});

test('scheduled chunks preserve gaps, synchronize lanes, and do not overlap at boundaries', () => {
  const context = audioContext();
  let ended = 0;
  playTimeline(context, song, [part([1, 2, 4]), part([2], 'knee-raise')], () => ended++);
  assert.deepEqual(context.sources.map(({ started }) => started), [
    [4.035, 0, 8], [12.035, 8, 8], [12.035, 8, 8], [28.035, 24, 8],
  ]);
  for (let index = 0; index < context.sources.length; index++) {
    const [start, , duration] = context.sources[index].started;
    const events = context.gains[index + 1].gain.events;
    assert.deepEqual(events[0], ['set', 0, start]);
    assert.deepEqual(events.at(-1), ['ramp', 0, start + duration]);
    assert.ok(events[1][2] <= events[2][2]);
  }
  context.sources[0].onended();
  assert.equal(ended, 0);
  for (const source of context.sources.slice(1)) source.onended();
  context.sources.at(-1).onended();
  assert.equal(ended, 1);
  assert.equal(context.gains[0].disconnects, 1);
});

test('single-block previews start immediately but play the correct source section', () => {
  const context = audioContext();
  const progress = [];
  playTimeline(context, song, [part([7])], () => {}, { preview: true, onProgress: (value) => progress.push(value) });
  assert.deepEqual(context.sources[0].started, [4.035, 48, 8]);
  assert.deepEqual(progress[0], { elapsed: 0, duration: 8, beat: 96, progress: 0 });
  context.sources[0].onended();
  assert.deepEqual(progress.at(-1), { elapsed: 8, duration: 8, beat: 112, progress: 1 });
});

test('stop fades and stops every scheduled source exactly once', () => {
  const context = audioContext();
  let ended = 0;
  const stop = playTimeline(context, song, [part([1, 7])], () => ended++);
  stop();
  stop();
  for (const source of context.sources) {
    assert.deepEqual(source.stops, [[4.02]]);
    source.onended();
  }
  stop();
  assert.equal(ended, 1);
  assert.equal(context.gains[0].disconnects, 1);
});

test('an empty mix completes once even when stopped before its completion microtask', async () => {
  const context = audioContext();
  let ended = 0;
  const stop = playTimeline(context, song, [], () => ended++);
  stop();
  await Promise.resolve();
  assert.equal(ended, 1);
  assert.equal(context.sources.length, 0);
});

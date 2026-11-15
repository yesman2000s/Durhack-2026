import test from 'node:test';
import assert from 'node:assert/strict';
import { waveformForBuffer } from '../src/music/waveform.js';

const buffer = (channels, sampleRate = 4) => ({ sampleRate, numberOfChannels: channels.length,
  getChannelData: (index) => Float32Array.from(channels[index]),
});

test('silent audio stays flat and has seven fixed-resolution sections', () => {
  const sections = waveformForBuffer(buffer([Array(280).fill(0)]), 8);
  assert.equal(sections.length, 7);
  assert.ok(sections.every((section) => section.length === 32 && section.every((sample) => sample === 0)));
});

test('waveform bins preserve actual section energy and relative dynamics', () => {
  const sections = waveformForBuffer(buffer([[1, 1, .5, .5, .25, .25, 0, 0]]), 1, { bins: 2, levels: 2 });
  assert.deepEqual(sections, [[1, .5], [.25, 0]]);
});

test('stereo energy cannot cancel and audio in either channel remains visible', () => {
  const opposite = waveformForBuffer(buffer([[1, -1, 1, -1], [-1, 1, -1, 1]]), 1, { bins: 2, levels: 1 });
  assert.deepEqual(opposite, [[1, 1]]);
  const oneSided = waveformForBuffer(buffer([[0, 0, 1, 1], [1, 1, 0, 0]]), 1, { bins: 2, levels: 1 });
  assert.deepEqual(oneSided, [[1, 1]]);
});

test('a short final clip keeps its timing and all later sections are empty', () => {
  const sections = waveformForBuffer(buffer([[1, 1, 1, 1, 1]]), 1, { bins: 2, levels: 3 });
  assert.deepEqual(sections, [[1, 1], [1, 0], [0, 0]]);
});

test('uneven bin boundaries include each sample and invalid samples cannot poison the outline', () => {
  const sections = waveformForBuffer(buffer([[1, 1, 1, NaN, 1, 1]], 3), 1, { bins: 2, levels: 2 });
  assert.deepEqual(sections, [[1, 1], [0, 1]]);
  assert.throws(() => waveformForBuffer(buffer([[1]]), 0), TypeError);
  assert.throws(() => waveformForBuffer({}, 1), TypeError);
});

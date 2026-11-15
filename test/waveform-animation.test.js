import test from 'node:test';
import assert from 'node:assert/strict';
import { animateWaveform } from '../src/music/waveform-animation.js';

function harness({ reduced = false, hidden = false } = {}) {
  const frames = new Map(), listeners = new Map(), motionListeners = new Map();
  let sequence = 0, sampleCount = 0, audible = true, amplitude = 220;
  const bars = Array.from({ length: 32 }, () => ({ style: { removeProperty(key) { delete this[key]; } } }));
  const documentImpl = { hidden, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const media = { matches: reduced, addEventListener: (name, fn) => motionListeners.set(name, fn), removeEventListener: (name) => motionListeners.delete(name) };
  const windowImpl = { matchMedia: () => media, requestAnimationFrame: (fn) => { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: (id) => frames.delete(id) };
  const dispose = animateWaveform({ querySelectorAll: () => bars }, 'squat', (exerciseId, data) => {
    assert.equal(exerciseId, 'squat'); sampleCount++; data.fill(amplitude); return audible;
  }, { windowImpl, documentImpl });
  return { bars, frames, listeners, motionListeners, dispose, get samples() { return sampleCount; },
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); },
    setAudio(value, level = amplitude) { audible = value; amplitude = level; },
    setHidden(value) { documentImpl.hidden = value; listeners.get('visibilitychange')?.(); },
    setReduced(value) { media.matches = value; motionListeners.get('change')?.(); },
  };
}

test('waveform responds to measured audio and resets when the stream is inaudible', () => {
  const h = harness();
  h.frame();
  const loud = h.bars[0].style.transform;
  h.setAudio(true, 30); h.frame();
  assert.notEqual(h.bars[0].style.transform, loud);
  assert.ok(Number(h.bars[0].style.opacity) < 1);
  h.setAudio(false); h.frame();
  assert.equal(h.bars[0].style.transform, undefined);
  assert.equal(h.bars[0].style.opacity, undefined);
  h.dispose();
});

test('hidden tabs and reduced-motion preferences stop sampling and restore static bars', () => {
  const h = harness(); h.frame();
  h.setHidden(true); h.frame();
  assert.equal(h.samples, 1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.bars[0].style.transform, undefined);
  h.setHidden(false); h.frame();
  assert.equal(h.samples, 2);
  h.setReduced(true); h.frame();
  assert.equal(h.samples, 2);
  assert.equal(h.frames.size, 0);
  h.setReduced(false); h.frame();
  assert.equal(h.samples, 3);
  h.dispose();
  assert.equal(h.frames.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.motionListeners.size, 0);
  assert.equal(h.bars[0].style.transform, undefined);
});

test('starting with reduced motion schedules no animation frames', () => {
  const h = harness({ reduced: true }); h.frame();
  assert.equal(h.samples, 0);
  assert.equal(h.frames.size, 0);
  h.dispose();
});

import { earnedSegments, exercises } from './progression.js';

export const BPM = 90;
export const BARS = 8;
const stepsPerBar = 16;
const stepSeconds = 60 / BPM / 4;
const loopSteps = BARS * stepsPerBar;
const roots = [48, 45, 41, 43];
const chords = [[60, 64, 67, 71], [57, 60, 64, 67], [57, 60, 65, 69], [59, 62, 67, 69]];
const lead = [[76, 79, 74], [72, 76, 74], [72, 77, 76], [74, 71, 74]];
const midiHz = (note) => 440 * 2 ** ((note - 69) / 12);

export function createBeat(context) {
  const master = context.createGain();
  master.gain.value = 0.55;
  master.connect(context.destination);
  const buses = Object.fromEntries(exercises.map(({ id }) => {
    const bus = context.createGain();
    bus.connect(master);
    return [id, bus];
  }));

  const noise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.18), context.sampleRate);
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;

  function envelope(source, output, time, duration, level, attack = 0.008) {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(level, time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(gain).connect(output);
  }

  function tone(output, time, note, duration, level, type = 'triangle', endNote = note) {
    const voice = context.createOscillator();
    voice.type = type;
    voice.frequency.setValueAtTime(midiHz(note), time);
    voice.frequency.exponentialRampToValueAtTime(midiHz(endNote), time + Math.min(0.14, duration));
    envelope(voice, output, time, duration, level);
    voice.start(time);
    voice.stop(time + duration);
  }

  function percussion(time, cutoff, duration, level) {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = cutoff;
    source.buffer = noise;
    source.connect(filter);
    envelope(filter, buses.squat, time, duration, level, 0.003);
    source.start(time);
    source.stop(time + duration);
  }

  function scheduleStep(index, time, streaks) {
    const bar = Math.floor(index / stepsPerBar) % BARS;
    const step = index % stepsPerBar;
    const chordIndex = bar % chords.length;
    const root = roots[chordIndex] - 12;
    const [drums, bass, keys, melody] = exercises.map((exercise) => earnedSegments(exercise, streaks[exercise.id]));
    const chord = chords[chordIndex];
    const phrase = lead[chordIndex];

    if (drums >= 1 && [0, 6, 8, 14].includes(step)) {
      tone(buses.squat, time, 47, 0.23, step === 0 ? 0.7 : 0.48, 'sine', 30);
    }
    if (drums >= 2 && [4, 12].includes(step)) {
      percussion(time, 1700, 0.15, 0.36);
      tone(buses.squat, time, 52, 0.09, 0.13, 'triangle', 48);
    }
    if (drums >= 3 && step % 2 === 0) {
      percussion(time, 7000, step % 4 === 2 ? 0.062 : 0.032, step % 4 === 2 ? 0.21 : 0.13);
    }
    if (bass >= 1 && [0, 8].includes(step)) tone(buses['step-up'], time, root, 0.6, 0.25);
    if (bass >= 2 && [5, 13].includes(step)) tone(buses['step-up'], time, root + 7, 0.25, 0.17);
    if (bass >= 3 && [3, 11].includes(step)) tone(buses['step-up'], time, root + 12, 0.15, 0.15);
    if (keys >= 1 && step === 0) {
      chord.forEach((note) => tone(buses['calf-raise'], time, note, 1.45, 0.062, 'sine'));
    }
    if (keys >= 2 && step === 10) {
      chord.forEach((note) => tone(buses['calf-raise'], time, note, 0.65, 0.046));
    }
    if (keys >= 3 && step === 6) tone(buses['calf-raise'], time, chord[3] + 12, 0.78, 0.06, 'sine');
    if (melody >= 1 && [2, 7].includes(step)) {
      tone(buses['wall-push-up'], time, phrase[step === 2 ? 0 : 1], 0.42, 0.11);
    }
    if (melody >= 2 && [11, 14].includes(step)) {
      tone(buses['wall-push-up'], time, phrase[step === 11 ? 2 : 1], 0.28, 0.085);
    }
    if (melody >= 3 && step === 15 && bar % 2 === 1) {
      tone(buses['wall-push-up'], time, phrase[0] + 12, 0.18, 0.065, 'sine');
    }
  }

  let startTime = 0;
  let nextStep = 0;
  let timer;
  let current;
  let requested;

  function schedule() {
    // Skip elapsed steps after browser throttling while preserving the loop phase.
    const now = context.currentTime;
    if (startTime + nextStep * stepSeconds < now) {
      const nextLiveStep = Math.ceil((now - startTime) / stepSeconds);
      if (nextLiveStep > Math.ceil(nextStep / stepsPerBar) * stepsPerBar) current = requested;
      nextStep = nextLiveStep;
    }
    while (startTime + nextStep * stepSeconds < now + 0.12) {
      if (nextStep % stepsPerBar === 0) current = requested;
      scheduleStep(nextStep % loopSteps, startTime + nextStep * stepSeconds, current);
      nextStep += 1;
    }
  }

  return {
    start(streaks) {
      requested = streaks;
      current = streaks;
      startTime = context.currentTime + 0.045;
      schedule();
      timer = setInterval(schedule, 25);
    },
    setStreaks(streaks) { requested = streaks; },
    mute(id, muted) {
      buses[id].gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, 0.015);
    },
    bar() {
      const elapsed = Math.max(0, context.currentTime - startTime);
      return Math.floor(elapsed / (stepSeconds * stepsPerBar)) % BARS + 1;
    },
    stop() {
      clearInterval(timer);
      master.disconnect();
    },
  };
}

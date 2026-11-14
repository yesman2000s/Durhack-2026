import { earnedSegments, exercises } from './progression.js';

export const BARS = 8;
const barsPerPhrase = 4;
const audibleBarsByTier = [0, 1, 2, 4];

export async function loadStems(context, song) {
  return Promise.all(exercises.filter(({ stem }) => song.stems.includes(stem)).map(async (exercise) => {
    const { stem } = exercise;
    const response = await fetch(import.meta.env.BASE_URL + 'music-stems/' + song.id + '/' + stem + '.ogg');
    if (!response.ok) throw new Error('Missing ' + stem + ' stem');
    return { exercise, buffer: await context.decodeAudioData(await response.arrayBuffer()) };
  }));
}

export function createBeat(context, song, buffers) {
  const barDuration = 240 / song.bpm;
  const master = context.createGain();
  master.gain.value = 0.8;
  master.connect(context.destination);

  const tracks = buffers.map(({ exercise, buffer }) => {
    const source = context.createBufferSource();
    const gate = context.createGain();
    const mute = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.loopEnd = BARS * barDuration;
    gate.gain.value = 0;
    source.connect(gate).connect(mute).connect(master);
    return { exercise, source, gate, mute };
  });
  let startTime;
  let nextBar = 0;
  let timer;
  let mix;

  function schedule() {
    const now = context.currentTime;
    nextBar = Math.max(nextBar, Math.floor((now - startTime) / barDuration));
    while (startTime + nextBar * barDuration < now + 0.1) {
      const at = Math.max(now, startTime + nextBar * barDuration);
      tracks.forEach(({ gate }, index) => {
        const audible = nextBar % barsPerPhrase < audibleBarsByTier[mix[index]];
        gate.gain.setTargetAtTime(audible ? 1 : 0, at, 0.004);
      });
      nextBar += 1;
    }
  }

  function setStreaks(streaks) {
    mix = tracks.map(({ exercise }) => earnedSegments(exercise, streaks[exercise.id]));
  }

  return {
    start(streaks) {
      setStreaks(streaks);
      startTime = context.currentTime + 0.06;
      tracks.forEach(({ source }) => source.start(startTime));
      schedule();
      timer = setInterval(schedule, 25);
    },
    setStreaks,
    mute(id, muted) {
      const track = tracks.find(({ exercise }) => exercise.id === id);
      track?.mute.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, 0.012);
    },
    bar() {
      return Math.max(0, Math.floor((context.currentTime - startTime) / barDuration)) % BARS + 1;
    },
    stop() {
      clearInterval(timer);
      tracks.forEach(({ source }) => source.stop());
      master.disconnect();
    },
  };
}

export const EXCERPT_BEATS = 112;

export function rewardBeats(streak) {
  return Math.min(streak, EXCERPT_BEATS);
}

export async function loadStem(context, song, exercise) {
  const response = await fetch(import.meta.env.BASE_URL + 'music-stems/' + song.id + '/' + exercise.stem + '.ogg');
  if (!response.ok) throw new Error('The instrument track could not load.');
  return context.decodeAudioData(await response.arrayBuffer());
}

export function playReward(context, song, buffer, beats, onEnded) {
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  source.connect(gain).connect(context.destination);

  const start = context.currentTime + 0.035;
  const duration = Math.min(beats * 60 / song.bpm, buffer.duration);
  const end = start + duration;
  const level = 0.8;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(level, start + 0.008);
  gain.gain.setValueAtTime(level, end - 0.025);
  gain.gain.linearRampToValueAtTime(0, end);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
    onEnded();
  };
  source.start(start, 0, duration);

  return () => {
    const now = context.currentTime;
    gain.gain.cancelAndHoldAtTime(now);
    gain.gain.linearRampToValueAtTime(0, now + 0.012);
    source.stop(now + 0.012);
  };
}

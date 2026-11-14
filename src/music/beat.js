export const EXCERPT_BEATS = 112;

export function rewardBeats(streak) {
  return Math.min(streak / 4, EXCERPT_BEATS);
}

export async function loadStem(context, song, part) {
  const response = await fetch(import.meta.env.BASE_URL + 'music-stems/' + song.id + '/' + part.stem + '.ogg');
  if (!response.ok) throw new Error('The instrument track could not load.');
  return context.decodeAudioData(await response.arrayBuffer());
}

export function playReward(context, song, parts, onEnded) {
  const secondsPerBeat = 60 / song.bpm;
  const master = context.createGain();
  master.gain.value = 0.8 / Math.sqrt(parts.length);
  master.connect(context.destination);
  const activeSources = new Set();
  const tracks = parts.map(({ buffer, beats }) => {
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(master);
    activeSources.add(source);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      activeSources.delete(source);
      if (activeSources.size === 0) {
        master.disconnect();
        onEnded();
      }
    };
    return { source, gain, duration: Math.min(beats * secondsPerBeat, buffer.duration) };
  });

  const start = context.currentTime + 0.035;
  for (const { source, gain, duration } of tracks) {
    const end = start + duration;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(1, start + 0.008);
    gain.gain.setValueAtTime(1, end - 0.025);
    gain.gain.linearRampToValueAtTime(0, end);
    source.start(start, 0, duration);
  }

  return () => {
    const now = context.currentTime;
    master.gain.setTargetAtTime(0, now, 0.004);
    for (const source of activeSources) source.stop(now + 0.016);
  };
}

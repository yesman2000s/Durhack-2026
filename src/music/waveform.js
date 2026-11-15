// RMS envelopes from decoded PCM keep the outline tied to the sound. Channels
// contribute energy separately so opposite stereo phases cannot cancel out.
export function waveformForBuffer(buffer, secondsPerBlock, { bins = 32, levels = 7 } = {}) {
  if (!Number.isFinite(secondsPerBlock) || secondsPerBlock <= 0
      || !Number.isInteger(bins) || bins < 1 || bins > 256
      || !Number.isInteger(levels) || levels < 1 || levels > 64) {
    throw new TypeError('Waveform sections and resolution must be valid.');
  }
  if (!Number.isFinite(buffer?.sampleRate) || buffer.sampleRate <= 0
      || !Number.isInteger(buffer?.numberOfChannels) || buffer.numberOfChannels < 1
      || typeof buffer.getChannelData !== 'function') {
    throw new TypeError('Waveforms require decoded audio samples.');
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const samples = Math.min(...channels.map((channel) => channel.length));
  const samplesPerBin = secondsPerBlock * buffer.sampleRate / bins;
  let maximum = 0;
  const sections = Array.from({ length: levels }, (_, level) => Array.from({ length: bins }, (_, bin) => {
    const index = level * bins + bin;
    const start = Math.min(samples, Math.floor(index * samplesPerBin));
    const end = Math.min(samples, Math.floor((index + 1) * samplesPerBin));
    if (end <= start) return 0;
    let energy = 0;
    for (const channel of channels) {
      for (let sample = start; sample < end; sample++) {
        const amplitude = channel[sample];
        if (Number.isFinite(amplitude)) energy += amplitude * amplitude;
      }
    }
    const amplitude = Math.sqrt(energy / ((end - start) * channels.length));
    maximum = Math.max(maximum, amplitude);
    return amplitude;
  }));
  // Normalize across the whole stem, retaining relative volume between clips.
  if (!maximum) return sections;
  return sections.map((section) => section.map((amplitude) => amplitude / maximum));
}

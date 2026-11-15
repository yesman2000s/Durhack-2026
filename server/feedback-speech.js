import { normalizeFeedback } from './feedback.js';
import { HttpError, jsonRoute } from './json-route.js';

const defaultVoice = 'JBFqnCBsd6RMkjVDRZzb';

export function feedbackSpeechRoute({
  apiKey, voiceId = defaultVoice, fetchImpl = globalThis.fetch,
} = {}) {
  return jsonRoute({
    path: '/api/form-speech',
    maxBytes: 4096,
    sizeError: 'Feedback exceeds the 4 KiB limit.',
    timeoutError: 'ElevenLabs took too long. Try again.',
    unavailableError: 'Feedback audio is temporarily unavailable. Try again.',
  }, async (input, signal) => {
    const feedback = normalizeFeedback(input);
    if (!feedback) throw new HttpError(400, 'Send valid rep feedback and its coaching tips.');
    if (input.repNumber !== undefined && (!Number.isInteger(input.repNumber) || input.repNumber < 1 || input.repNumber > 10000)) {
      throw new HttpError(400, 'Include a valid rep number.');
    }
    if (!apiKey) throw new HttpError(503, 'Feedback audio is unavailable. Set ELEVENLABS_API_KEY on the server.');

    const intro = feedback.summary ?? (feedback.score === null
      ? 'A clearer view is needed to score this rep.'
      : `Your practice score is ${feedback.score} out of 100.`);
    const sentence = (text) => /[.!?]$/.test(text) ? text : `${text}.`;
    const narration = [input.repNumber ? `Rep ${input.repNumber}.` : null, intro, ...feedback.tips]
      .filter(Boolean).map(sentence).join(' ');
    const response = await fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: narration, model_id: 'eleven_flash_v2_5' }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      },
    );
    if (response.status === 429) throw new HttpError(429, 'Feedback audio is busy. Try again shortly.');
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') {
      throw new HttpError(502, 'ElevenLabs could not generate feedback audio.');
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length) throw new HttpError(502, 'ElevenLabs returned empty audio. Try again.');
    return { contentType: 'audio/mpeg', body };
  });
}

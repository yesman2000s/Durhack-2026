import { Readable } from 'node:stream';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { normalizeFeedback } from './feedback.js';
import { HttpError, jsonRoute } from './json-route.js';

const defaultVoice = 'JBFqnCBsd6RMkjVDRZzb';

export function feedbackSpeechRoute({
  apiKey, voiceId = defaultVoice, client = apiKey ? new ElevenLabsClient({ apiKey }) : undefined,
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
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    try {
      const { data: audio, rawResponse } = await client.textToSpeech.convert(voiceId, {
        text: narration, modelId: 'eleven_flash_v2_5', outputFormat: 'mp3_44100_128',
      }, {
        abortSignal: requestSignal, timeoutInSeconds: 20, maxRetries: 0,
      }).withRawResponse();
      if (rawResponse.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'audio/mpeg') {
        await audio.cancel();
        throw new HttpError(502, 'ElevenLabs could not generate feedback audio.');
      }
      // Keep the deadline and disconnect signal active while consuming the body.
      const chunks = [];
      for await (const chunk of Readable.fromWeb(audio, { signal: requestSignal })) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (!body.length) throw new HttpError(502, 'ElevenLabs returned empty audio. Try again.');
      return { contentType: 'audio/mpeg', body };
    } catch (error) {
      if (requestSignal.aborted) throw requestSignal.reason;
      if (error?.statusCode === 429) throw new HttpError(429, 'Feedback audio is busy. Try again shortly.');
      if (error?.name === 'ElevenLabsTimeoutError') throw new HttpError(504, 'ElevenLabs took too long. Try again.');
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'ElevenLabs could not generate feedback audio.');
    }
  });
}

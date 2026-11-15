import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { scoreForm, formScoringRoute } from '../server/form-scoring.js';
import { feedbackSpeechRoute } from '../server/feedback-speech.js';
import { normalizeFeedback } from '../server/feedback.js';

const jpeg = '/9j/2Q==';
const feedback = { score: 84, summary: 'You returned smoothly to your starting position.', tips: ['Lower a little more steadily on the next rep.'] };
const joint = { x: .5, y: .6, visibility: .91, presence: .86 };

function evidence(exercise = 'push-up') {
  return {
    id: 'rep-2', schemaVersion: 1, exercise, variant: 'bodyweight', source: 'webcam',
    captureMode: 'single-rep', capturedAt: '2026-11-14T21:00:00.000Z', trackingSide: 'left',
    camera: { width: 1280, height: 720 }, movementStartOffsetMs: 1200,
    metrics: { range: 52, rangeUnit: 'degrees', outwardMs: 1600, returnMs: 1100, validFrameFraction: .94, maxTrackingGapMs: 166 },
    reference: { establishedByThisRep: false, range: 50, standingTorsoToLegRatio: .55 },
    observations: [{ code: 'OBSERVED_CYCLE', message: 'One completed movement.' }],
    practiceGuide: { guidance: ['Use your comfortable range.'], measurementLimits: 'Projected side-view measurements.' },
    motionTrace: { frames: [
      { offsetMs: 0, joints: { hip: joint, elbow: { ...joint, presence: .3 } } },
      { offsetMs: 1200, joints: { hip: { ...joint, y: .7 }, elbow: joint } },
    ] },
    snapshots: ['finish', 'start', 'bottom'].map((phase, index) => ({
      phase, offsetMs: [4500, 0, 2600][index], width: 1280, height: 720,
      kneeAngleDeg: 153, pose: { side: 'left', hipAngleDeg: 148, joints: { hip: joint, elbow: joint } },
      mimeType: 'image/jpeg', imageBase64: jpeg,
    })),
    session: { id: 'set-a', mode: 'set', repNumber: 2, previousReps: [
      { id: 'rep-1', repNumber: 1, exercise, metrics: { range: 50, outwardMs: 1300 }, feedback },
    ] },
  };
}

function geminiResponse(value = feedback, extra = {}) {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [
    { thought: true, text: 'not spoken' }, { text: JSON.stringify(value) },
  ] }, ...extra }] });
}

async function callRoute(route, body, { raw, method = 'POST', onResponse = () => {} } = {}) {
  const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
  req.method = method;
  req.url = '/api/form-score';
  req.headers = { 'content-type': 'application/json', host: 'localhost:5173', origin: 'http://localhost:5173' };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.end = (value) => { res.body = value; };
  onResponse(res);
  await route(req, res, () => { res.next = true; });
  return res;
}

test('Gemini receives every exercise, full measurement evidence, phase images and recent set context', async () => {
  for (const exercise of ['squat', 'push-up', 'knee-raise', 'heel-raise']) {
    const input = evidence(exercise);
    let sent;
    const result = await scoreForm(input, { apiKey: 'test-key', fetchImpl: async (url, options) => {
      assert.match(url, /gemini-3\.6-flash:generateContent$/);
      assert.equal(options.headers['x-goog-api-key'], 'test-key');
      sent = JSON.parse(options.body);
      return geminiResponse();
    } });
    assert.deepEqual(result, feedback);
    const parts = sent.contents[0].parts;
    const metadata = JSON.parse(parts[0].text);
    for (const key of ['id', 'exercise', 'metrics', 'reference', 'source', 'camera', 'trackingSide', 'motionTrace', 'observations', 'practiceGuide', 'session']) {
      assert.deepEqual(metadata[key], input[key], `${exercise}: ${key}`);
    }
    assert.deepEqual(parts.filter((part) => part.inlineData).map((part) => part.inlineData), Array(3).fill({ mimeType: 'image/jpeg', data: jpeg }));
    const imageMetadata = parts.slice(1).filter((part) => part.text).map((part) => JSON.parse(part.text));
    assert.deepEqual(imageMetadata.map((part) => part.phase), ['start', 'bottom', 'finish']);
    assert.deepEqual(imageMetadata[0].pose.joints.hip, joint);
    assert.equal(imageMetadata[0].width, 1280);
    assert.equal(imageMetadata[0].imageBase64, undefined);
    assert.deepEqual(sent.generationConfig.responseJsonSchema.required, ['score', 'summary', 'tips']);
    assert.match(sent.systemInstruction.parts[0].text, /Never require matching the animated guide/);
    assert.match(sent.systemInstruction.parts[0].text, /untrusted observations/);
  }
});

test('full 400-frame motion traces remain available without sampling away measurements', async () => {
  const input = evidence();
  input.motionTrace.frames = Array.from({ length: 400 }, (_, index) => ({
    offsetMs: index * 83, joints: { hip: joint, shoulder: joint, elbow: joint, wrist: joint, knee: joint, ankle: joint, toe: joint },
  }));
  await scoreForm(input, { apiKey: 'key', fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).motionTrace.frames.length, 400);
    return geminiResponse();
  } });
});

test('malformed evidence is rejected before a paid model request', async () => {
  const variants = [
    (input) => { input.exercise = 'running'; },
    (input) => { input.metrics.range = Infinity; },
    (input) => { input.snapshots[0].imageBase64 = '/9j/AAAA'; },
    (input) => { input.snapshots[1].phase = input.snapshots[0].phase; },
    (input) => { input.snapshots[0].pose.joints.hip.presence = 2; },
    (input) => { input.snapshots[0].pose = 'not a pose'; },
    (input) => { input.motionTrace.frames[1].offsetMs = -1; },
    (input) => { input.motionTrace.frames[1].offsetMs = 0; },
    (input) => { input.motionTrace.frames = Array(401).fill(input.motionTrace.frames[0]); },
    (input) => { input.session.previousReps = Array(6).fill(input.session.previousReps[0]); },
    (input) => { input.session.repNumber = 0; },
    (input) => { input.camera.height = 0; },
  ];
  for (const mutate of variants) {
    const input = structuredClone(evidence());
    mutate(input);
    await assert.rejects(scoreForm(input, { apiKey: 'key', fetchImpl: () => assert.fail('Invalid evidence must not be sent') }), { status: 400 });
  }
});

test('missing credentials, rate limits, malformed JSON and incomplete model output have useful errors', async () => {
  await assert.rejects(scoreForm(evidence()), { status: 503 });
  for (const [response, status] of [
    [new Response('', { status: 429 }), 429],
    [new Response('', { status: 500 }), 502],
    [new Response('not JSON'), 502],
    [geminiResponse({ score: 80, tips: [] }), 502],
    [geminiResponse(feedback, { finishReason: 'MAX_TOKENS' }), 502],
    [geminiResponse({ ...feedback, tips: ['one two three four five six seven eight nine ten eleven twelve thirteen'] }), 502],
  ]) {
    await assert.rejects(scoreForm(evidence(), { apiKey: 'key', fetchImpl: async () => response }), { status });
  }
});

test('form route retains JSON validation and the 12 MiB request limit', async () => {
  const route = formScoringRoute({ apiKey: 'key', fetchImpl: () => assert.fail('Must not call Gemini') });
  const malformed = await callRoute(route, null, { raw: '{' });
  assert.equal(malformed.statusCode, 400);
  const large = await callRoute(route, null, { raw: ' '.repeat(12 * 1024 * 1024 + 1) });
  assert.equal(large.statusCode, 413);
  assert.equal(large.headers['cache-control'], 'no-store');
});

test('feedback normalization supports old responses and validates concise summaries', () => {
  assert.deepEqual(normalizeFeedback({ score: null, tips: [] }), { score: null, tips: [] });
  assert.deepEqual(normalizeFeedback({ ...feedback, summary: ` ${feedback.summary} ` }), feedback);
  assert.equal(normalizeFeedback({ ...feedback, summary: '' }), null);
  assert.equal(normalizeFeedback({ ...feedback, summary: 'x'.repeat(181) }), null);
});

function callSpeechRoute(route, body, options) {
  return callRoute((req, res, next) => {
    req.url = '/api/form-speech';
    return route(req, res, next);
  }, body, options);
}

test('ElevenLabs SDK sends the voice, MP3 format, summary and tips without a score announcement', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = JSON.parse(options.body);
    const target = new URL(url);
    assert.equal(target.pathname, '/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL');
    assert.equal(target.searchParams.get('output_format'), 'mp3_44100_128');
    assert.equal(new Headers(options.headers).get('xi-api-key'), 'speech-key');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  });
  const result = await callSpeechRoute(feedbackSpeechRoute({ apiKey: 'speech-key' }), { ...feedback, repNumber: 2 });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-type'], 'audio/mpeg');
  assert.deepEqual(result.body, Buffer.from([1, 2, 3]));
  assert.equal(request.text, `Rep 2. ${feedback.summary} ${feedback.tips[0]}`);
  assert.doesNotMatch(request.text, /84|out of 100/);
  assert.equal(request.model_id, 'eleven_flash_v2_5');
});

test('speech validates requests before calling the SDK', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call ElevenLabs'));
  for (const [options, body, expected] of [
    [{}, feedback, 503], [{ apiKey: 'key' }, { ...feedback, repNumber: 'two' }, 400],
    [{ apiKey: 'key' }, { ...feedback, tips: [''] }, 400],
  ]) {
    const result = await callSpeechRoute(feedbackSpeechRoute(options), body);
    assert.equal(result.statusCode, expected);
  }
});

test('speech does not retry paid SDK calls and keeps provider error details private', async (t) => {
  let status;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'private-provider-detail' }, { status }));
  for (const expected of [429, 502]) {
    status = expected === 429 ? 429 : 503;
    const before = fetchMock.mock.callCount();
    const result = await callSpeechRoute(feedbackSpeechRoute({ apiKey: 'key' }), feedback);
    assert.equal(result.statusCode, expected);
    assert.equal(fetchMock.mock.callCount(), before + 1);
    assert.doesNotMatch(result.body, /private-provider-detail/);
  }
});

test('speech rejects non-audio and empty SDK streams', async (t) => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const candidate of [
    Response.json({ error: 'bad' }),
    new Response(new Uint8Array(), { headers: { 'content-type': 'audio/mpeg' } }),
  ]) {
    response = candidate;
    const result = await callSpeechRoute(feedbackSpeechRoute({ apiKey: 'key' }), feedback);
    assert.equal(result.statusCode, 502);
    assert.equal(result.headers['content-type'], 'application/json');
  }
});

test('speech keeps its 20-second deadline and cancels an unfinished SDK body', async (t) => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 20_000);
    return timeout.signal;
  });
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'audio/mpeg' } }));
  const pending = callSpeechRoute(feedbackSpeechRoute({ apiKey: 'key' }), feedback);
  await new Promise(setImmediate);
  timeout.abort(new DOMException('Timed out', 'TimeoutError'));
  const result = await pending;
  assert.equal(result.statusCode, 504);
  assert.equal(cancelled, true);
});

test('a client disconnect aborts an in-flight SDK request', async (t) => {
  let providerSignal;
  let response;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    providerSignal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const pending = callSpeechRoute(feedbackSpeechRoute({ apiKey: 'key' }), feedback, {
    onResponse(res) { response = res; },
  });
  await new Promise(setImmediate);
  response.destroyed = true;
  response.emit('close');
  await pending;
  assert.equal(providerSignal.aborted, true);
  assert.equal(response.body, undefined);
});

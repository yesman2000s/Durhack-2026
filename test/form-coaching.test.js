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

async function callRoute(route, body, { raw, method = 'POST' } = {}) {
  const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
  req.method = method;
  req.url = '/api/form-score';
  req.headers = { 'content-type': 'application/json', host: 'localhost:5173', origin: 'http://localhost:5173' };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.end = (value) => { res.body = value; };
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

test('ElevenLabs reads the rep summary and actionable tips without a score announcement', async () => {
  let request;
  const speech = feedbackSpeechRoute({ apiKey: 'speech-key', fetchImpl: async (url, options) => {
    request = JSON.parse(options.body);
    assert.match(url, /text-to-speech/);
    assert.equal(options.headers['xi-api-key'], 'speech-key');
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  const route = (req, res, next) => { req.url = '/api/form-speech'; return speech(req, res, next); };
  const result = await callRoute(route, { ...feedback, repNumber: 2 });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-type'], 'audio/mpeg');
  assert.equal(request.text, `Rep 2. ${feedback.summary} ${feedback.tips[0]}`);
  assert.doesNotMatch(request.text, /84|out of 100/);
  assert.equal(request.model_id, 'eleven_flash_v2_5');
});

test('speech rejects invalid rep identities and reports unavailable or non-audio responses', async () => {
  for (const [options, body, expected] of [
    [{}, feedback, 503],
    [{ apiKey: 'key' }, { ...feedback, repNumber: 'two' }, 400],
    [{ apiKey: 'key', fetchImpl: async () => new Response('busy', { status: 429 }) }, feedback, 429],
    [{ apiKey: 'key', fetchImpl: async () => Response.json({ error: 'bad' }) }, feedback, 502],
  ]) {
    const speech = feedbackSpeechRoute(options);
    const result = await callRoute((req, res, next) => { req.url = '/api/form-speech'; return speech(req, res, next); }, body);
    assert.equal(result.statusCode, expected);
  }
});

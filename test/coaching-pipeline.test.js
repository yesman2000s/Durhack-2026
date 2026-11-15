import test from 'node:test';
import assert from 'node:assert/strict';
import { SquatTracker } from '../src/squat-tracker.js';
import { MobilityTracker } from '../src/mobility-tracker.js';
import { demoLandmarks } from '../src/demo.js';
import { exampleProgress, mobilityDemoLandmarks } from '../src/mobility-demo.js';
import { framePose, makeEvidence } from '../src/evidence.js';
import { makeMotionTrace, recordPose } from '../src/motion-trace.js';
import { createCaptureSession } from '../src/capture-session.js';
import { coachingPayload } from '../src/rep-coach.js';
import { scoreForm } from '../server/form-scoring.js';

// JPEG envelope fixture: image decoding/model judgement is mocked, while the
// tracker, phase selection, export, JSON transport and API validation are real.
const jpeg = '/9j/2Q==';
const feedback = { score: 84, summary: 'The example returns to its starting position.', tips: ['Keep the lowering movement controlled.'] };
const phases = ['start', 'descent', 'bottom', 'ascent', 'finish'];

function imageFor(frame, state, kneeAngleDeg = state.live?.kneeAngleDeg ?? null) {
  return {
    url: `data:image/jpeg;base64,${jpeg}`, width: frame.width, height: frame.height,
    timestampMs: frame.timestampMs, kneeAngleDeg, pose: framePose(frame, state.live),
  };
}

function startCapture(frame, state) {
  const trace = [];
  recordPose(trace, frame, state.live, true);
  return {
    referenceAt: frame.timestampMs,
    images: new Map([['start', imageFor(frame, state)]]), candidates: new Map(), trace,
  };
}

for (const exercise of ['squat', 'push-up', 'knee-raise', 'heel-raise']) {
  test(`${exercise}: two tracked set reps preserve images, measurements, confidence and prior feedback through Gemini transport`, async () => {
    const tracker = exercise === 'squat' ? new SquatTracker() : new MobilityTracker(exercise);
    const session = createCaptureSession('set', { id: `${exercise}-set` });
    const requests = [];
    const completed = [];
    let capture;
    let firstReference = null;

    for (let timestampMs = 0; timestampMs <= 10720 && completed.length < 2; timestampMs += 80) {
      const elapsed = timestampMs - 1440;
      const progress = elapsed < 0 ? 0 : exampleProgress(elapsed % 4600);
      const landmarks = exercise === 'squat' ? demoLandmarks(progress) : mobilityDemoLandmarks(progress, exercise);
      for (const point of landmarks) point.presence = .96;
      const frame = { landmarks, timestampMs, width: 960, height: 540 };
      const state = tracker.update({ ...frame, armed: true, continuous: true });
      session.observe({ timestampMs, hasPose: Boolean(state.live), moving: ['descending', 'bottom', 'ascending'].includes(state.phase) });
      assert.ok(!state.events.some(({ type }) => type === 'rep-discarded'));
      if (!capture) {
        if (state.setup.ready) capture = startCapture(frame, state);
        continue;
      }
      recordPose(capture.trace, frame, state.live,
        state.events.some(({ type, phase }) => type === 'capture' && phase === 'finish'));
      for (const event of state.events) {
        if (event.type === 'capture-candidate') capture.candidates.set(timestampMs, imageFor(frame, state, event.kneeAngleDeg));
        if (event.type === 'capture' && !(event.phase === 'start' && capture.images.has('start'))) {
          const image = capture.candidates.get(event.timestampMs)
            ?? (event.timestampMs === timestampMs ? imageFor(frame, state) : null);
          if (image) capture.images.set(event.phase, image);
        }
        if (event.type !== 'rep-complete') continue;
        const firstRep = exercise === 'squat' && firstReference === null;
        if (firstRep) firstReference = {
          trackingSide: event.rep.side,
          kneeExcursionDeg: event.rep.metrics.startKneeAngleDeg - event.rep.metrics.kneeAngleAtBottomDeg,
          standingThighToShinRatio: event.rep.metrics.standingThighToShinRatio,
        };
        const evidence = makeEvidence({
          rep: event.rep, images: capture.images,
          motionTrace: makeMotionTrace(capture.trace, capture.referenceAt, event.rep.startedAtMs),
          captureStartMs: capture.referenceAt, source: 'simulated', variant: 'bodyweight',
          camera: { width: frame.width, height: frame.height }, capturedAt: '2026-11-14T12:00:00.000Z',
          reference: firstReference ? { ...firstReference, establishedByThisRep: firstRep } : null,
          trainingGuide: true,
        });
        const context = session.contextForNextRep();
        evidence.captureMode = context.mode;
        session.addRep(evidence, timestampMs);
        // fetch sends JSON, so optional undefined values disappear at this edge.
        const payload = JSON.parse(JSON.stringify(coachingPayload(evidence, context)));
        assert.deepEqual(payload.snapshots.map(({ phase }) => phase), phases);
        assert.ok(payload.movementStartOffsetMs >= 0);
        assert.equal(payload.motionTrace.frames[0].offsetMs, 0);
        assert.ok(payload.motionTrace.frames.length > 20);
        for (const [index, sample] of payload.motionTrace.frames.entries()) {
          assert.ok(sample.offsetMs >= 0);
          if (index) assert.ok(sample.offsetMs > payload.motionTrace.frames[index - 1].offsetMs);
          assert.equal(sample.joints.hip.presence, .96);
          assert.ok(sample.joints.hip.visibility > 0);
        }
        assert.ok(payload.snapshots.every((image, index) => image.offsetMs >= 0 &&
          (!index || image.offsetMs >= payload.snapshots[index - 1].offsetMs)));
        const result = await scoreForm(payload, {
          apiKey: 'test-only-key',
          fetchImpl: async (_url, options) => {
            const request = JSON.parse(options.body);
            requests.push(request);
            const parts = request.contents[0].parts;
            const metadata = JSON.parse(parts[0].text);
            const { snapshots, session: sessionContext, ...repMetadata } = payload;
            assert.deepEqual(metadata, {
              ...repMetadata,
              session: {
                ...sessionContext,
                previousReps: sessionContext.previousReps.map(({ source: _source, ...previous }) => previous),
              },
            });
            const imageMetadata = parts.slice(1).filter(({ text }) => text).map(({ text }) => JSON.parse(text));
            assert.deepEqual(imageMetadata.map(({ phase }) => phase), phases);
            assert.deepEqual(imageMetadata.map(({ phaseLabel: _label, ...details }) => details),
              snapshots.map(({ mimeType: _mimeType, imageBase64: _imageBase64, ...details }) => details));
            assert.ok(imageMetadata.every(({ pose }) => pose.joints.hip.presence === .96));
            assert.deepEqual(parts.filter(({ inlineData }) => inlineData).map(({ inlineData }) => inlineData),
              Array(5).fill({ mimeType: 'image/jpeg', data: jpeg }));
            return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(feedback) }] } }] });
          },
        });
        assert.deepEqual(result, feedback);
        session.updateFeedback(evidence.id, result);
        completed.push({ evidence, payload });
        capture = startCapture(frame, state);
      }
    }
    assert.equal(requests.length, 2);
    assert.equal(completed.length, 2);
    const [first, second] = completed;
    assert.equal(first.payload.session.repNumber, 1);
    assert.deepEqual(first.payload.session.previousReps, []);
    assert.equal(second.payload.session.repNumber, 2);
    assert.equal(second.payload.session.id, first.payload.session.id);
    const previous = second.payload.session.previousReps;
    assert.equal(previous.length, 1);
    assert.equal(previous[0].id, first.evidence.id);
    assert.deepEqual(previous[0].metrics, first.evidence.metrics);
    assert.deepEqual(previous[0].feedback, feedback);
    assert.equal(previous[0].snapshots, undefined);
    assert.equal(previous[0].motionTrace, undefined);
    assert.ok(session.snapshot().active, 'two accepted reps do not end a full set');
  });
}

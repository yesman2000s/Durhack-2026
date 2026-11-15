import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, rmdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStore } from '../server/accounts-store.js';
import { createAccountService } from '../server/accounts.js';
import { formScoringRoute } from '../server/form-scoring.js';

const credentials = { email: 'person@example.com', name: 'A Person', password: 'a-long-test-password' };
async function request(route, path, { method = 'GET', body = {}, cookie, origin = 'http://localhost:5173', raw } = {}) {
  const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
  req.url = path; req.method = method;
  req.headers = { host: 'localhost:5173', origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new EventEmitter();
  res.headers = {}; res.statusCode = 200;
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.end = (body) => { res.body = JSON.parse(body); };
  await route(req, res, () => { res.next = true; });
  return res;
}
async function harness(t, filename = ':memory:') {
  const store = createAccountStore({ filename });
  const service = createAccountService({ store });
  t.after(() => store.close());
  const route = service.middleware;
  const registration = await request(route, '/api/auth/register', { method: 'POST', body: credentials });
  assert.equal(registration.statusCode, 201);
  const cookie = registration.headers['set-cookie'].split(';')[0];
  const user = registration.body.user;
  const call = (path, options = {}) => request(route, path, { cookie, ...options });
  let calls = 0;
  let score = 80;
  const scorer = formScoringRoute({ apiKey: 'test-key', scoreRep: service.scoreRep, fetchImpl: async () => {
    calls += 1;
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
      score, summary: score === null ? 'The movement is not visible enough to score.' : 'Controlled movement and a steady return.', tips: [],
    }) }] } }] });
  } });
  const start = async (values = {}) => {
    const response = await call('/api/attempts', { method: 'POST', body: { exerciseId: 'squat', level: 1, source: 'webcam', mode: 'set', ...values } });
    assert.equal(response.statusCode, 201, JSON.stringify(response.body));
    return response.body.attempt;
  };
  const review = (attempt, id, value = 80, extras = {}, cookieOverride = cookie) => {
    score = value;
    return request(scorer, '/api/form-score', { method: 'POST', cookie: cookieOverride, body: {
      attemptId: attempt.id, id, exercise: attempt.exerciseId, source: attempt.source,
      snapshots: [{ phase: 'finish', mimeType: 'image/jpeg', imageBase64: '/9j/2Q==' }], ...extras,
    } });
  };
  const finish = (attempt, body = {}) => call(`/api/attempts/${attempt.id}/finish`, { method: 'POST', body });
  return { store, service, route, call, cookie, user, start, review, finish, calls: () => calls };
}

test('accounts validate credentials, use private cookies, reject cross-origin writes, and isolate sessions', async (t) => {
  const h = await harness(t);
  assert.deepEqual((await h.call('/api/auth/me')).body.user, h.user);
  assert.deepEqual((await request(h.route, '/api/auth/me')).body, { user: null });
  assert.equal((await request(h.route, '/api/progress')).statusCode, 401);
  assert.equal((await h.call('/api/auth/login', { method: 'POST', body: credentials, origin: 'https://other.example' })).statusCode, 403);
  assert.equal((await h.call('/api/auth/login', { method: 'POST', body: { ...credentials, password: 'wrong-password' } })).statusCode, 401);
  assert.equal((await h.call('/api/auth/register', { method: 'POST', body: credentials })).statusCode, 409);
  const login = await h.call('/api/auth/login', { method: 'POST', body: { ...credentials, email: ' PERSON@EXAMPLE.COM ' } });
  assert.equal(login.statusCode, 200);
  assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
  assert.equal((await h.call('/api/auth/me')).body.user, null, 'login rotates the old session');
  const cookie = login.headers['set-cookie'].split(';')[0];
  await request(h.route, '/api/auth/logout', { method: 'POST', cookie });
  assert.equal((await request(h.route, '/api/auth/me', { cookie })).body.user, null);
});

test('only server coaching scores unlock levels; baseline is the first scored rep, not the set mean', async (t) => {
  const h = await harness(t);
  const attempt = await h.start();
  assert.equal((await h.review(attempt, 'rep-one', 70, { score: 100, repCount: 100, passed: true })).statusCode, 200);
  await h.review(attempt, 'rep-two', 90);
  const finished = await h.finish(attempt, { score: 100, repCount: 999, passed: true });
  assert.equal(finished.body.attempt.score, 80);
  assert.equal(finished.body.attempt.repCount, 2);
  assert.equal(finished.body.attempt.passed, true);
  const track = finished.body.progress.tracks[0];
  assert.equal(track.baseline, 70);
  assert.equal(track.completedLevels, 1);
  assert.deepEqual(track.target, { level: 2, reps: 3, minScore: 67, scoreToBeat: 83 });
  assert.equal(finished.body.progress.tracks[1].completedLevels, 0);
  const forged = await h.start({ exerciseId: 'knee-raise' });
  assert.equal((await h.finish(forged, { score: 100, repCount: 999, passed: true })).body.attempt.passed, false);
});

test('rep retries and attempt finalization are idempotent and cannot credit a second level', async (t) => {
  const h = await harness(t);
  const first = await h.start();
  await h.review(first, 'repeat-rep', 80);
  const repeat = await h.review(first, 'repeat-rep', 100);
  assert.equal(repeat.body.score, 80);
  assert.equal(h.calls(), 1);
  const finished = await h.finish(first);
  assert.deepEqual((await h.finish(first)).body, finished.body);
  const second = await h.start({ level: 2 });
  assert.equal((await h.review(second, 'repeat-rep', 100)).statusCode, 409);
  assert.equal(h.calls(), 1);
  assert.equal((await h.finish(second)).body.attempt.passed, false);
});

test('two concurrent attempts at the same level cannot skip the next gate', async (t) => {
  const h = await harness(t);
  const first = await h.start(); const second = await h.start();
  await h.review(first, 'parallel-one', 80); await h.review(second, 'parallel-two', 100);
  assert.equal((await h.finish(first)).body.attempt.passed, true);
  const finished = await h.finish(second);
  assert.equal(finished.body.attempt.passed, false);
  assert.equal(finished.body.progress.tracks[0].completedLevels, 1);
});

test('ownership, exercise and source are checked before paid model calls', async (t) => {
  const h = await harness(t);
  const attempt = await h.start();
  const registration = await request(h.route, '/api/auth/register', { method: 'POST', body: { ...credentials, email: 'someoneelse@example.com' } });
  const otherCookie = registration.headers['set-cookie'].split(';')[0];
  assert.equal((await h.review(attempt, 'wrong-owner', 80, {}, otherCookie)).statusCode, 404);
  assert.equal((await h.review(attempt, 'anonymous', 80, {}, '')).statusCode, 401);
  assert.equal((await h.review(attempt, 'wrong-exercise', 80, { exercise: 'heel-raise' })).statusCode, 400);
  assert.equal((await h.review(attempt, 'wrong-source', 80, { source: 'simulated' })).statusCode, 400);
  assert.equal((await request(h.route, `/api/attempts/${attempt.id}`, { cookie: otherCookie })).statusCode, 404);
  assert.equal((await request(h.route, `/api/attempts/${attempt.id}/finish`, { method: 'POST', cookie: otherCookie })).statusCode, 404);
  assert.deepEqual((await request(h.route, '/api/attempts', { cookie: otherCookie })).body.attempts, []);
  assert.equal(h.calls(), 0);
});

test('baseline comparisons require the same movement variant and reject mismatches before paid review', async (t) => {
  const h = await harness(t);
  const attempt = await h.start({ variant: 'barbell' });
  assert.equal((await h.review(attempt, 'wrong-variant', 100)).statusCode, 400);
  assert.equal(h.calls(), 0);
  assert.equal((await h.review(attempt, 'barbell-baseline', 80, { variant: 'barbell' })).statusCode, 200);
  const result = await h.finish(attempt);
  assert.equal(result.body.progress.tracks[0].variant, 'barbell');
  assert.equal(result.body.attempt.variant, 'barbell');
  assert.equal((await h.call('/api/attempts', { method: 'POST', body: {
    exerciseId: 'squat', level: 2, source: 'webcam', mode: 'set', variant: 'bodyweight',
  } })).statusCode, 409);
  assert.equal((await h.start({ level: 2, variant: 'barbell' })).variant, 'barbell');
});

test('null scores, simulated examples, cancellation and errors retain history without an unlock', async (t) => {
  const h = await harness(t);
  for (const [index, source, score, reason] of [
    [0, 'webcam', null, 'completed'], [1, 'simulated', 100, 'completed'],
    [2, 'webcam', 100, 'cancelled'], [3, 'video', 100, 'error'],
  ]) {
    const attempt = await h.start({ source });
    await h.review(attempt, `unsuccessful-${index}`, score);
    const response = await h.finish(attempt, { reason });
    assert.equal(response.body.attempt.passed, false);
    assert.equal(response.body.progress.tracks[0].completedLevels, 0);
    assert.equal(response.body.attempt.reps.length, 1);
  }
  assert.equal((await h.call('/api/attempts')).body.attempts.length, 4);
});

test('subsequent levels require improvement and offer extra reps even at score 100', async (t) => {
  const h = await harness(t);
  const first = await h.start();
  await h.review(first, 'ceiling-baseline', 100);
  const firstResult = await h.finish(first);
  assert.equal(firstResult.body.progress.tracks[0].target.scoreToBeat, null);
  const noImprovement = await h.start({ level: 2 });
  await h.review(noImprovement, 'same-score', 100);
  assert.equal((await h.finish(noImprovement)).body.attempt.passed, false);
  const more = await h.start({ level: 2 });
  await h.review(more, 'more-one', 97); await h.review(more, 'more-two', 97);
  assert.equal((await h.finish(more)).body.attempt.passed, true);
  assert.equal((await h.call('/api/attempts', { method: 'POST', body: { exerciseId: 'squat', level: 5, source: 'webcam', mode: 'set' } })).statusCode, 409);
});

test('pending reviews block finalization and failed review details are preserved', async (t) => {
  const h = await harness(t);
  const attempt = await h.start();
  const input = { attemptId: attempt.id, id: 'pending', exercise: 'squat', source: 'webcam' };
  h.store.reserveRep(h.user.id, input);
  assert.equal((await h.finish(attempt)).statusCode, 409);
  h.store.failRep(h.user.id, input, 'Review timed out.');
  assert.equal((await h.finish(attempt)).statusCode, 409);
  const finished = await h.finish(attempt, { reason: 'error' });
  assert.equal(finished.body.attempt.passed, false);
  assert.equal(finished.body.attempt.reps[0].error, 'Review timed out.');
});

test('failed reviews can be retried in an active attempt, without counting the rep twice', async (t) => {
  const h = await harness(t);
  const attempt = await h.start();
  const failed = await h.review(attempt, 'retryable', 80, { snapshots: [] });
  assert.equal(failed.statusCode, 400);
  assert.equal((await h.finish(attempt)).statusCode, 409);
  assert.equal((await h.review(attempt, 'retryable', 80)).statusCode, 200);
  assert.equal((await h.review(attempt, 'retryable', 100)).body.score, 80);
  const finished = await h.finish(attempt);
  assert.equal(finished.body.attempt.passed, true);
  assert.equal(finished.body.attempt.repCount, 1);
  assert.equal(h.calls(), 1);
});

test('settings validate unlocked note keys, positions, mutes and songs', async (t) => {
  const h = await harness(t);
  assert.equal((await h.call('/api/settings', { method: 'PATCH', body: { positions: { 'squat:1': 3 } } })).statusCode, 400);
  const attempt = await h.start(); await h.review(attempt, 'settings-unlock'); await h.finish(attempt);
  const settings = { songId: 'rock', positions: { 'squat:1': 3 }, mutedNotes: ['squat:1'] };
  assert.deepEqual((await h.call('/api/settings', { method: 'PATCH', body: settings })).body.settings, settings);
  for (const body of [{ songId: 'missing' }, { positions: { 'squat:1': 7 } }, { mutedNotes: ['squat:7'] }, { score: 100 }]) {
    assert.equal((await h.call('/api/settings', { method: 'PATCH', body })).statusCode, 400);
  }
});

test('newly unlocked notes use an empty visual slot when a previous note was moved', async (t) => {
  const h = await harness(t);
  const first = await h.start(); await h.review(first, 'layout-first', 80); await h.finish(first);
  await h.call('/api/settings', { method: 'PATCH', body: { positions: { 'squat:1': 1 } } });
  const second = await h.start({ level: 2 }); await h.review(second, 'layout-second', 83);
  const response = await h.finish(second);
  assert.deepEqual(response.body.progress.settings.positions, { 'squat:1': 1, 'squat:2': 0 });
  assert.equal((await h.call('/api/settings', { method: 'PATCH', body: { mutedNotes: ['squat:2'] } })).statusCode, 200);
});

test('SQLite persists accounts, session hashes, feedback, progression and settings across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compose-accounts-'));
  const filename = join(directory, 'accounts.sqlite');
  let store = createAccountStore({ filename });
  try {
    const { user, token } = await store.register(credentials);
    const attempt = store.createAttempt(user.id, { exerciseId: 'heel-raise', level: 1, source: 'video', mode: 'set' });
    const input = { attemptId: attempt.id, id: 'durable-rep', exercise: 'heel-raise', source: 'video' };
    store.reserveRep(user.id, input);
    store.recordRep(user.id, input, { score: 85, summary: 'A controlled return.', tips: [] });
    store.finishAttempt(user.id, attempt.id);
    const settings = store.saveSettings(user.id, { songId: 'electronic', mutedNotes: ['heel-raise:1'] });
    const pendingAttempt = store.createAttempt(user.id, { exerciseId: 'squat', level: 1, source: 'webcam', mode: 'set' });
    store.reserveRep(user.id, { attemptId: pendingAttempt.id, id: 'interrupted-rep', exercise: 'squat', source: 'webcam' });
    store.close();
    assert.equal(readFileSync(filename).includes(Buffer.from(credentials.password)), false);
    assert.equal(readFileSync(filename).includes(Buffer.from(token)), false);
    store = createAccountStore({ filename });
    assert.deepEqual(store.userForToken(token), user);
    assert.deepEqual(store.progress(user.id).settings, settings);
    assert.equal(store.progress(user.id).tracks[3].completedLevels, 1);
    assert.equal(store.attempt(user.id, attempt.id).reps[0].feedback.summary, 'A controlled return.');
    assert.equal(store.attempt(user.id, pendingAttempt.id).reps[0].status, 'error');
    assert.equal(store.finishAttempt(user.id, pendingAttempt.id, 'error').attempt.passed, false);
    assert.deepEqual((await store.login(credentials)).user, user);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${filename}${suffix}`, { force: true });
    rmdirSync(directory);
  }
});

test('credential requests are bounded and repeated login attempts are throttled', async (t) => {
  const h = await harness(t);
  assert.equal((await h.call('/api/auth/login', { method: 'POST', raw: ' '.repeat(32769) })).statusCode, 413);
  assert.equal((await h.call('/api/auth/login', { method: 'POST', raw: '{' })).statusCode, 400);
  let response;
  for (let index = 0; index < 12; index += 1) response = await h.call('/api/auth/login', { method: 'POST', body: { ...credentials, password: 'incorrect-password' } });
  assert.equal(response.statusCode, 429);
});

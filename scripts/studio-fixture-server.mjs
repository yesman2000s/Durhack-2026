// Run from the repository root: node scripts/studio-fixture-server.mjs
// Disposable browser QA only. No .env files, production database, or paid APIs.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { createAccountStore } from '../server/accounts-store.js';
import { createAccountService } from '../server/accounts.js';
import { formScoringRoute } from '../server/form-scoring.js';
import { HttpError, jsonRoute } from '../server/json-route.js';
import { normalizeFeedback } from '../server/feedback.js';

export const FIXTURE_CREDENTIALS = {
  email: 'studio@example.test', password: 'Compose-test-2026', name: 'Studio Preview',
};
export const UNLOCKED_FIXTURE_CREDENTIALS = {
  email: 'unlocked@example.test', password: 'Compose-test-2026', name: 'Unlocked Preview',
};

const feedback = (score) => ({
  score,
  summary: 'QA fixture feedback: a controlled movement and steady return.',
  tips: ['Keep your movement steady.'],
});

function toneWav() {
  const rate = 24000, samples = rate / 4;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) {
    const fade = Math.min(1, sample / 240, (samples - sample - 1) / 240);
    buffer.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 440 / rate) * 1800 * fade), 44 + sample * 2);
  }
  return buffer;
}

async function seed(store) {
  const preview = await store.register(UNLOCKED_FIXTURE_CREDENTIALS);
  store.logout(preview.token);
  store.unlockMusic(preview.user.id);
  const { user, token } = await store.register(FIXTURE_CREDENTIALS);
  store.logout(token); // Browser QA must still exercise the normal login flow.
  function attempt(exerciseId, level, score) {
    const created = store.createAttempt(user.id, { exerciseId, level, source: 'webcam', mode: 'single-rep' });
    const rep = { attemptId: created.id, id: `fixture-${exerciseId}-${level}-${score}`, exercise: exerciseId, source: 'webcam' };
    store.reserveRep(user.id, rep);
    store.recordRep(user.id, rep, feedback(score));
    return store.finishAttempt(user.id, created.id).attempt;
  }
  for (const [exerciseId, count] of [['squat', 2], ['knee-raise', 1], ['push-up', 3]]) {
    for (let level = 1; level <= count; level++) {
      if (!attempt(exerciseId, level, 70 + (level - 1) * 3).passed) throw new Error('Fixture progression seed did not pass.');
    }
  }
  if (attempt('squat', 3, 68).passed) throw new Error('Fixture practice attempt unexpectedly unlocked a level.');
  return user;
}

export async function createStudioFixtureServer() {
  // Scoring receives its own fake below. Any accidental fallback to fetch fails
  // before connecting, even if the parent shell contains API credentials.
  globalThis.fetch = async () => { throw new Error('Outbound fetch is disabled in the studio QA fixture.'); };
  const store = createAccountStore({ filename: ':memory:' });
  let closed = false;
  const closeStore = () => { if (!closed) { closed = true; store.close(); } };
  try {
    const user = await seed(store);
    const accounts = createAccountService({ store });
    const score = formScoringRoute({
      apiKey: 'fixture-only-not-a-credential', model: 'fixture', scoreRep: accounts.scoreRep,
      fetchImpl: async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(feedback(82)) }] } }] }),
    });
    const speech = jsonRoute({
      path: '/api/form-speech', maxBytes: 4096, sizeError: 'Feedback exceeds the 4 KiB limit.',
      timeoutError: 'Fixture audio timed out.', unavailableError: 'Fixture audio is unavailable.',
    }, async (input) => {
      if (!normalizeFeedback(input)) throw new HttpError(400, 'Send valid rep feedback and coaching tips.');
      return { contentType: 'audio/wav', body: toneWav() };
    });
    const csp = [
      "default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "media-src 'self' data: blob:", "font-src 'self' data:",
      "connect-src 'self' ws://localhost:5175 ws://127.0.0.1:5175", "worker-src 'self' blob:",
      "frame-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    ].join('; ');
    const server = await createServer({
      configFile: false, envFile: false, envPrefix: '__COMPOSE_FIXTURE_UNUSED__', root: process.cwd(),
      server: {
        host: '127.0.0.1', port: 5175, strictPort: true, open: false,
        fs: { strict: true, allow: [process.cwd()], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**', '**/.aws/**', '**/.codex/**'] },
      },
      plugins: [{
        name: 'isolated-studio-qa-fixture',
        transformIndexHtml(html) {
          return html.replace('<title>', '<title>TEST WORKSPACE · ').replace('<body>', `<body>
            <aside role="status" style="position:relative;z-index:2147483647;background:#54240b;color:#fff7d6;padding:9px 16px;text-align:center;font:600 13px/1.5 system-ui;letter-spacing:.02em">
              TEST WORKSPACE · Disposable fixture data · Fake coaching and audio · No paid API calls
            </aside>`);
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            res.setHeader('Content-Security-Policy', csp);
            res.setHeader('X-Compose-Fixture', 'in-memory-no-paid-apis');
            let path;
            try { path = decodeURIComponent(req.url?.split('?')[0] ?? '').replaceAll('\\', '/'); }
            catch { res.statusCode = 400; res.end(); return; }
            if (path.split('/').some((part) => /^(?:\.data|\.git|\.aws|\.codex|\.env(?:\..*)?)$/i.test(part.replace(/[. ]+$/, '')))) {
              res.statusCode = 403; res.end('Fixture cannot serve private workspace files.'); return;
            }
            next();
          });
          vite.middlewares.use(accounts.middleware);
          vite.middlewares.use(score);
          vite.middlewares.use(speech);
          vite.httpServer?.once('close', closeStore);
        },
      }],
    });
    return { server, store, user };
  } catch (error) { closeStore(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server } = await createStudioFixtureServer();
  await server.listen();
  console.log('TEST WORKSPACE: http://127.0.0.1:5175');
  console.log(`Sign in: ${FIXTURE_CREDENTIALS.email} / ${FIXTURE_CREDENTIALS.password}`);
  console.log('In-memory database. Seeded levels: squat 2, knee raise 1, push-ups 3, heel raise 0.');
  console.log('Scoring is fixed at 82; speech is a short local tone. External browser requests are blocked.');
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

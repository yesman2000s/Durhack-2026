import { createAccountStore, SESSION_MAX_AGE } from './accounts-store.js';
import { HttpError } from './json-route.js';

const COOKIE_NAME = 'compose_session';
function sessionToken(req) {
  const entry = req.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE_NAME}=`));
  return entry?.slice(COOKIE_NAME.length + 1) ?? null;
}
function sessionCookie(req, token) {
  return `${COOKIE_NAME}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_MAX_AGE : 0}${req.socket?.encrypted ? '; Secure' : ''}`;
}
async function readJson(req) {
  if (req.headers.origin && !['http', 'https'].some((scheme) => req.headers.origin === `${scheme}://${req.headers.host}`)) {
    throw new HttpError(403, 'Send the request from the app origin.');
  }
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Send application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 32768) { req.resume(); throw new HttpError(413, 'Account request exceeds the 32 KiB limit.'); }
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Send valid JSON.'); }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Send a JSON object.');
  return input;
}

export function createAccountService({ store = createAccountStore(), mongoWorkouts, now = () => Date.now() } = {}) {
  const limits = new Map();
  async function syncWorkouts(userId) {
    if (!mongoWorkouts) return;
    try {
      await mongoWorkouts.sync(userId, store.scoredWorkouts);
    } catch {
      throw new HttpError(503, 'Workout scores could not sync to MongoDB. Try again shortly.');
    }
  }
  function requireUser(req) {
    const user = store.userForToken(sessionToken(req));
    if (!user) throw new HttpError(401, 'Sign in to save your workouts and unlock music.');
    return user;
  }
  function rateLimit(req, email) {
    const timestamp = now();
    for (const [key, entry] of limits) if (entry.until <= timestamp) limits.delete(key);
    const keys = [
      [`ip:${req.socket?.remoteAddress ?? 'unknown'}`, 30],
      [`email:${typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : ''}`, 12],
    ];
    if (keys.some(([key, maximum]) => (limits.get(key)?.count ?? 0) >= maximum)) {
      throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
    }
    if (limits.size > 10000) throw new HttpError(429, 'Sign-in is busy. Try again shortly.');
    for (const [key] of keys) {
      const entry = limits.get(key) ?? { count: 0, until: timestamp + 900000 };
      entry.count += 1;
      limits.set(key, entry);
    }
  }
  const middleware = async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (!/^\/api\/(auth(?:\/|$)|progress(?:\/|$)|settings(?:\/|$)|attempts(?:\/|$))/.test(path ?? '')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const send = (value, status = 200) => { if (!res.destroyed) { res.statusCode = status; res.end(JSON.stringify(value)); } };
    try {
      if (path === '/api/auth/me' && req.method === 'GET') return send({ user: store.userForToken(sessionToken(req)) });
      if (['/api/auth/register', '/api/auth/login'].includes(path) && req.method === 'POST') {
        const input = await readJson(req);
        rateLimit(req, input.email);
        const result = await (path.endsWith('register') ? store.register(input) : store.login(input));
        store.logout(sessionToken(req));
        res.setHeader('Set-Cookie', sessionCookie(req, result.token));
        return send({ user: result.user }, path.endsWith('register') ? 201 : 200);
      }
      if (path === '/api/auth/logout' && req.method === 'POST') {
        await readJson(req);
        store.logout(sessionToken(req));
        res.setHeader('Set-Cookie', sessionCookie(req, null));
        return send({ user: null });
      }
      const user = requireUser(req);
      if (path === '/api/progress' && req.method === 'GET') {
        const progress = store.progress(user.id);
        await syncWorkouts(user.id);
        return send(progress);
      }
      if (path === '/api/settings' && ['POST', 'PATCH'].includes(req.method)) {
        return send({ settings: store.saveSettings(user.id, await readJson(req)) });
      }
      if (path === '/api/attempts' && req.method === 'POST') return send({ attempt: store.createAttempt(user.id, await readJson(req)) }, 201);
      if (path === '/api/attempts' && req.method === 'GET') return send({ attempts: store.listAttempts(user.id) });
      const match = path?.match(/^\/api\/attempts\/([a-zA-Z0-9-]{1,100})(\/finish)?$/);
      if (match && !match[2] && req.method === 'GET') return send({ attempt: store.attempt(user.id, match[1]) });
      if (match?.[2] && req.method === 'POST') {
        const input = await readJson(req);
        const result = store.finishAttempt(user.id, match[1], input.reason ?? 'completed');
        await syncWorkouts(user.id);
        return send(result);
      }
      return send({ error: 'This account endpoint or method is unavailable.' }, 405);
    } catch (error) {
      return send({ error: error instanceof HttpError ? error.message : 'Account service is temporarily unavailable. Try again.' }, error instanceof HttpError ? error.status : 500);
    }
  };
  return {
    middleware, store,
    async scoreRep(req, input, review) {
      if (input?.attemptId === undefined) return review();
      const user = requireUser(req);
      const existing = store.reserveRep(user.id, input);
      if (existing.feedback) return existing.feedback;
      try {
        const feedback = await review();
        store.recordRep(user.id, input, feedback);
        return feedback;
      } catch (error) {
        store.failRep(user.id, input, error instanceof HttpError ? error.message : 'This rep review did not finish. Retry the review.');
        throw error;
      }
    },
  };
}

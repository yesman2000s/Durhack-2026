import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { EXERCISE_TRACKS, LEVEL_COUNT, evaluateProgression, progressionTarget } from '../src/level-progression.js';
import { songs } from '../src/music/songs.js';
import { HttpError } from './json-route.js';

const deriveKey = promisify(scrypt);
const SESSION_DAYS = 30;
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const publicUser = (row) => row ? { id: row.id, email: row.email, name: row.name } : null;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = (message) => { throw new HttpError(400, message); };
const defaultSettings = () => ({ songId: songs[0].id, positions: {}, mutedNotes: [] });

function credentials(input, registration = false) {
  if (!record(input)) bad('Enter your email and password.');
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid email address.');
  if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) {
    bad('Use a password between 8 and 128 characters.');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (registration && (!name || name.length > 80)) bad('Enter a name between 1 and 80 characters.');
  return { email, password: input.password, name };
}

function attemptValue(row) {
  return {
    id: row.id, exerciseId: row.exercise_id, variant: row.variant, level: row.level, source: row.source, mode: row.mode,
    status: row.status, score: row.score, repCount: row.rep_count, passed: Boolean(row.passed),
    createdAt: row.created_at, endedAt: row.ended_at, reason: row.reason,
    feedback: row.feedback ? JSON.parse(row.feedback) : null,
  };
}

export function createAccountStore({ filename = resolve(process.cwd(), '.data', 'compose.sqlite'), now = () => Date.now() } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), exercise_id TEXT NOT NULL,
      level INTEGER NOT NULL, source TEXT NOT NULL, mode TEXT NOT NULL, variant TEXT NOT NULL DEFAULT 'bodyweight', status TEXT NOT NULL DEFAULT 'active',
      score REAL, rep_count INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, ended_at TEXT, reason TEXT, feedback TEXT
    );
    CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS rep_scores (
      user_id TEXT NOT NULL REFERENCES users(id), rep_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL REFERENCES attempts(id), status TEXT NOT NULL, score REAL,
      feedback TEXT, error TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, rep_id)
    );
    CREATE INDEX IF NOT EXISTS rep_attempt ON rep_scores(attempt_id);
    CREATE TABLE IF NOT EXISTS level_progress (
      user_id TEXT NOT NULL REFERENCES users(id), exercise_id TEXT NOT NULL, level INTEGER NOT NULL,
      score REAL NOT NULL, rep_count INTEGER NOT NULL, baseline REAL NOT NULL, variant TEXT NOT NULL DEFAULT 'bodyweight',
      attempt_id TEXT NOT NULL REFERENCES attempts(id), completed_at TEXT NOT NULL,
      PRIMARY KEY (user_id, exercise_id, level)
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id), value TEXT NOT NULL
    );
  `);
  for (const table of ['attempts', 'level_progress']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'variant')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN variant TEXT NOT NULL DEFAULT 'bodyweight'`);
    }
  }
  // A provider request cannot survive a server restart. Keep its evidence of
  // failure visible, and let the user finish or retry the saved attempt.
  db.prepare("UPDATE rep_scores SET status = 'error', error = ? WHERE status = 'pending'")
    .run('The server restarted during this review. Retry this rep review.');

  const iso = () => new Date(now()).toISOString();
  function transaction(handle) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = handle(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function ownedAttempt(userId, id) {
    const row = db.prepare('SELECT * FROM attempts WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw new HttpError(404, 'This workout attempt was not found.');
    return row;
  }
  function progress(userId) {
    const completed = db.prepare('SELECT * FROM level_progress WHERE user_id = ? ORDER BY level').all(userId);
    const tracks = EXERCISE_TRACKS.map(({ id }) => {
      const rows = completed.filter((row) => row.exercise_id === id);
      const track = { exerciseId: id, variant: rows[0]?.variant ?? null, baseline: rows[0]?.baseline ?? null, completedLevels: rows.length,
        levels: Array.from({ length: LEVEL_COUNT }, (_, index) => {
          const level = index + 1;
          const row = rows.find((item) => item.level === level);
          return { level, status: row ? 'completed' : level === rows.length + 1 ? 'available' : 'locked',
            score: row?.score ?? null, repCount: row?.rep_count ?? 0, completedAt: row?.completed_at ?? null };
        }) };
      return { ...track, target: progressionTarget(track) };
    });
    const saved = db.prepare('SELECT value FROM user_settings WHERE user_id = ?').get(userId);
    return { tracks, settings: saved ? JSON.parse(saved.value) : defaultSettings() };
  }
  function attempt(userId, id) {
    const row = ownedAttempt(userId, id);
    const reps = db.prepare('SELECT * FROM rep_scores WHERE attempt_id = ? ORDER BY rowid').all(id).map((rep) => ({
      id: rep.rep_id, status: rep.status, score: rep.score, feedback: rep.feedback ? JSON.parse(rep.feedback) : null,
      error: rep.error, createdAt: rep.created_at,
    }));
    return { ...attemptValue(row), reps };
  }
  function issueSession(userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash(token), userId, now() + SESSION_DAYS * 86400000);
    return token;
  }

  return {
    close: () => db.close(),
    async register(input) {
      const { email, password, name } = credentials(input, true);
      const salt = randomBytes(16).toString('hex');
      const hash = (await deriveKey(password, salt, 64)).toString('hex');
      const user = { id: randomUUID(), email, name };
      try {
        db.prepare('INSERT INTO users (id,email,name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)')
          .run(user.id, email, name, hash, salt, iso());
      } catch (error) {
        if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: users.email/.test(error.message)) {
          throw new HttpError(409, 'An account already uses this email. Sign in instead.');
        }
        throw error;
      }
      return { user, token: issueSession(user.id) };
    },
    async login(input) {
      const { email, password } = credentials(input);
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      // Derive a key even for missing accounts, so existence is not leaked by a
      // fast password check. Neither plaintext passwords nor session tokens persist.
      const hash = await deriveKey(password, row?.password_salt ?? '0'.repeat(32), 64);
      const expected = row ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64);
      if (!timingSafeEqual(hash, expected) || !row) throw new HttpError(401, 'Email or password is incorrect.');
      return { user: publicUser(row), token: issueSession(row.id) };
    },
    userForToken(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      return publicUser(db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE token_hash = ? AND expires_at > ?`).get(tokenHash(token), now()));
    },
    logout(token) { if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)); },
    progress,
    saveSettings(userId, input) {
      if (!record(input) || Object.keys(input).some((key) => !['songId', 'positions', 'mutedNotes'].includes(key))) bad('Choose valid music settings.');
      const current = progress(userId);
      const settings = { ...current.settings, ...input };
      if (!songs.some((song) => song.id === settings.songId)) bad('Choose an available song.');
      const validNote = (key) => {
        if (typeof key !== 'string' || !/^[a-z-]+:[1-7]$/.test(key)) return false;
        const [exerciseId, level] = key.split(':');
        return current.tracks.some((track) => track.exerciseId === exerciseId && track.completedLevels >= Number(level));
      };
      if (!record(settings.positions) || Object.keys(settings.positions).length > EXERCISE_TRACKS.length * LEVEL_COUNT ||
          Object.entries(settings.positions).some(([key, value]) => !validNote(key) || !Number.isInteger(value) || value < 0 || value >= LEVEL_COUNT)) {
        bad('Arrange only unlocked notes in song slots 0 to 6.');
      }
      // Multiple instruments may share a slot; two notes of the same instrument
      // may not. Unspecified notes keep their original level's slot.
      for (const track of current.tracks) {
        const slots = Array.from({ length: track.completedLevels }, (_, index) => settings.positions[`${track.exerciseId}:${index + 1}`] ?? index);
        if (new Set(slots).size !== slots.length) bad('Give each note in an instrument its own slot.');
      }
      if (!Array.isArray(settings.mutedNotes) || settings.mutedNotes.length > 28 || settings.mutedNotes.some((key) => !validNote(key))) {
        bad('Mute only unlocked notes.');
      }
      settings.mutedNotes = [...new Set(settings.mutedNotes)];
      db.prepare('INSERT INTO user_settings (user_id,value) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value')
        .run(userId, JSON.stringify(settings));
      return settings;
    },
    createAttempt(userId, input) {
      if (!record(input) || !EXERCISE_TRACKS.some(({ id }) => id === input.exerciseId)) bad('Choose an available movement.');
      const track = progress(userId).tracks.find(({ exerciseId }) => exerciseId === input.exerciseId);
      if (!Number.isInteger(input.level) || input.level !== track.target?.level) throw new HttpError(409, 'Choose your next available level.');
      const variant = input.variant ?? 'bodyweight';
      if (!(input.exerciseId === 'squat' ? ['bodyweight', 'barbell'] : ['bodyweight']).includes(variant)) bad('Choose a supported movement variant.');
      if (track.variant && track.variant !== variant) throw new HttpError(409, `Your saved baseline uses ${track.variant}. Use the same variant for this level.`);
      if (!['webcam', 'video', 'simulated'].includes(input.source)) bad('Choose a supported capture source.');
      if (!['single-rep', 'set'].includes(input.mode)) bad('Choose single-rep or set coaching.');
      const active = db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE user_id = ? AND status = 'active'").get(userId).count;
      if (active >= 20) throw new HttpError(409, 'Finish an existing workout before starting another.');
      const id = randomUUID();
      db.prepare('INSERT INTO attempts (id,user_id,exercise_id,variant,level,source,mode,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, userId, input.exerciseId, variant, input.level, input.source, input.mode, iso());
      return attempt(userId, id);
    },
    listAttempts(userId) {
      return db.prepare('SELECT * FROM attempts WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100')
        .all(userId).map(attemptValue);
    },
    attempt,
    reserveRep(userId, input) {
      if (typeof input.attemptId !== 'string' || input.attemptId.length > 100 || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 160) {
        bad('Include the workout attempt and captured rep IDs.');
      }
      const row = ownedAttempt(userId, input.attemptId);
      if (input.exercise !== row.exercise_id || input.source !== row.source) bad('Rep movement and capture source must match the workout.');
      if ((input.variant ?? 'bodyweight') !== row.variant) bad('Rep variant must match the workout and personal baseline.');
      const previous = db.prepare('SELECT * FROM rep_scores WHERE user_id = ? AND rep_id = ?').get(userId, input.id);
      if (previous) {
        if (previous.attempt_id !== row.id) throw new HttpError(409, 'This rep already belongs to another workout.');
        if (previous.status === 'scored') return { feedback: JSON.parse(previous.feedback) };
        if (previous.status === 'pending') throw new HttpError(409, 'This rep is already being reviewed.');
        if (row.status !== 'active') throw new HttpError(409, 'This workout has already finished.');
        db.prepare("UPDATE rep_scores SET status='pending', error=NULL WHERE user_id=? AND rep_id=? AND status='error'")
          .run(userId, input.id);
        return { feedback: null };
      }
      if (row.status !== 'active') throw new HttpError(409, 'This workout has already finished.');
      const count = db.prepare('SELECT COUNT(*) AS count FROM rep_scores WHERE attempt_id = ?').get(row.id).count;
      if (count >= 200) throw new HttpError(400, 'Finish this workout before reviewing more reps.');
      db.prepare('INSERT INTO rep_scores (user_id,rep_id,attempt_id,status,created_at) VALUES (?,?,?,?,?)')
        .run(userId, input.id, row.id, 'pending', iso());
      return { feedback: null };
    },
    recordRep(userId, input, feedback) {
      db.prepare("UPDATE rep_scores SET status='scored', score=?, feedback=? WHERE user_id=? AND rep_id=? AND attempt_id=? AND status='pending'")
        .run(feedback.score, JSON.stringify(feedback), userId, input.id, input.attemptId);
    },
    failRep(userId, input, message) {
      db.prepare("UPDATE rep_scores SET status='error', error=? WHERE user_id=? AND rep_id=? AND attempt_id=? AND status='pending'")
        .run(message, userId, input.id, input.attemptId);
    },
    finishAttempt(userId, id, reason = 'completed') {
      if (!['completed', 'cancelled', 'error'].includes(reason)) bad('Choose a valid workout finish reason.');
      return transaction(() => {
        const row = ownedAttempt(userId, id);
        if (row.status !== 'active') return { attempt: attempt(userId, id), progress: progress(userId) };
        const reps = db.prepare('SELECT * FROM rep_scores WHERE attempt_id = ? ORDER BY rowid').all(id);
        if (reps.some((rep) => rep.status === 'pending')) throw new HttpError(409, 'Wait for the current rep reviews to finish.');
        if (reason === 'completed' && reps.some((rep) => rep.status === 'error')) {
          throw new HttpError(409, 'Retry the failed rep reviews, or save this workout with an error result.');
        }
        const scored = reps.filter((rep) => rep.status === 'scored' && rep.score !== null);
        const score = scored.length ? Math.round(scored.reduce((sum, rep) => sum + rep.score, 0) / scored.length * 100) / 100 : null;
        const track = progress(userId).tracks.find(({ exerciseId }) => exerciseId === row.exercise_id);
        const result = evaluateProgression(track, { score, repCount: scored.length, source: row.source, level: row.level, baselineScore: scored[0]?.score });
        const passed = reason === 'completed' && result.passed;
        const endedAt = iso();
        const lastFeedback = reps.filter((rep) => rep.feedback).at(-1)?.feedback ?? null;
        db.prepare('UPDATE attempts SET status=?,score=?,rep_count=?,passed=?,ended_at=?,reason=?,feedback=? WHERE id=?')
          .run(reason, score, scored.length, Number(passed), endedAt, reason, lastFeedback, id);
        if (passed) {
          db.prepare('INSERT INTO level_progress (user_id,exercise_id,level,score,rep_count,baseline,variant,attempt_id,completed_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(userId, row.exercise_id, row.level, score, scored.length, result.baseline, row.variant, id, endedAt);
          const settings = progress(userId).settings;
          const usedSlots = new Set(Array.from({ length: row.level - 1 }, (_, index) => settings.positions[`${row.exercise_id}:${index + 1}`] ?? index));
          if (usedSlots.has(row.level - 1)) {
            const freeSlot = Array.from({ length: LEVEL_COUNT }, (_, index) => index).find((slot) => !usedSlots.has(slot));
            settings.positions[`${row.exercise_id}:${row.level}`] = freeSlot;
            db.prepare('INSERT INTO user_settings (user_id,value) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value')
              .run(userId, JSON.stringify(settings));
          }
        }
        return { attempt: attempt(userId, id), progress: progress(userId) };
      });
    },
  };
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

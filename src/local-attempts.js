const DATABASE_NAME = 'compose-local-attempts';
const STORE_NAME = 'attempts';

function identity(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`A signed-in ${label} is required for local recordings.`);
  return value;
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') {
    return new Error('This device has no space for the recording. Delete an older local recording or free browser storage, then try again.', { cause: error });
  }
  return new Error('The recording could not be saved or opened on this device. Allow browser storage and try again.', { cause: error });
}

// A factory keeps the browser adapter independently testable without replacing
// window globals. The default exports below share one lazily opened database.
export function createLocalAttemptVault({ indexedDB = globalThis.indexedDB, now = () => new Date().toISOString() } = {}) {
  let connection;

  function open() {
    if (!indexedDB) return Promise.reject(new Error('Local recording storage is unavailable in this browser. Use a browser with IndexedDB enabled.'));
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      try { request = indexedDB.open(DATABASE_NAME, 1); } catch (error) { reject(storageError(error)); return; }
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.createObjectStore(STORE_NAME, { keyPath: ['userId', 'attemptId'] });
        store.createIndex('userId', 'userId', { unique: false });
      };
      request.onerror = () => { settled = true; reject(storageError(request.error)); };
      request.onblocked = () => {
        settled = true;
        reject(new Error('Close other Motif tabs, then retry saving the local recording.'));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        database.onversionchange = () => { database.close(); connection = undefined; };
        resolve(database);
      };
    }).catch((error) => { connection = undefined; throw error; });
    return connection;
  }

  async function transaction(mode, operation) {
    const database = await open();
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      let failure;
      try { tx = database.transaction(STORE_NAME, mode); } catch (error) { reject(storageError(error)); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => { failure ??= tx.error; };
      tx.onabort = () => reject(storageError(failure ?? tx.error));
      try {
        operation(tx.objectStore(STORE_NAME), (value) => { result = value; }, (error) => {
          failure = error;
          tx.abort();
        });
      } catch (error) {
        failure = error;
        try { tx.abort(); } catch { reject(storageError(error)); }
      }
    });
  }

  async function saveLocalAttempt(userId, attemptId, patch) {
    identity(userId, 'user');
    identity(attemptId, 'attempt');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('A local attempt update must be an object.');
    if (patch.video != null && !(patch.video instanceof Blob)) throw new Error('A local recording must be a video Blob.');
    const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    return transaction('readwrite', (store, done, fail) => {
      const request = store.get([userId, attemptId]);
      request.onsuccess = () => {
        try {
          const previous = request.result;
          const timestamp = now();
          const record = { ...previous, ...changes, userId, attemptId, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
          const save = store.put(record);
          save.onsuccess = () => done(record);
        } catch (error) { fail(error); }
      };
    });
  }

  async function getLocalAttempt(userId, attemptId) {
    identity(userId, 'user');
    identity(attemptId, 'attempt');
    return transaction('readonly', (store, done) => {
      const request = store.get([userId, attemptId]);
      request.onsuccess = () => done(request.result ?? null);
    });
  }

  async function listLocalAttempts(userId) {
    identity(userId, 'user');
    return transaction('readonly', (store, done) => {
      const request = store.index('userId').getAll(userId);
      request.onsuccess = () => done(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
  }

  async function deleteLocalAttempt(userId, attemptId) {
    identity(userId, 'user');
    identity(attemptId, 'attempt');
    return transaction('readwrite', (store, done) => {
      const request = store.delete([userId, attemptId]);
      request.onsuccess = () => done(true);
    });
  }

  return { saveLocalAttempt, getLocalAttempt, listLocalAttempts, deleteLocalAttempt };
}

const vault = createLocalAttemptVault();
export const { saveLocalAttempt, getLocalAttempt, listLocalAttempts, deleteLocalAttempt } = vault;

export async function requestPersistentStorage(storage = globalThis.navigator?.storage) {
  if (!storage) return false;
  try {
    if (await storage.persisted?.()) return true;
    return (await storage.persist?.()) === true;
  } catch { return false; }
}

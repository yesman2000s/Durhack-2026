import { randomBytes } from 'node:crypto';
import { createAccountStore } from '../server/accounts-store.js';

const email = process.env.COMPOSE_PREVIEW_EMAIL || 'unlocked@compose.test';
const password = process.env.COMPOSE_PREVIEW_PASSWORD || `Compose-${randomBytes(9).toString('base64url')}`;
const store = createAccountStore({ recoverPendingReviews: false });
try {
  // An existing address is never overwritten or silently granted access.
  const { user, token } = await store.register({ email, password, name: 'Unlocked Preview' });
  store.logout(token);
  const progress = store.unlockMusic(user.id);
  console.log(JSON.stringify({ email, password, unlockedNotes: progress.tracks.reduce((sum, track) => sum + track.completedLevels, 0) }, null, 2));
} finally {
  store.close();
}

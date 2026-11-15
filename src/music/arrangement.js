import { LEVEL_COUNT } from '../level-progression.js';

const noteKey = (exerciseId, level) => `${exerciseId}:${level}`;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const isSlot = (value) => Number.isInteger(value) && value >= 0 && value < LEVEL_COUNT;

function uniqueLevels(track) {
  const seen = new Set();
  return (track?.levels ?? []).filter((entry) => {
    if (!Number.isInteger(entry?.level) || entry.level < 1 || entry.level > LEVEL_COUNT || seen.has(entry.level)) return false;
    seen.add(entry.level);
    return true;
  });
}

// Visual placement is independent of level identity and audio time. Completed
// clips own their saved slots; future levels fill the remaining visible spaces.
export function visualSlots(track, positions = {}) {
  const levels = uniqueLevels(track);
  const ordered = [...levels.filter(({ status }) => status === 'completed'), ...levels.filter(({ status }) => status !== 'completed')];
  const slots = {}, used = new Set();
  for (const { level, status } of ordered) {
    const saved = positions?.[noteKey(track.exerciseId, level)];
    const preferred = status === 'completed' && isSlot(saved) ? saved : level - 1;
    const slot = !used.has(preferred) ? preferred : Array.from({ length: LEVEL_COUNT }, (_, index) => index).find((value) => !used.has(value));
    slots[level] = slot;
    used.add(slot);
  }
  return slots;
}

// Returns the original reference for an ignored move, so callers can avoid a
// needless settings request. A valid move returns only completed clip keys.
export function moveClipPositions(tracks, positions = {}, exerciseId, level, toSlot) {
  if (!Array.isArray(tracks) || !Number.isInteger(level) || !Number.isFinite(toSlot)) return positions;
  const track = tracks.find((entry) => entry.exerciseId === exerciseId);
  const completed = uniqueLevels(track).filter((entry) => entry.status === 'completed');
  if (!completed.some((entry) => entry.level === level)) return positions;
  const slots = visualSlots(track, positions);
  const destination = clamp(Math.round(toSlot), 0, LEVEL_COUNT - 1);
  const origin = slots[level];
  if (origin === destination) return positions;

  const next = {};
  for (const entry of tracks) {
    const trackSlots = visualSlots(entry, positions);
    for (const item of uniqueLevels(entry).filter((item) => item.status === 'completed')) {
      next[noteKey(entry.exerciseId, item.level)] = trackSlots[item.level];
    }
  }
  const displaced = completed.find((entry) => slots[entry.level] === destination);
  next[noteKey(exerciseId, level)] = destination;
  if (displaced) next[noteKey(exerciseId, displaced.level)] = origin;
  return next;
}

// Snap equally in either direction, including exact half-slot crossings.
// Callers add horizontal scroll movement to deltaX while dragging.
export function dragSlot(startSlot, deltaX, slotWidth, levelCount = LEVEL_COUNT) {
  const count = Number.isInteger(levelCount) && levelCount > 0 ? levelCount : LEVEL_COUNT;
  const origin = clamp(Number.isFinite(startSlot) ? Math.round(startSlot) : 0, 0, count - 1);
  if (!Number.isFinite(deltaX) || !Number.isFinite(slotWidth) || slotWidth <= 0) return origin;
  const movement = Math.sign(deltaX) * Math.floor(Math.abs(deltaX) / slotWidth + 0.5);
  return clamp(origin + movement, 0, count - 1);
}

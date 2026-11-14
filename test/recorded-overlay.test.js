import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedGuideTime } from '../src/recorded-overlay.js';
import { guidePlaybackTimes } from '../src/training-overlay.js';

test('the recorded guide follows the rep phases when playing or seeking', () => {
  const timing = { movement: 4500, bottom: 5100, rise: 5900, returned: 6600 };
  const { lowerEndMs, bottomEndMs, returnEndMs } = guidePlaybackTimes;
  assert.equal(recordedGuideTime(4300, timing), 0);
  assert.equal(recordedGuideTime(4800, timing), lowerEndMs / 2);
  assert.equal(recordedGuideTime(5500, timing), (lowerEndMs + bottomEndMs) / 2);
  assert.equal(recordedGuideTime(6250, timing), (bottomEndMs + returnEndMs) / 2);
  assert.equal(recordedGuideTime(6700, timing), returnEndMs);
  assert.equal(recordedGuideTime(4800, timing), lowerEndMs / 2);
});

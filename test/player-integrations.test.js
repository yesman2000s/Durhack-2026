import test from 'node:test';
import assert from 'node:assert/strict';
import { connectMediaSession, createPlayerKeyHandler } from '../src/music/player-integrations.js';

const song = { id: 'hiphop', title: 'Griphop' };
const Metadata = class { constructor(data) { Object.assign(this, data); } };
function mediaFixture() {
  const handlers = new Map(), positions = [], calls = [];
  const session = { metadata: null, playbackState: 'none',
    setActionHandler(action, handler) { handlers.set(action, handler); },
    setPositionState(position) { positions.push(position); },
  };
  const state = { song, active: true, status: 'playing', duration: 32, elapsed: 12,
    play: () => calls.push('play'), pause: () => calls.push('pause'), stop: () => calls.push('stop'),
    seek: (position) => calls.push(position), nexttrack: () => calls.push('next'),
  };
  const media = connectMediaSession(session, Metadata, () => state);
  return { handlers, positions, calls, session, state, media };
}

test('native controls follow the latest playback state and seek within the unlocked arrangement', () => {
  const f = mediaFixture();
  f.media.update();
  assert.equal(f.session.metadata.title, song.title);
  assert.equal(f.session.metadata.artist, 'Kevin MacLeod');
  assert.equal(f.session.playbackState, 'playing');
  assert.deepEqual(f.positions.at(-1), { duration: 32, playbackRate: 1, position: 12 });
  f.handlers.get('pause')(); f.handlers.get('play')(); f.handlers.get('nexttrack')();
  f.handlers.get('seekbackward')({ seekOffset: 20 });
  f.handlers.get('seekforward')({ seekOffset: 40 });
  f.handlers.get('seekto')({ seekTime: 6 });
  f.handlers.get('seekto')({ seekTime: NaN });
  assert.deepEqual(f.calls, ['pause', 'play', 'next', 0, 32, 6]);
  f.state.elapsed = 20;
  f.handlers.get('seekbackward')();
  assert.equal(f.calls.at(-1), 15);
  f.state.status = 'paused'; f.state.previewKey = 'push-up:3'; f.state.duration = 8; f.state.elapsed = 1;
  f.media.update();
  assert.equal(f.session.playbackState, 'paused');
  assert.equal(f.session.metadata.album, 'Motif · Note 3 preview');
});

test('ending the player clears metadata and handlers; stale native actions cannot restart it', () => {
  const f = mediaFixture();
  f.media.update();
  const oldPlay = f.handlers.get('play');
  f.state.active = false;
  f.media.update(); oldPlay();
  assert.equal(f.session.playbackState, 'none');
  assert.equal(f.session.metadata, null);
  assert.equal(f.positions.at(-1), undefined);
  assert.equal(f.handlers.get('play'), null);
  assert.deepEqual(f.calls, []);
  f.media.dispose();
  f.state.active = true; f.media.update();
  assert.equal(typeof f.handlers.get('play'), 'function');
  f.media.dispose();
  assert.equal(f.session.playbackState, 'none');
  oldPlay();
  assert.deepEqual(f.calls, []);
});

test('missing or partial browser media-session support does not break playback', () => {
  assert.doesNotThrow(() => connectMediaSession(undefined, undefined, () => ({})).update());
  const f = mediaFixture();
  f.session.setActionHandler = (action, callback) => {
    if (action.startsWith('seek')) throw new Error('Unsupported');
    f.handlers.set(action, callback);
  };
  f.session.setPositionState = () => { throw new Error('Unsupported'); };
  assert.doesNotThrow(() => f.media.update());
  f.handlers.get('pause')();
  assert.deepEqual(f.calls, ['pause']);
  assert.doesNotThrow(() => f.media.dispose());
});

function keyboardFixture() {
  const calls = [], event = { key: ' ', target: { closest: () => null, ownerDocument: { querySelector: () => null } },
    preventDefault: () => calls.push('prevent'),
  };
  const state = { hasAudio: true, hasPlayer: true, status: 'paused', elapsed: 2, duration: 32,
    toggle: () => calls.push('toggle'), toggleMute: () => calls.push('mute'), seek: (position) => calls.push(position),
  };
  return { calls, event, state, handle: createPlayerKeyHandler(() => state) };
}

test('player shortcuts operate on the latest position without seeking outside the mix', () => {
  const f = keyboardFixture();
  f.handle(f.event);
  f.event.key = 'm'; f.handle(f.event);
  f.event.key = 'ArrowLeft'; f.handle(f.event);
  f.state.elapsed = 30; f.event.key = 'ArrowRight'; f.handle(f.event);
  assert.deepEqual(f.calls, ['prevent', 'toggle', 'prevent', 'mute', 'prevent', 0, 'prevent', 32]);
});

test('shortcuts preserve keyboard behaviour in controls, dialogs, composition and modified keys', () => {
  const f = keyboardFixture();
  for (const property of ['defaultPrevented', 'repeat', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing']) {
    f.handle({ ...f.event, [property]: true });
  }
  f.handle({ ...f.event, target: { closest: () => ({}) } });
  f.handle({ ...f.event, target: { ownerDocument: { querySelector: () => ({}) } } });
  f.state.hasAudio = false; f.handle(f.event);
  f.state.hasAudio = true; f.state.status = 'loading'; f.handle(f.event);
  f.state.status = 'paused'; f.state.hasPlayer = false;
  f.event.key = 'ArrowRight'; f.handle(f.event);
  assert.deepEqual(f.calls, []);
});

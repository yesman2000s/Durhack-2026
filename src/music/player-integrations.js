const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Media Session support varies by browser and by action. Unsupported controls
// must never prevent the in-page player from working.
export function connectMediaSession(session, Metadata, getState) {
  let active = false;
  let metadataKey = '';
  const registered = new Set();
  const tryAction = (action, handler) => {
    try { session?.setActionHandler(action, handler); return true; } catch { return false; }
  };
  const clear = () => {
    if (!active) return;
    for (const action of registered) tryAction(action, null);
    registered.clear(); active = false; metadataKey = '';
    try { session.metadata = null; session.playbackState = 'none'; session.setPositionState?.(); } catch { /* Optional API. */ }
  };
  const invoke = (action) => (details = {}) => {
    const state = getState();
    if (!active || !state.active) return;
    if (action === 'seekbackward' || action === 'seekforward') {
      const offset = Number.isFinite(details.seekOffset) && details.seekOffset > 0 ? details.seekOffset : 5;
      state.seek(clamp(state.elapsed + (action === 'seekbackward' ? -offset : offset), 0, state.duration));
    } else if (action === 'seekto') {
      if (Number.isFinite(details.seekTime)) state.seek(clamp(details.seekTime, 0, state.duration));
    } else state[action]?.();
  };
  function update() {
    if (!session) return;
    const state = getState();
    if (!state.active) { clear(); return; }
    active = true;
    for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack']) {
      const supported = action.startsWith('seek') || typeof state[action] === 'function';
      if (supported && !registered.has(action) && tryAction(action, invoke(action))) registered.add(action);
      else if (!supported && registered.has(action)) { tryAction(action, null); registered.delete(action); }
    }
    const key = `${state.song.id}/${state.previewKey ?? ''}`;
    if (key !== metadataKey && Metadata) {
      try {
        session.metadata = new Metadata({ title: state.song.title, artist: 'Kevin MacLeod',
          album: state.previewKey ? `Compose · Note ${state.previewKey.split(':')[1]} preview` : 'Compose · Your movement mix' });
        metadataKey = key;
      } catch { /* Older implementations can expose incomplete metadata support. */ }
    }
    try { session.playbackState = state.status === 'playing' ? 'playing' : 'paused'; } catch { /* Optional API. */ }
    try {
      if (Number.isFinite(state.duration) && state.duration > 0) {
        session.setPositionState?.({ duration: state.duration, playbackRate: 1,
          position: clamp(Number.isFinite(state.elapsed) ? state.elapsed : 0, 0, state.duration) });
      } else session.setPositionState?.();
    } catch { /* Some browsers support handlers without position state. */ }
  }
  return { update, dispose: clear };
}

const INTERACTIVE = 'input,textarea,select,button,a,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="slider"],[role="switch"],[role="textbox"],[role="menuitem"],[role="tab"]';

// Leave native keyboard behaviour intact in forms, sliders and dialogs.
export function createPlayerKeyHandler(getState) {
  return (event) => {
    if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    const target = event.target;
    if (target?.closest?.(INTERACTIVE) || target?.ownerDocument?.querySelector('[role="dialog"],dialog[open]')) return;
    const state = getState();
    if (!state.hasAudio || state.status === 'loading') return;
    const key = event.key.toLowerCase();
    let action;
    if (key === ' ') action = state.toggle;
    else if (key === 'm') action = state.toggleMute;
    else if (state.hasPlayer && (key === 'arrowleft' || key === 'arrowright')) {
      action = () => state.seek(clamp(state.elapsed + (key === 'arrowleft' ? -5 : 5), 0, state.duration));
    }
    if (action) { event.preventDefault(); action(); }
  };
}

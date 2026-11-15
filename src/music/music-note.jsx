import React from 'react';

// A beamed pair of eighth notes: solid, tilted noteheads, stems attached at
// their right edge, and one continuous beam. This is a music symbol, not a
// transcription of the audio section represented by a studio tile.
export function MusicNote({ size = 32, className = '' }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
    <ellipse cx="12" cy="37" rx="7.2" ry="4.8" transform="rotate(-22 12 37)" />
    <ellipse cx="31" cy="31" rx="7.2" ry="4.8" transform="rotate(-22 31 31)" />
    <path d="M17.6 11 38.6 5v6.2l-21 6Z" />
    <path d="M18.8 36V12M37.8 30V6" fill="none" stroke="currentColor" strokeWidth="2.4" />
  </svg>;
}

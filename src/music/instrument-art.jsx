import React from 'react';

// Small line illustrations keep each movement recognizable without image assets.
export function InstrumentArt({ instrument }) {
  const paths = {
    Drums: <><ellipse cx="32" cy="27" rx="19" ry="7" /><path d="M13 27v22c0 9 38 9 38 0V27M13 43c0 9 38 9 38 0M20 31l8 20 8-20 8 20M8 12l40 13M57 10 21 26" /></>,
    Bass: <><path d="m41 9 9-5 9 8-6 9-6-2-19 25c6 6 2 13-4 15-7 3-17-2-18-10-1-7 4-12 11-11l22-25Z" /><path d="m20 47 27-33m-9-1 10 8M14 48l9 7M44 8l11 10" /><circle cx="20" cy="47" r="4" /></>,
    Guitar: <><path d="m44 6 10 6-6 10-4-2-14 20c7 3 10 11 5 17-5 7-17 6-24-1-7-8-7-17 0-21 5-3 8 0 11-4 3-4 8-3 11 0l10-15-3-2Z" /><circle cx="24" cy="44" r="6" /><path d="m23 45 25-31M13 48l9 8m22-45 7 5" /></>,
    Piano: <><rect x="6" y="18" width="52" height="33" rx="3" /><path d="M6 28h52M15 28v23m9-23v23m10-23v23m10-23v23m7-23v23M18 18v18h5V18m10 0v18h5V18m10 0v18h5V18" /></>,
    Percussion: <><ellipse cx="32" cy="29" rx="24" ry="17" /><path d="M8 29v7c0 23 48 23 48 0v-7" /><ellipse cx="32" cy="29" rx="17" ry="11" /><path d="M14 36v9m11-1v9m14-9v9m11-17v9" /></>,
  };
  return <svg className="instrument-art" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[instrument] ?? paths.Piano}</svg>;
}

import React from 'react';
import './score-ring.css';

export function ScoreRing({ score, label = 'Form score', pending = false, compact = false }) {
  const value = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
  return <div className={`score-ring${compact ? ' score-ring-compact' : ''}`} data-pending={pending}
    role="img" aria-label={`${label}: ${value === null ? pending ? 'reviewing' : 'not scored' : `${value} out of 100`}`}>
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle className="score-ring-track" cx="60" cy="60" r="51" />
      {value !== null && <circle className="score-ring-value" cx="60" cy="60" r="51" pathLength="100"
        strokeDasharray={`${value} 100`} transform="rotate(-90 60 60)" />}
    </svg>
    <span className="score-ring-number" aria-hidden="true"><strong>{value === null ? '—' : Math.round(value * 10) / 10}</strong><small>{value === null ? pending ? 'reviewing' : 'not scored' : '/ 100'}</small></span>
    <span className="score-ring-label" aria-hidden="true">{label}</span>
  </div>;
}

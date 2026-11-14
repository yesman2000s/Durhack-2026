import React, { useEffect, useRef, useState } from 'react';
import { isPlaybackJointVisible, poseAtTime } from './motion-trace.js';

const CONNECTIONS = [
  ['nose', 'shoulder'], ['shoulder', 'elbow'], ['elbow', 'wrist'],
  ['shoulder', 'hip'], ['hip', 'knee'], ['knee', 'ankle'],
  ['ankle', 'heel'], ['heel', 'toe'], ['ankle', 'toe'],
];

function renderPose(canvas, joints, width, height) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (!joints) return;
  const size = Math.max(5, Math.min(width, height) / 70);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const [from, to] of CONNECTIONS) {
    if (!isPlaybackJointVisible(from, joints[from]) || !isPlaybackJointVisible(to, joints[to])) continue;
    ctx.moveTo(joints[from].x * width, joints[from].y * height);
    ctx.lineTo(joints[to].x * width, joints[to].y * height);
  }
  ctx.lineWidth = size * 1.7;
  ctx.strokeStyle = '#071525';
  ctx.stroke();
  ctx.lineWidth = size;
  ctx.strokeStyle = '#6df7dc';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#10364c';
  ctx.lineWidth = Math.max(2, size * .4);
  for (const [name, point] of Object.entries(joints)) {
    if (!isPlaybackJointVisible(name, point)) continue;
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, size * .86, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function SkeletonPlayback({ motionTrace, camera, movementStartOffsetMs, exerciseName = 'Squat' }) {
  const frames = motionTrace.frames;
  const start = Math.max(frames[0].offsetMs, movementStartOffsetMs - 250);
  const end = frames.at(-1).offsetMs;
  const duration = Math.max(0, end - start);
  const [playing, setPlaying] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const current = useRef(0);
  const clockOrigin = useRef(null);
  const canvas = useRef(null);
  const positionInput = useRef(null);
  const elapsedLabel = useRef(null);
  const gap = useRef(null);
  const scale = Math.min(1, 960 / Math.max(camera.width, camera.height));
  const width = Math.max(1, Math.round(camera.width * scale));
  const height = Math.max(1, Math.round(camera.height * scale));
  const durationLabel = seconds(duration);

  function updateDisplay(position, updateClock) {
    const joints = poseAtTime(frames, start + position);
    renderPose(canvas.current, joints, width, height);
    gap.current.hidden = Boolean(joints);
    positionInput.current.value = String(position);
    if (updateClock) {
      elapsedLabel.current.textContent = seconds(position);
      positionInput.current.setAttribute('aria-valuetext', `${seconds(position)} of ${durationLabel}`);
    }
  }

  useEffect(() => {
    updateDisplay(current.current, true);
    if (!playing) return undefined;
    const origin = performance.now() - current.current;
    clockOrigin.current = origin;
    let request;
    let lastClock = performance.now();
    const advance = (now) => {
      const next = Math.min(duration, Math.max(0, now - origin));
      current.current = next;
      const updateClock = now - lastClock >= 100 || next >= duration;
      if (updateClock) lastClock = now;
      updateDisplay(next, updateClock);
      if (next < duration) request = requestAnimationFrame(advance);
      else {
        clockOrigin.current = null;
        setAtEnd(true);
        setPlaying(false);
      }
    };
    request = requestAnimationFrame(advance);
    return () => {
      cancelAnimationFrame(request);
      clockOrigin.current = null;
    };
  }, [playing, duration, frames, start, width, height]);

  function seek(next) {
    clockOrigin.current = null;
    current.current = next;
    updateDisplay(next, true);
    setAtEnd(next >= duration);
    setPlaying(false);
  }

  function toggle() {
    if (playing) {
      const origin = clockOrigin.current;
      seek(origin === null ? current.current : Math.min(duration, performance.now() - origin));
      return;
    }
    if (current.current >= duration) seek(0);
    setPlaying(true);
  }

  const action = playing ? 'Pause skeleton' : atEnd ? 'Replay skeleton' : 'Play skeleton';
  return <section className="skeleton-playback" aria-labelledby="playback-title">
    <h3 id="playback-title">Skeleton playback</h3>
    <div className="skeleton-stage">
      <canvas ref={canvas} width={width} height={height} role="img" aria-label={`Recorded ${exerciseName.toLowerCase()} skeleton`} />
      <span className="skeleton-gap" ref={gap} hidden>Pose unavailable in this section</span>
    </div>
    <div className="skeleton-controls">
      <button className="button button-secondary" onClick={toggle}>{action}</button>
      <input
        ref={positionInput} type="range" min="0" max={duration} step="any" defaultValue="0"
        aria-label="Playback position" aria-valuetext={`0.0 s of ${durationLabel}`}
        onChange={(event) => seek(Number(event.currentTarget.value))}
      />
      <span className="skeleton-time"><span ref={elapsedLabel}>0.0 s</span> / {durationLabel}</span>
    </div>
  </section>;
}

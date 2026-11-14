import React, { useEffect, useRef, useState } from 'react';
import { poseAtTime } from './motion-trace.js';

const CONNECTIONS = [
  ['nose', 'shoulder'], ['shoulder', 'elbow'], ['elbow', 'wrist'],
  ['shoulder', 'hip'], ['hip', 'knee'], ['knee', 'ankle'],
  ['ankle', 'heel'], ['heel', 'toe'], ['ankle', 'toe'],
];

function renderPose(canvas, joints, width, height) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (!joints) return;
  const size = Math.max(2, Math.min(width, height) / 180);
  const visible = (name) => {
    const point = joints[name];
    const cutoff = ['hip', 'knee', 'ankle', 'shoulder'].includes(name) ? 0.35 : 0.55;
    return point && (point.visibility ?? 1) >= cutoff
      && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
  };
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#a9ecdd';
  ctx.fillStyle = '#f0faff';
  for (const [from, to] of CONNECTIONS) {
    if (!visible(from) || !visible(to)) continue;
    ctx.beginPath();
    ctx.moveTo(joints[from].x * width, joints[from].y * height);
    ctx.lineTo(joints[to].x * width, joints[to].y * height);
    ctx.stroke();
  }
  for (const [name, point] of Object.entries(joints)) {
    if (!visible(name)) continue;
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, size * 1.25, 0, Math.PI * 2);
    ctx.fill();
  }
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function SkeletonPlayback({ motionTrace, camera, movementStartOffsetMs }) {
  const frames = motionTrace.frames;
  const start = Math.max(frames[0].offsetMs, movementStartOffsetMs - 250);
  const end = frames.at(-1).offsetMs;
  const duration = Math.max(0, end - start);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const current = useRef(0);
  const canvas = useRef(null);
  const scale = Math.min(1, 960 / Math.max(camera.width, camera.height));
  const width = Math.max(1, Math.round(camera.width * scale));
  const height = Math.max(1, Math.round(camera.height * scale));
  const joints = poseAtTime(frames, start + position);

  useEffect(() => {
    if (canvas.current) renderPose(canvas.current, joints, width, height);
  }, [joints, width, height]);

  useEffect(() => {
    if (!playing) return;
    const origin = performance.now() - current.current;
    let request;
    const advance = (now) => {
      const next = Math.min(duration, Math.max(0, now - origin));
      current.current = next;
      setPosition(next);
      if (next < duration) request = requestAnimationFrame(advance);
      else setPlaying(false);
    };
    request = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(request);
  }, [playing, duration]);

  function seek(next) {
    current.current = next;
    setPosition(next);
    setPlaying(false);
  }

  function toggle() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (current.current >= duration) seek(0);
    setPlaying(true);
  }

  const action = playing ? 'Pause skeleton' : position >= duration ? 'Replay skeleton' : 'Play skeleton';
  return <section className="skeleton-playback" aria-labelledby="playback-title">
    <h3 id="playback-title">Skeleton playback</h3>
    <div className="skeleton-stage">
      <canvas ref={canvas} width={width} height={height} role="img" aria-label="Recorded squat skeleton" />
      {!joints && <span className="skeleton-gap">Pose unavailable in this section</span>}
    </div>
    <div className="skeleton-controls">
      <button className="button button-secondary" onClick={toggle}>{action}</button>
      <input
        type="range" min="0" max={duration} step="any" value={position}
        aria-label="Playback position" aria-valuetext={`${seconds(position)} of ${seconds(duration)}`}
        onChange={(event) => seek(Number(event.currentTarget.value))}
      />
      <span className="skeleton-time">{seconds(position)} / {seconds(duration)}</span>
    </div>
  </section>;
}

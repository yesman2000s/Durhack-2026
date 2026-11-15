import { nextPoseSampleTime } from './pose-cadence.js';

// Generated joints exercise the same capture pipeline as a webcam, with no video file.
const WIDTH = 960, HEIGHT = 540;
const rads = (deg) => deg * Math.PI / 180;
const vector = (joint, length, deg) => ({
  x: joint.x + length * Math.sin(rads(deg)), y: joint.y - length * Math.cos(rads(deg)),
});
const smooth = (v) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(v, 1)))) / 2;

export function demoLandmarks(depth, variant = 'bodyweight') {
  const ankle = { x: 495, y: 423 };
  const knee = vector(ankle, 91, 2 + depth * 23);
  const hip = vector(knee, 102, 1 - depth * 86);
  const shoulder = vector(hip, 114, 2 + depth * 36);
  const head = vector(shoulder, 47, 4 + depth * 19);
  const barbell = variant === 'barbell';
  const elbow = barbell
    ? { x: shoulder.x - 30 - 8 * depth, y: shoulder.y + 43 - 3 * depth }
    : { x: shoulder.x + 43 + 19 * depth, y: shoulder.y + 33 - 11 * depth };
  const wrist = barbell
    ? { x: shoulder.x - 19, y: shoulder.y + 4 }
    : { x: elbow.x + 37, y: elbow.y - 8 };
  const heel = { x: 483, y: 436 };
  const toe = { x: 528, y: 436 };
  const normalize = ({ x, y }, visibility = 0.99) => ({ x: x / WIDTH, y: y / HEIGHT, z: 0, visibility });
  const points = Array.from({ length: 33 }, () => normalize(head, 0));
  points[0] = normalize({ x: head.x + 19, y: head.y - 1 });
  points[7] = normalize({ x: head.x - 4, y: head.y });
  points[8] = normalize({ x: head.x - 3, y: head.y + 2 }, 0.65);
  for (const [left, joint] of [[11, shoulder], [13, elbow], [15, wrist], [23, hip], [25, knee], [27, ankle], [29, heel], [31, toe]]) {
    points[left] = normalize(joint);
    points[left + 1] = normalize({ x: joint.x - 8, y: joint.y - 4 }, 0.77);
  }
  return points;
}

function paintBarbell(ctx, shoulderX, shoulderY) {
  // A side view mostly shows the weight end-on. The short visible shaft and
  // slightly offset plates indicate that the bar crosses the upper back.
  const barX = shoulderX - 39;
  const barY = shoulderY + 3;
  function plate(x, y, radius, fill, edge) {
    ctx.beginPath();
    ctx.ellipse(x, y, radius * 0.84, radius, 0.12, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 2.6;
    ctx.fill();
    ctx.stroke();
  }
  plate(barX + 19, barY - 5, 25, '#263444', '#a9b7c4');
  ctx.beginPath();
  ctx.moveTo(barX - 9, barY + 3);
  ctx.lineTo(shoulderX + 4, shoulderY + 2);
  ctx.strokeStyle = '#d9e3e9';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.stroke();
  plate(barX, barY, 29, '#202b3a', '#b1c7d5');
  plate(barX, barY, 19, '#364c60', '#7090a4');
  plate(barX, barY, 6, '#d9e6f0', '#9bb7ca');
}

function paintDemo(canvas, points, variant) {
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  bg.addColorStop(0, '#1b3030'); bg.addColorStop(1, '#111b1c');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = '#2b4344'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < WIDTH; x += 48) { ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); }
  for (let y = 0; y < HEIGHT; y += 48) { ctx.moveTo(0, y); ctx.lineTo(WIDTH, y); }
  ctx.stroke();
  ctx.fillStyle = '#132324'; ctx.fillRect(0, 439, WIDTH, HEIGHT - 439);
  ctx.fillStyle = '#365050'; ctx.fillRect(0, 439, WIDTH, 2);
  const at = (i) => [points[i].x * WIDTH, points[i].y * HEIGHT];
  for (const [offset, wardrobe] of [[1, ['#425858', '#3b5a59', '#648b80']], [0, ['#6d928c', '#557c7b', '#b9d9c5']]]) {
    const [pants, shirt, skin] = wardrobe;
    for (const [from, to, size, color] of [[23, 25, 35, pants], [25, 27, 27, pants], [29, 31, 18, skin], [11, 23, 59, shirt], [11, 13, 21, shirt], [13, 15, 17, skin]]) {
      ctx.strokeStyle = color; ctx.lineWidth = size; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(...at(from + offset)); ctx.lineTo(...at(to + offset)); ctx.stroke();
    }
  }
  if (variant === 'barbell') paintBarbell(ctx, ...at(11));
  const [headX, headY] = at(7);
  ctx.fillStyle = '#b9d9c5'; ctx.beginPath(); ctx.ellipse(headX + 5, headY - 3, 19, 23, -0.08, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#a3bcba'; ctx.font = '700 15px system-ui'; ctx.fillText('SIMULATED MOVEMENT', 33, HEIGHT - 30);
}

export function createDemo(canvas, onFrame, variant = 'bodyweight') {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  let motionTime = null, nextSampleAt, frame;
  function tick(now) {
    const t = motionTime === null ? 0 : now - motionTime;
    const depth = t < 430 ? 0 : t < 2830 ? smooth((t - 430) / 2400)
      : t < 3130 ? 1 : t < 4530 ? 1 - smooth((t - 3130) / 1400) : 0;
    if (t > 5650) motionTime = null;
    const landmarks = demoLandmarks(depth, variant);
    paintDemo(canvas, landmarks, variant);

    nextSampleAt ??= now;
    if (now + 4 >= nextSampleAt) {
      nextSampleAt = nextPoseSampleTime(nextSampleAt, now);
      onFrame({ landmarks, width: WIDTH, height: HEIGHT, timestampMs: now, video: canvas });
    }
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
  return {
    perform() { motionTime = performance.now(); },
    setVariant(nextVariant) {
      variant = nextVariant;
      motionTime = null;
    },
    stop() { cancelAnimationFrame(frame); },
  };
}

const LEG_CONNECTIONS = [[11, 23], [23, 25], [25, 27], [27, 29], [27, 31], [29, 31]];
const ARM_CONNECTIONS = [[11, 13], [13, 15], ...LEG_CONNECTIONS];
const LEG_JOINTS = [11, 23, 25, 27];
const ARM_JOINTS = [11, 13, 15, 23, 25, 27];

export function drawPose(canvas, { landmarks, width: sourceWidth, height, crop, exercise }, side, capturing = false, uncertain = false) {
  const width = crop?.width ?? sourceWidth;
  const left = crop?.left ?? 0;
  const x = (point) => point.x * sourceWidth - left;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (!landmarks?.length || !side) return;
  const offset = side === 'right' ? 1 : 0;
  const get = (id) => landmarks[id + offset];
  const showArms = exercise === 'push-up';
  function visible(point, index) {
    let minimum = 0.55;
    if (capturing) {
      if (index === 11) minimum = 0.30;
      else if (index >= 23 && index <= 27) minimum = uncertain ? 0.25 : 0.35;
      else if (showArms || exercise === 'heel-raise') minimum = 0.38;
    }
    return point && [point.visibility ?? 1, point.presence ?? 1].every((value) => Number.isFinite(value) && value >= minimum)
      && x(point) > 0 && x(point) < width && point.y > 0 && point.y < 1;
  }
  const size = Math.max(4.5, Math.min(width, height) / 86);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const [a, b] of showArms ? ARM_CONNECTIONS : LEG_CONNECTIONS) {
    const p = get(a), q = get(b);
    if (!visible(p, a) || !visible(q, b)) continue;
    ctx.moveTo(x(p), p.y * height);
    ctx.lineTo(x(q), q.y * height);
  }
  ctx.lineWidth = size * 1.8;
  ctx.strokeStyle = '#081822';
  ctx.stroke();
  ctx.lineWidth = size;
  ctx.strokeStyle = uncertain ? '#9ccec6' : '#69f6d7';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#10364c';
  ctx.lineWidth = Math.max(2, size * .45);
  for (const i of showArms ? ARM_JOINTS : LEG_JOINTS) {
    const p = get(i);
    if (!visible(p, i)) continue;
    ctx.beginPath();
    ctx.arc(x(p), p.y * height, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

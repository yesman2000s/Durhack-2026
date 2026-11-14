// Generated joints exercise the same capture pipeline as a webcam, with no video file.
const WIDTH = 960, HEIGHT = 540;
const rads = (deg) => deg * Math.PI / 180;
const vector = (joint, length, deg) => ({
  x: joint.x + length * Math.sin(rads(deg)), y: joint.y - length * Math.cos(rads(deg)),
});
const smooth = (v) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(v, 1)))) / 2;

export function demoLandmarks(depth) {
  const ankle = { x: 495, y: 423 };
  const knee = vector(ankle, 91, 2 + depth * 23);
  const hip = vector(knee, 102, 1 - depth * 86);
  const shoulder = vector(hip, 114, 2 + depth * 36);
  const head = vector(shoulder, 47, 4 + depth * 19);
  const elbow = { x: shoulder.x + 43 + 19 * depth, y: shoulder.y + 33 - 11 * depth };
  const wrist = { x: elbow.x + 37, y: elbow.y - 8 };
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

function paintDemo(canvas, points) {
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
  const [headX, headY] = at(7);
  ctx.fillStyle = '#b9d9c5'; ctx.beginPath(); ctx.ellipse(headX + 5, headY - 3, 19, 23, -0.08, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#a3bcba'; ctx.font = '700 15px system-ui'; ctx.fillText('SIMULATED MOVEMENT', 33, HEIGHT - 30);
}

export function createDemo(canvas, onFrame) {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  let motionTime = null, lastSample = -Infinity, frame;
  function tick(now) {
    if (now - lastSample >= 55) {
      lastSample = now;
      const t = motionTime === null ? 0 : now - motionTime;
      const depth = t < 430 ? 0 : t < 2830 ? smooth((t - 430) / 2400)
        : t < 3130 ? 1 : t < 4530 ? 1 - smooth((t - 3130) / 1400) : 0;
      if (t > 5650) motionTime = null;
      const landmarks = demoLandmarks(depth);
      paintDemo(canvas, landmarks);
      onFrame({ landmarks, width: WIDTH, height: HEIGHT, timestampMs: now, video: canvas });
    }
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
  return {
    perform() { motionTime = performance.now(); },
    stop() { cancelAnimationFrame(frame); },
  };
}

export function drawPose(canvas, { landmarks, width: sourceWidth, height, crop }, side, capturing = false) {
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
  function visible(point, index) {
    const minimum = capturing && index < 29 ? (index === 11 ? 0.30 : 0.35) : 0.55;
    return point && (point.visibility ?? 1) >= minimum && x(point) > 0 && x(point) < width && point.y > 0 && point.y < 1;
  }
  ctx.strokeStyle = '#b8f6ce'; ctx.lineWidth = Math.max(2, width / 320); ctx.lineCap = 'round';
  ctx.shadowColor = '#0a1717'; ctx.shadowBlur = 5;
  for (const [a, b] of [[11, 23], [23, 25], [25, 27], [27, 29], [27, 31]]) {
    const p = get(a), q = get(b);
    if (!visible(p, a) || !visible(q, b)) continue;
    ctx.beginPath(); ctx.moveTo(x(p), p.y * height); ctx.lineTo(x(q), q.y * height); ctx.stroke();
  }
  for (const i of [11, 23, 25, 27]) {
    const p = get(i);
    if (!visible(p, i)) continue;
    ctx.fillStyle = '#112e27'; ctx.beginPath(); ctx.arc(x(p), p.y * height, Math.max(4, width / 150), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

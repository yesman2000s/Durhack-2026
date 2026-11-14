import { nextPoseSampleTime } from './pose-cadence.js';

const WIDTH = 960;
const HEIGHT = 540;
const FLOOR = 440;
export const EXAMPLE_MOVEMENT_MS = 4050;

export function exampleProgress(elapsedMs) {
  if (elapsedMs <= 0 || elapsedMs >= EXAMPLE_MOVEMENT_MS) return 0;
  if (elapsedMs < 2100) return (1 - Math.cos(Math.PI * elapsedMs / 2100)) / 2;
  if (elapsedMs < 2400) return 1;
  return (1 + Math.cos(Math.PI * (elapsedMs - 2400) / 1650)) / 2;
}

function translate(point, dx, dy) {
  return { x: point.x + dx, y: point.y + dy };
}

function fromAngle(origin, length, degrees) {
  const angle = degrees * Math.PI / 180;
  return translate(origin, length * Math.sin(angle), -length * Math.cos(angle));
}

function armElbow(shoulder, wrist, upperArm, forearm) {
  // Choose the intersection that bends the elbow back toward the toes.
  const dx = wrist.x - shoulder.x;
  const dy = wrist.y - shoulder.y;
  const distance = Math.hypot(dx, dy);
  const projected = (upperArm ** 2 - forearm ** 2 + distance ** 2) / (2 * distance);
  const drop = Math.sqrt(Math.max(0, upperArm ** 2 - projected ** 2));
  return translate(shoulder, (dx * projected - dy * drop) / distance, (dy * projected + dx * drop) / distance);
}

function floorPushUp(progress) {
  const ankle = { x: 294, y: 414 };
  const heel = { x: 280, y: 408 };
  const toe = { x: 307, y: 432 };
  const wrist = { x: 583, y: 421 };
  const palm = { x: 605, y: 433 };
  const lean = 68 + 14 * progress;
  const knee = fromAngle(ankle, 94, lean);
  const hip = fromAngle(knee, 104, lean);
  const shoulder = fromAngle(hip, 114, lean);
  const elbow = armElbow(shoulder, wrist, 65, 60);
  const head = fromAngle(shoulder, 47, lean - 2);
  return { shoulder, elbow, wrist, palm, hip, knee, ankle, heel, toe, head };
}

function standingRaise(progress, heelRaise) {
  const rise = heelRaise ? progress : 0;
  const lift = heelRaise ? 0 : progress;
  const stanceAnkle = { x: 472 + 7 * rise, y: 423 - 29 * rise };
  const stanceKnee = fromAngle(stanceAnkle, 94, 1);
  const hip = fromAngle(stanceKnee, 104, -1);
  const shoulder = fromAngle(hip, 114, 4);
  const elbow = fromAngle(shoulder, 62, 181 + 20 * lift);
  const wrist = fromAngle(elbow, 56, 172 + 20 * lift);
  const otherElbow = fromAngle(shoulder, 62, 175 - 22 * lift);
  const otherWrist = fromAngle(otherElbow, 56, 173 - 49 * lift);
  const knee = fromAngle(hip, 104, 179 - 81 * lift);
  const ankle = fromAngle(knee, 94, 181 + 19 * lift);
  const heel = translate(ankle, -12, 13 - 4 * rise);
  const toe = heelRaise ? { x: 504, y: 436 } : translate(ankle, 32, 13 + 4 * lift);
  const far = {
    elbow: otherElbow, wrist: otherWrist,
    ...(heelRaise ? {} : {
      knee: stanceKnee,
      ankle: stanceAnkle,
      heel: translate(stanceAnkle, -12, 13),
      toe: translate(stanceAnkle, 32, 13),
    }),
  };
  return { shoulder, elbow, wrist, hip, knee, ankle, heel, toe, head: fromAngle(shoulder, 46, 4), far };
}

const JOINTS = [[11, 'shoulder'], [13, 'elbow'], [15, 'wrist'], [23, 'hip'], [25, 'knee'], [27, 'ankle'], [29, 'heel'], [31, 'toe']];

export function mobilityDemoLandmarks(progress, exercise) {
  const pose = exercise === 'push-up' ? floorPushUp(progress) : standingRaise(progress, exercise === 'heel-raise');
  const normalize = ({ x, y }, visibility = .99) => ({ x: x / WIDTH, y: y / HEIGHT, z: 0, visibility });
  const points = Array.from({ length: 33 }, () => normalize(pose.head, 0));
  points[0] = normalize(translate(pose.head, 17, -1));
  points[7] = normalize(translate(pose.head, -4, 2));
  points[8] = normalize(translate(pose.head, -10, 0), .72);
  for (const [index, key] of JOINTS) {
    points[index] = normalize(pose[key]);
    points[index + 1] = normalize(translate(pose.far?.[key] ?? pose[key], -8, -4), .78);
  }
  if (pose.palm) {
    points[19] = normalize(pose.palm);
    points[20] = normalize(translate(pose.palm, -8, -4), .78);
  }
  return points;
}

function paintEnvironment(ctx) {
  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  background.addColorStop(0, '#1b3030');
  background.addColorStop(1, '#111b1c');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = '#2b4344';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < WIDTH; x += 48) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, FLOOR);
  }
  for (let y = 0; y < FLOOR; y += 48) {
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#132324';
  ctx.fillRect(0, FLOOR, WIDTH, HEIGHT - FLOOR);
  ctx.fillStyle = '#365050';
  ctx.fillRect(0, FLOOR, WIDTH, 2);
}

function paintDemo(ctx, points, exercise) {
  paintEnvironment(ctx);
  const at = (index) => [points[index].x * WIDTH, points[index].y * HEIGHT];
  ctx.lineCap = 'round';
  for (const [offset, wardrobe] of [[1, ['#425858', '#3b5a59', '#648b80']], [0, ['#6d928c', '#557c7b', '#b9d9c5']]]) {
    const [pants, shirt, skin] = wardrobe;
    const strokes = [[23, 25, 35, pants], [25, 27, 27, pants], [29, 31, 15, skin], [11, 23, 59, shirt], [11, 13, 21, shirt], [13, 15, 17, skin]];
    if (exercise === 'push-up') strokes.push([15, 19, 13, skin]);
    for (const [from, to, size, color] of strokes) {
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(...at(from + offset));
      ctx.lineTo(...at(to + offset));
      ctx.stroke();
    }
  }
  const [headX, headY] = at(7);
  ctx.fillStyle = '#b9d9c5';
  ctx.beginPath();
  ctx.ellipse(headX + 5, headY - 3, 19, 23, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#a3bcba';
  ctx.font = '700 15px system-ui';
  ctx.fillText('SIMULATED MOVEMENT', 33, HEIGHT - 30);
}

export function createMobilityDemo(canvas, onFrame, exercise) {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });
  let motionStart = null;
  let nextSampleAt;
  let paintedProgress;
  let landmarks;
  let animationFrame = requestAnimationFrame(tick);

  function tick(now) {
    animationFrame = requestAnimationFrame(tick);
    const elapsed = motionStart === null ? 0 : now - motionStart;
    if (elapsed >= EXAMPLE_MOVEMENT_MS) motionStart = null;
    const progress = exampleProgress(elapsed);
    if (progress !== paintedProgress) {
      landmarks = mobilityDemoLandmarks(progress, exercise);
      paintDemo(ctx, landmarks, exercise);
      paintedProgress = progress;
    }

    nextSampleAt ??= now;
    if (now + 4 >= nextSampleAt) {
      nextSampleAt = nextPoseSampleTime(nextSampleAt, now);
      onFrame({ landmarks, width: WIDTH, height: HEIGHT, timestampMs: now, video: canvas });
    }
  }

  return {
    perform() { motionStart = performance.now() + 350; },
    stop() { cancelAnimationFrame(animationFrame); },
  };
}

import { demoLandmarks } from './demo.js';
import { EXAMPLE_MOVEMENT_MS, exampleProgress, mobilityDemoLandmarks } from './mobility-demo.js';
import { drawHumanGuide } from './human-guide.js';

const REFERENCE_WIDTH = 960;
const REFERENCE_HEIGHT = 540;
const GUIDE_DURATION_MS = EXAMPLE_MOVEMENT_MS + 600;
const GUIDE_RANGE = .60;
// Match the phase boundaries in exampleProgress for captured-rep replay.
export const guidePlaybackTimes = Object.freeze({ lowerEndMs: 2100, bottomEndMs: 2400, returnEndMs: EXAMPLE_MOVEMENT_MS });
const SUPPORT_JOINTS = [27, 29, 31];

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function pixelPoint(landmarks, index, width, height, left = 0, visibility = .35) {
  const point = landmarks?.[index];
  if (point && (point.visibility ?? 1) >= visibility && (point.presence ?? 1) >= visibility &&
      Number.isFinite(point.x) && Number.isFinite(point.y)) {
    return { x: point.x * width - left, y: point.y * height };
  }
  return null;
}

function legLength(hip, knee, ankle) {
  return distance(hip, knee) + distance(knee, ankle);
}

function supportPoints(frame, sideOffset, visibility = .50) {
  return SUPPORT_JOINTS.map((index) =>
    pixelPoint(frame.landmarks, index + sideOffset, frame.width, frame.height, 0, visibility));
}

function supportDisplacement(frame, alignment) {
  const { support, sideOffset, singleAnkle, standingLength } = alignment;
  if (singleAnkle) {
    const ankle = supportPoints(frame, sideOffset, .65)[0];
    return ankle && ankle.x - support[0].x;
  }

  const current = supportPoints(frame, sideOffset);
  const offsets = support.flatMap((initial, index) =>
    initial && current[index] ? [current[index].x - initial.x] : []).sort((a, b) => a - b);
  if (offsets.length === 3) return offsets[1];
  if (offsets.length === 2 && offsets[1] - offsets[0] <= standingLength * .10) {
    return (offsets[0] + offsets[1]) / 2;
  }
  return null;
}

function guideTransform(frame, side, exercise, getReference, range) {
  if (!frame || (side !== 'left' && side !== 'right')) return null;
  const { width: sourceWidth, height, crop, landmarks } = frame;
  const width = crop?.width ?? sourceWidth;
  if (!(sourceWidth > 0 && width > 0 && height > 0)) return null;
  const sideOffset = side === 'right' ? 1 : 0;
  const left = crop?.left ?? 0;
  const at = (index, visibility = .35) => {
    const point = pixelPoint(landmarks, index, sourceWidth, height, left, visibility);
    return point && point.x >= -left && point.x <= sourceWidth - left && point.y >= 0 && point.y <= height
      ? point : null;
  };
  const joint = (i, visibility) => at(i + sideOffset, visibility);
  const hip = joint(23);
  const knee = joint(25);
  const ankle = joint(27);
  if (!hip || !knee || !ankle) return null;
  const standingLength = legLength(hip, knee, ankle);
  if (standingLength < height * .07) return null;

  const onFoot = (point, footAnkle) => point && footAnkle && distance(point, footAnkle) <= standingLength * .38
    ? point : null;
  const toe = onFoot(joint(31, .48), ankle);
  const pushUp = exercise === 'push-up';
  const wrist = pushUp ? joint(15) : null;
  const anchor = toe && (exercise === 'heel-raise' || pushUp) ? toe : ankle;
  const floorDirection = wrist ? wrist.x - anchor.x : 0;
  if (pushUp && Math.abs(floorDirection) < standingLength * .7) return null;
  const nose = at(0, .45);
  const ear = joint(7, .45) ?? at(8 - sideOffset, .45);
  const shoulder = joint(11, .40) ?? at(12 - sideOffset, .45);
  const heel = onFoot(joint(29, .45), ankle);
  const farAnkle = at(28 - sideOffset, .45);
  const farToe = onFoot(at(32 - sideOffset, .45), farAnkle);
  const farHeel = onFoot(at(30 - sideOffset, .45), farAnkle);
  const footDirection = toe && heel ? toe.x - heel.x : 0;
  const farFootDirection = farToe && farHeel ? farToe.x - farHeel.x : 0;
  const orientation = [
    floorDirection, footDirection,
    nose && ear ? nose.x - ear.x : 0,
    nose && shoulder ? nose.x - shoulder.x : 0,
    farFootDirection,
    toe ? toe.x - ankle.x : 0,
    heel ? ankle.x - heel.x : 0,
  ].find((difference) => Math.abs(difference) >= standingLength * .045);
  const direction = Math.sign(orientation ?? 0);
  if (!direction) return null;

  const standingModel = getReference(0);
  const referencePoint = (i) => pixelPoint(standingModel, i, REFERENCE_WIDTH, REFERENCE_HEIGHT);
  const ankleModel = referencePoint(27);
  const naturalScale = standingLength / legLength(referencePoint(23), referencePoint(25), ankleModel);
  const anchorModel = anchor === toe ? referencePoint(31) : ankleModel;
  const anchorScale = pushUp ? Math.abs(floorDirection) / Math.abs(referencePoint(15).x - anchorModel.x) : naturalScale;
  const desiredShift = pushUp ? 0 : -direction * standingLength * .18;
  const modelPoints = [0, range / 4, range / 2, range * .75, range].flatMap((progress) => getReference(progress)
    .filter((point) => point.visibility >= .35)
    .map((point) => ({
      x: (point.x * REFERENCE_WIDTH - anchorModel.x) * direction,
      y: point.y * REFERENCE_HEIGHT - anchorModel.y,
    })));
  // Fit the body contour as well as the joints, including the head and plates.
  const bodyMargin = 32;
  const minX = Math.min(...modelPoints.map((point) => point.x)) - bodyMargin;
  const maxX = Math.max(...modelPoints.map((point) => point.x)) + bodyMargin;
  const minY = Math.min(...modelPoints.map((point) => point.y)) - bodyMargin;
  const maxY = Math.max(...modelPoints.map((point) => point.y)) + bodyMargin;
  const padding = Math.min(Math.max(15, standingLength * .055), width / 4, height / 4);
  const scale = Math.min(clamp(anchorScale, naturalScale * .8, naturalScale * 1.2),
    (width - 2 * padding) / (maxX - minX), (height - 2 * padding) / (maxY - minY));
  const minimumX = padding - minX * scale;
  const maximumX = width - padding - maxX * scale;
  const originX = clamp(anchor.x + desiredShift, minimumX, maximumX);
  const originY = clamp(anchor.y, padding - minY * scale, height - padding - maxY * scale);
  const support = exercise === 'squat' ? supportPoints(frame, sideOffset) : [];
  const supportCount = support.filter(Boolean).length;
  const singleAnkle = supportCount === 1 && Boolean(support[0]);
  const alignment = supportCount >= 2 || singleAnkle ? {
    support, singleAnkle, side, sideOffset, sourceWidth, left, standingLength,
    minimum: minimumX - originX,
    maximum: maximumX - originX,
  } : null;

  return {
    width,
    height,
    alignment,
    offset: 0,
    point(landmark) {
      return {
        x: originX + this.offset + (landmark.x * REFERENCE_WIDTH - anchorModel.x) * scale * direction,
        y: originY + (landmark.y * REFERENCE_HEIGHT - anchorModel.y) * scale,
      };
    },
  };
}

function drawGuide(ctx, transform, pose, exercise, variant) {
  const { width, height } = transform;
  ctx.clearRect(0, 0, width, height);
  drawHumanGuide(ctx, pose.map((landmark) => transform.point(landmark)), exercise, variant);
}

export function createTrainingOverlay(canvas) {
  const ctx = canvas.getContext('2d');
  let animationFrame;
  let transform;
  let lastAlignmentAt;
  let paint;
  let holdingFinalPose = false;

  function clear() {
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
    transform = undefined;
    lastAlignmentAt = undefined;
    paint = undefined;
    holdingFinalPose = false;
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function renderAt(elapsedMs) {
    if (!paint || !Number.isFinite(elapsedMs)) return false;
    paint(elapsedMs);
    return true;
  }

  function start(frame, side, exercise, variant = 'bodyweight', onEnd, { manual = false, keepAfterEnd = false } = {}) {
    clear();
    if (!ctx) return false;
    const getReference = exercise === 'squat'
      ? (progress) => demoLandmarks(progress, variant)
      : (progress) => mobilityDemoLandmarks(progress, exercise);
    const range = exercise === 'push-up' ? .72 : GUIDE_RANGE;
    transform = guideTransform(frame, side, exercise, getReference, range);
    if (!transform) return false;
    if (canvas.width !== transform.width) canvas.width = transform.width;
    if (canvas.height !== transform.height) canvas.height = transform.height;
    const startTime = performance.now();
    lastAlignmentAt = manual ? (Number.isFinite(frame.timestampMs) ? frame.timestampMs : undefined) : startTime;
    let paintedProgress;
    let paintedOffset;
    paint = (elapsed) => {
      const progress = exampleProgress(elapsed);
      if (progress !== paintedProgress || transform.offset !== paintedOffset) {
        drawGuide(ctx, transform, getReference(progress * range), exercise, variant);
        paintedProgress = progress;
        paintedOffset = transform.offset;
      }
    };
    if (manual) {
      renderAt(0);
      return true;
    }
    function tick(now) {
      const elapsed = now - startTime;
      if (elapsed >= GUIDE_DURATION_MS) {
        if (keepAfterEnd) {
          renderAt(GUIDE_DURATION_MS);
          holdingFinalPose = true;
          animationFrame = undefined;
        } else {
          clear();
          onEnd?.();
        }
        return;
      }
      renderAt(elapsed);
      animationFrame = requestAnimationFrame(tick);
    }
    animationFrame = requestAnimationFrame(tick);
    return true;
  }

  function update(frame, side) {
    const alignment = transform?.alignment;
    if (!alignment || !frame || side !== alignment.side) return;
    const { width, height, crop, timestampMs } = frame;
    if (width !== alignment.sourceWidth || height !== transform.height ||
        (crop?.left ?? 0) !== alignment.left || (crop?.width ?? width) !== transform.width ||
        !Number.isFinite(timestampMs) || (lastAlignmentAt !== undefined && timestampMs <= lastAlignmentAt)) return;

    const displacement = supportDisplacement(frame, alignment);
    if (displacement === null) return;
    const elapsed = Math.min(timestampMs - (lastAlignmentAt ?? timestampMs), 120);
    lastAlignmentAt = timestampMs;
    const limit = alignment.standingLength * .24;
    const minimum = Math.max(-limit, alignment.minimum);
    const maximum = Math.min(limit, alignment.maximum);
    const desired = Math.abs(displacement) < alignment.standingLength * .015 ? 0 : displacement;
    const target = Math.max(minimum, Math.min(maximum, desired));

    // Match horizontal stance changes while the model keeps its standing scale and floor.
    transform.offset += (target - transform.offset) * (1 - Math.exp(-elapsed / 180));
    if (holdingFinalPose) renderAt(GUIDE_DURATION_MS);
  }

  return { start, update, renderAt, clear };
}

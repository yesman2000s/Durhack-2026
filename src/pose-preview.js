import { drawPose } from './demo.js';

// The display runs at the screen refresh rate. Capture and measurements use observed samples only.
export function createPosePreview(canvas) {
  let frame;
  let side;
  let capturing;
  let uncertain;
  let displayed;
  let drawId;
  let lastDraw;
  let lastPoseAt = 0;

  function draw(now) {
    drawId = undefined;
    if (!frame) return;
    if (now - lastPoseAt > 240) {
      drawPose(canvas, { ...frame, landmarks: null }, side);
      displayed = null;
      return;
    }
    const dt = Math.min(50, Math.max(0, now - lastDraw));
    lastDraw = now;
    displayed = frame.landmarks.map((target, index) => {
      const previous = displayed?.[index];
      if (!target || !previous) return target;
      const distance = Math.hypot((target.x - previous.x) * frame.width, (target.y - previous.y) * frame.height) / frame.height;
      const responseMs = 80 - 62 * Math.min(1, distance / 0.045);
      const blend = 1 - Math.exp(-dt / responseMs);
      return { ...target, x: previous.x + (target.x - previous.x) * blend, y: previous.y + (target.y - previous.y) * blend };
    });
    drawPose(canvas, { ...frame, landmarks: displayed }, side, capturing, uncertain);
    drawId = requestAnimationFrame(draw);
  }

  return {
    update(next, nextSide, nextCapturing, nextUncertain) {
      if (!next.landmarks?.length || !nextSide) return;
      if (!frame || nextSide !== side || frame.width !== next.width || frame.height !== next.height) displayed = null;
      frame = next;
      side = nextSide;
      capturing = nextCapturing;
      uncertain = nextUncertain;
      lastPoseAt = performance.now();
      if (drawId === undefined) {
        lastDraw = lastPoseAt;
        drawId = requestAnimationFrame(draw);
      }
    },
    clear() {
      if (drawId !== undefined) cancelAnimationFrame(drawId);
      drawId = undefined;
      frame = null;
      displayed = null;
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

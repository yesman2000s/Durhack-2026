import { drawPose } from './demo.js';
import { poseAtTime, traceLandmarks } from './motion-trace.js';
import { guidePlaybackTimes } from './training-overlay.js';

function mapTime(time, from, to, start, end) {
  const fraction = to > from ? (time - from) / (to - from) : 1;
  return start + (end - start) * Math.max(0, Math.min(1, fraction));
}

export function recordedGuideTime(time, { movement, bottom, rise, returned }) {
  const { lowerEndMs, bottomEndMs, returnEndMs } = guidePlaybackTimes;
  if (time <= movement) return 0;
  if (time < bottom) return mapTime(time, movement, bottom, 0, lowerEndMs);
  if (time < rise) return mapTime(time, bottom, rise, lowerEndMs, bottomEndMs);
  return mapTime(time, rise, returned, bottomEndMs, returnEndMs);
}

export function createRecordedOverlay(video, poseCanvas, guide, review, onGuideVisible) {
  const { evidence, anchor, timing } = review;
  const { camera, exercise, variant, trackingSide: side, motionTrace } = evidence;
  const frames = motionTrace?.frames;
  let animation;
  let guideEnabled = false;
  let guideReady = false;
  let guideAttempted = false;
  let guideVisible = false;
  let lastTime;
  let playingRep = false;

  function setVisibility(visible) {
    if (guideVisible === visible) return;
    guideVisible = visible;
    onGuideVisible(visible);
  }

  function startGuide() {
    guideAttempted = true;
    guideReady = Boolean(anchor?.side &&
      guide.start(anchor.frame, anchor.side, exercise, variant, undefined, { manual: true }));
  }

  function paint() {
    const time = video.currentTime * 1000;
    const inRep = time >= timing.start - 1 && time <= timing.end + 1;
    const joints = inRep && frames?.length ? poseAtTime(frames, time - timing.start) : null;
    const frame = { ...camera, exercise, landmarks: traceLandmarks(joints, side), timestampMs: time };
    drawPose(poseCanvas, frame, side, true);

    if (!inRep || (lastTime !== undefined && time < lastTime)) {
      if (guideReady) guide.clear();
      guideReady = false;
      guideAttempted = false;
    }
    if (inRep && guideEnabled) {
      if (!guideAttempted) startGuide();
      if (guideReady) {
        guide.update(frame, side);
        guide.renderAt(recordedGuideTime(time, timing));
      }
    }
    setVisibility(inRep && guideReady);
    lastTime = time;
  }

  function tick() {
    animation = undefined;
    if (playingRep && video.currentTime * 1000 >= timing.end) {
      playingRep = false;
      video.pause();
      video.currentTime = timing.end / 1000;
    }
    paint();
    if (!video.paused && animation === undefined) animation = requestAnimationFrame(tick);
  }

  function play() {
    if (animation === undefined) animation = requestAnimationFrame(tick);
  }

  function pause() {
    if (animation !== undefined) cancelAnimationFrame(animation);
    animation = undefined;
    if (!video.seeking) paint();
  }

  video.addEventListener('play', play);
  video.addEventListener('pause', pause);
  video.addEventListener('seeked', paint);
  if (!video.paused) play();
  paint();

  return {
    setGuide(enabled) {
      guideEnabled = enabled;
      if (!enabled) {
        guide.clear();
        guideReady = false;
        guideAttempted = false;
      }
      paint();
    },
    async playRep() {
      playingRep = true;
      video.currentTime = Math.max(timing.start, timing.movement - 250) / 1000;
      try {
        await video.play();
      } catch {
        playingRep = false;
      }
    },
    dispose() {
      if (animation !== undefined) cancelAnimationFrame(animation);
      video.removeEventListener('play', play);
      video.removeEventListener('pause', pause);
      video.removeEventListener('seeked', paint);
      guide.clear();
      drawPose(poseCanvas, camera, side);
      setVisibility(false);
    },
  };
}

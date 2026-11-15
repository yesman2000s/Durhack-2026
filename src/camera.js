import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import simdLoader from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url';
import simdBinary from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url';
import fallbackLoader from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js?url';
import fallbackBinary from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm?url';
import { centerCameraCrop, poseCameraCrop, sourceLandmarks } from './camera-crop.js';
import { nextPoseSampleTime, POSE_SAMPLE_INTERVAL_MS } from './pose-cadence.js';
import { copyCameraFrame } from './camera-frame.js';

const stalledVideoMs = 200;
const modelAssetPath = `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`;

export async function createLandmarker() {
  const simd = await FilesetResolver.isSimdSupported();
  return PoseLandmarker.createFromOptions({
    wasmLoaderPath: simd ? simdLoader : fallbackLoader,
    wasmBinaryPath: simd ? simdBinary : fallbackBinary,
  }, {
    baseOptions: { modelAssetPath, delegate: 'CPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.42,
    minTrackingConfidence: 0.5,
  });
}

function describeCameraError(error) {
  const descriptions = {
    NotAllowedError: 'Allow camera access in your browser and try again.',
    NotFoundError: 'No camera was found. Connect a camera and try again.',
    NotReadableError: 'The camera could not be opened. Close other apps using it and try again.',
    OverconstrainedError: 'The camera could not provide a usable video stream.',
    SecurityError: 'Camera access is disabled for this page. Open the app on localhost or over HTTPS.',
  };
  return new Error(descriptions[error.name] ?? 'The camera could not start. Check the connection and try again.', {
    cause: error,
  });
}

export function createCamera(video, { onFrame, onError, initialExercise = 'squat' }) {
  let active = null;
  let exercise = initialExercise;
  const frameCanvas = document.createElement('canvas');
  const cropCanvas = document.createElement('canvas');
  const cropContext = cropCanvas.getContext('2d', { alpha: false });

  function release(session) {
    if (session.frameId !== null) {
      if (session.usesVideoFrames) video.cancelVideoFrameCallback(session.frameId);
      else cancelAnimationFrame(session.frameId);
    }
    window.clearInterval(session.watchdogId);
    session.stream?.getTracks().forEach((track) => track.stop());
    if (session.stream && video.srcObject === session.stream) {
      video.pause();
      video.srcObject = null;
    }
    session.landmarker?.close();
    session.landmarker = null;
  }

  function stop() {
    const session = active;
    active = null;
    if (session) release(session);
  }

  function fail(session, error) {
    if (session !== active) return;
    stop();
    onError?.(error);
  }

  function schedule(session) {
    session.frameId = session.usesVideoFrames
      ? video.requestVideoFrameCallback((now, frame) => sample(session, now, frame.mediaTime))
      : requestAnimationFrame((now) => sample(session, now, video.currentTime));
  }

  function sample(session, timestampMs, mediaTime) {
    if (session !== active) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    const hasNewFrame = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && width > 0 && height > 0 && mediaTime !== session.lastVideoTime;
    if (hasNewFrame) {
      session.lastVideoTime = mediaTime;
      session.lastVideoAt = timestampMs;
      // Keep a fixed cadence so 30 fps input can alternate two- and three-frame strides.
      session.nextSampleAt ??= timestampMs;
      if (timestampMs + 4 >= session.nextSampleAt) {
        try {
          const capturedFrame = copyCameraFrame(video, width, height, frameCanvas);
          if (!capturedFrame) throw new Error('The camera frame could not be read.');
          const wideView = exercise === 'push-up';
          const crop = wideView ? { left: 0, width } : centerCameraCrop(width, height);
          const modelCrop = !wideView && cropContext ? poseCameraCrop(width, height) : { left: 0, width };
          let inferenceSource = capturedFrame;
          if (modelCrop.width < width) {
            if (cropCanvas.width !== modelCrop.width) cropCanvas.width = modelCrop.width;
            if (cropCanvas.height !== height) cropCanvas.height = height;
            cropContext.drawImage(capturedFrame, modelCrop.left, 0, modelCrop.width, height, 0, 0, modelCrop.width, height);
            inferenceSource = cropCanvas;
          }
          const result = session.landmarker.detectForVideo(inferenceSource, timestampMs);
          session.nextSampleAt = nextPoseSampleTime(session.nextSampleAt, timestampMs);
          session.lastSampleAt = timestampMs;
          session.crop = crop;
          onFrame({
            landmarks: sourceLandmarks(result.landmarks[0] ?? null, width, modelCrop),
            timestampMs,
            width,
            height,
            crop,
            video: capturedFrame,
          });
        } catch (error) {
          fail(session, new Error('Pose tracking stopped. Restart the camera to try again.', { cause: error }));
          return;
        }
      }
    }
    if (session === active) schedule(session);
  }

  function reportStall(session) {
    if (session !== active) return;
    const now = performance.now();
    if (now - session.lastVideoAt < stalledVideoMs || now - session.lastSampleAt < POSE_SAMPLE_INTERVAL_MS) return;
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) return;
    session.lastSampleAt = now;
    session.nextSampleAt = null;
    onFrame({ landmarks: null, timestampMs: now, width: video.videoWidth, height: video.videoHeight, crop: session.crop, video });
  }

  async function start() {
    if (active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access is unavailable here. Open the app on localhost or over HTTPS.');
    }

    const session = {
      stream: null,
      landmarker: null,
      frameId: null,
      watchdogId: null,
      usesVideoFrames: typeof video.requestVideoFrameCallback === 'function'
        && typeof video.cancelVideoFrameCallback === 'function',
      lastSampleAt: -Infinity,
      nextSampleAt: null,
      lastVideoTime: -1,
      lastVideoAt: performance.now(),
    };
    active = session;

    try {
      session.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      if (session !== active) {
        release(session);
        return;
      }
      for (const track of session.stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          fail(session, new Error('The camera was disconnected. Reconnect it and try again.'));
        }, { once: true });
      }
      video.muted = true;
      video.playsInline = true;
      video.srcObject = session.stream;
      await video.play();
    } catch (error) {
      if (session !== active) return;
      stop();
      throw describeCameraError(error);
    }
    if (session !== active) return;

    try {
      session.landmarker = await createLandmarker();
    } catch (error) {
      if (session !== active) return;
      stop();
      throw new Error('The pose model could not load. Refresh the app and try again.', { cause: error });
    }
    if (session !== active) {
      release(session);
      return;
    }

    session.lastVideoAt = performance.now();
    session.watchdogId = window.setInterval(() => reportStall(session), 65);
    schedule(session);
  }

  return { start, stop, setExercise(next) { exercise = next; } };
}

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import simdLoader from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url';
import simdBinary from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url';
import fallbackLoader from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js?url';
import fallbackBinary from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm?url';

const frameIntervalMs = 1000 / 15;
const stalledVideoMs = 250;
const modelAssetPath = `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`;

async function createLandmarker() {
  const simd = await FilesetResolver.isSimdSupported();
  return PoseLandmarker.createFromOptions({
    wasmLoaderPath: simd ? simdLoader : fallbackLoader,
    wasmBinaryPath: simd ? simdBinary : fallbackBinary,
  }, {
    baseOptions: { modelAssetPath, delegate: 'CPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
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

export function createCamera(video, { onFrame, onError }) {
  let active = null;

  function release(session) {
    cancelAnimationFrame(session.frameId);
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

  function sample(session, timestampMs) {
    if (session !== active) return;
    if (timestampMs - session.lastSampleAt >= frameIntervalMs) {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const hasNewFrame = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && width > 0 && height > 0 && video.currentTime !== session.lastVideoTime;

      try {
        let result;
        if (hasNewFrame) {
          session.lastVideoTime = video.currentTime;
          session.lastVideoAt = timestampMs;
          result = session.landmarker.detectForVideo(video, timestampMs);
        }
        if (result || timestampMs - session.lastVideoAt >= stalledVideoMs) {
          session.lastSampleAt = timestampMs;
          onFrame({
            landmarks: result?.landmarks[0] ?? null,
            worldLandmarks: result?.worldLandmarks[0] ?? null,
            timestampMs,
            width,
            height,
            video,
          });
        }
      } catch (error) {
        fail(session, new Error('Pose tracking stopped. Restart the camera to try again.', { cause: error }));
        return;
      }
    }

    if (session === active) {
      session.frameId = requestAnimationFrame((now) => sample(session, now));
    }
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
      lastSampleAt: -Infinity,
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

    session.frameId = requestAnimationFrame((now) => sample(session, now));
  }

  return { start, stop };
}

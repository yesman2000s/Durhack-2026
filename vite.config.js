import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { formScoringRoute } from './server/form-scoring.js';
import { feedbackSpeechRoute } from './server/feedback-speech.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['GEMINI_', 'ELEVENLABS_']);
  const scoreForm = formScoringRoute({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || undefined,
  });
  const speakFeedback = feedbackSpeechRoute({
    apiKey: env.ELEVENLABS_API_KEY,
    voiceId: env.ELEVENLABS_VOICE_ID || undefined,
  });
  const mountFeedbackRoutes = (server) => {
    server.middlewares.use(scoreForm);
    server.middlewares.use(speakFeedback);
  };
  return {
    plugins: [{
      name: 'form-feedback',
      configureServer: mountFeedbackRoutes,
      configurePreviewServer: mountFeedbackRoutes,
    }],
    optimizeDeps: {
      include: ['@mediapipe/tasks-vision'],
    },
    build: {
      rollupOptions: {
        input: {
          camera: fileURLToPath(new URL('./index.html', import.meta.url)),
          music: fileURLToPath(new URL('./music.html', import.meta.url)),
        },
      },
    },
  };
});

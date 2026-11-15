import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { formScoringRoute } from './server/form-scoring.js';
import { feedbackSpeechRoute } from './server/feedback-speech.js';
import { createAccountService } from './server/accounts.js';
import { createMongoWorkouts } from './server/mongo-workouts.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['GEMINI_', 'ELEVENLABS_', 'MONGODB_']);
  const speakFeedback = feedbackSpeechRoute({
    apiKey: env.ELEVENLABS_API_KEY,
    voiceId: env.ELEVENLABS_VOICE_ID || undefined,
  });
  const mountFeedbackRoutes = (server) => {
    const mongoWorkouts = env.MONGODB_URI ? createMongoWorkouts(env.MONGODB_URI, env.MONGODB_DATABASE || undefined) : undefined;
    const accounts = createAccountService({ mongoWorkouts });
    // Database files live beside the source tree and must never be served by
    // Vite's static or /@fs handlers, in either dev or preview mode.
    server.middlewares.use((req, res, next) => {
      let path;
      try { path = decodeURIComponent(req.url?.split('?')[0] ?? '').replaceAll('\\', '/'); }
      catch { res.statusCode = 400; res.end(); return; }
      if (path.split('/').some((part) => part.toLowerCase().replace(/[. ]+$/, '') === '.data')) { res.statusCode = 403; res.end(); return; }
      next();
    });
    server.middlewares.use(accounts.middleware);
    server.middlewares.use(formScoringRoute({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || undefined,
      scoreRep: accounts.scoreRep,
    }));
    server.middlewares.use(speakFeedback);
    server.httpServer?.once('close', () => {
      accounts.store.close();
      void mongoWorkouts?.close();
    });
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
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          camera: fileURLToPath(new URL('./camera.html', import.meta.url)),
        },
      },
    },
  };
});

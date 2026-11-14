import { defineConfig, loadEnv } from 'vite';
import { formScoringRoute } from './server/form-scoring.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'GEMINI_');
  const scoreForm = formScoringRoute({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || undefined,
  });
  return {
    plugins: [{
      name: 'form-scoring',
      configureServer(server) { server.middlewares.use(scoreForm); },
      configurePreviewServer(server) { server.middlewares.use(scoreForm); },
    }],
    optimizeDeps: {
      include: ['@mediapipe/tasks-vision'],
    },
  };
});

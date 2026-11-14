import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
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
});

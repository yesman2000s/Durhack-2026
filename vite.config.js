import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        camera: 'camera.html',
      },
    },
  },
  optimizeDeps: {
    include: ['@mediapipe/tasks-vision'],
  },
});

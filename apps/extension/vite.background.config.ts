import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    target: 'chrome120',
    emptyOutDir: false,
    lib: { entry: 'src/background/index.ts', formats: ['es'], fileName: () => 'background.js' },
  },
});

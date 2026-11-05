import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    target: 'chrome120', emptyOutDir: false,
    lib: { entry: 'src/content/index.ts', name: 'ClickFlowContent', formats: ['iife'], fileName: () => 'content.js' },
  },
});

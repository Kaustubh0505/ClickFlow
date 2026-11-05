import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/backend/**/*.test.ts', 'apps/extension/**/*.test.ts'],
    testTimeout: 10_000,
  },
});

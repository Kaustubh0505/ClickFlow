import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run preview -w @clickflow/extension',
    url: 'http://127.0.0.1:4173/fixtures/browser.html',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});

import { defineConfig } from '@playwright/test';

const isHuman = !!process.env.HUMAN_MODE;

export default defineConfig({
  testDir: './e2e',
  timeout: isHuman ? 120000 : 30000,
  retries: 0,
  workers: 1, // Run serially to avoid race conditions with shared server state
  use: {
    baseURL: 'http://localhost:8080',
    headless: !isHuman,
    screenshot: 'only-on-failure',
    launchOptions: {
      slowMo: isHuman ? 1200 : 0,
    },
    actionTimeout: isHuman ? 10000 : 5000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'cd server && go build -o babytrackd && ./babytrackd',
    url: 'http://localhost:8080/health',
    timeout: 15000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: '8080',
      ADMIN_USER: 'admin',
      ADMIN_PASS: 'testpass123',
    },
  },
});

import { defineConfig } from '@playwright/test';

const isHeaded = process.argv.includes('--headed');

export default defineConfig({
  testDir: './e2e',
  timeout: isHeaded ? 120000 : 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:8080',
    headless: !isHeaded,
    screenshot: 'only-on-failure',
    launchOptions: {
      slowMo: isHeaded ? 500 : 0,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'cd server && go run .',
    url: 'http://localhost:8080/health',
    timeout: 10000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: '8080',
      ADMIN_USER: 'admin',
      ADMIN_PASS: 'testpass123',
    },
  },
});

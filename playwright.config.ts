import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
    screenshot: 'only-on-failure',
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

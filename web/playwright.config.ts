import { defineConfig, devices } from '@playwright/test';
import { utf8BrowserEnv } from './scripts/e2e-browser-env';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    // #269：UTF-8 locale，非 ASCII 下載檔名才不會被改成 "download"
    launchOptions: { env: utf8BrowserEnv() },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

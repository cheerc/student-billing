import { defineConfig, devices } from '@playwright/test';
import { assertIsolatedE2eTarget } from './scripts/e2e-isolation';

const port = Number(process.env.PERF_PORT ?? 3400);
const databasePath = process.env.PERF_DATABASE_PATH;
assertIsolatedE2eTarget({ databasePath, port });
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/perf',
  testMatch: 'filter-api.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL },
  webServer: {
    command: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${port}`,
    url: `${baseURL}/api/v1/runs/current`,
    reuseExistingServer: false,
    env: { DATABASE_PATH: databasePath as string, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});

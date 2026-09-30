import { defineConfig, devices } from '@playwright/test';
import {
  assertIsolatedE2eTarget,
  DEFAULT_ISOLATED_E2E_PORT,
} from './scripts/e2e-isolation';

/**
 * 隔離 E2E 設定（specs/10 §4；issue #25）。與 playwright.config.ts 並存，不改它的 3000 行為。
 *
 * 一律經 `npm run test:e2e:isolated`（scripts/e2e-isolated.ts）執行：由它建立臨時目錄並傳入
 * E2E_DATABASE_PATH。直接以本設定執行時若缺少 E2E_DATABASE_PATH 會立即失敗，不會退回預設資料庫。
 *
 * - 另一埠（預設 3100）、baseURL 同步、reuseExistingServer:false（埠被占用即失敗，絕不重用）
 * - 直接呼叫 `next dev`，不經 `npm run dev`（package.json 的 dev script 寫死 -p 3000）
 * - DATABASE_PATH 指向臨時目錄下的獨立 sqlite；只綁 127.0.0.1（CLAUDE.md §5）
 */
const port = Number(process.env.E2E_PORT ?? DEFAULT_ISOLATED_E2E_PORT);
const databasePath = process.env.E2E_DATABASE_PATH;

assertIsolatedE2eTarget({ databasePath, port });

const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npx next dev -H 127.0.0.1 -p ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env: { DATABASE_PATH: databasePath as string },
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 180_000,
  },
});

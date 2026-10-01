import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertIsolatedE2eTarget, DEFAULT_ISOLATED_E2E_PORT } from './e2e-isolation';

/**
 * 隔離 E2E 執行器（specs/10 §4；issue #25）。用法（在 web/ 目錄）：
 *
 *   npm run test:e2e:isolated                      # 每個 spec 檔各用全新 server＋全新臨時 DB（預設，結果與檔案順序無關）
 *   npm run test:e2e:isolated -- --shared          # 全部 spec 共用同一個 server＋DB，依檔名順序（重現跨檔污染）
 *   npm run test:e2e:isolated -- --repeat 2        # 同一組同一個臨時 DB 連跑 N 輪（每輪新 server），重現「DB 狀態跨輪殘留」
 *   npm run test:e2e:isolated -- --port 3101       # 指定埠（不可為 3000）
 *   npm run test:e2e:isolated -- tests/e2e/imports.spec.ts   # 只跑指定 spec
 *   npm run test:e2e:isolated -- --seed-v2-active tests/e2e/d2d-upgrade-journey.spec.ts
 *                                                  # 升級旅程專用：每輪 server 啟動前先把隔離 DB 還原為「既有 v2 DB」
 *                                                  # 前置狀態（scripts/e2e-seed-v2-active.ts），其餘隔離契約不變
 *
 * 每組執行都建立系統臨時目錄下的獨立 sqlite，結束後刪除；不會讀寫 data/app.sqlite，也不會連 3000 服務。
 */

interface Args {
  shared: boolean;
  port: number;
  repeat: number;
  files: string[];
  /** D2d E：每輪 server 啟動前還原「既有 v2 DB」前置狀態（僅升級旅程 spec 需要） */
  seedV2Active: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { shared: false, port: DEFAULT_ISOLATED_E2E_PORT, repeat: 1, files: [], seedV2Active: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shared') {
      args.shared = true;
    } else if (a === '--port') {
      args.port = Number(argv[++i]);
    } else if (a === '--repeat') {
      args.repeat = Number(argv[++i]);
      if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error('--repeat 必須是正整數');
    } else if (a === '--seed-v2-active') {
      args.seedV2Active = true;
    } else if (a.startsWith('--')) {
      throw new Error(`未知選項 ${a}`);
    } else {
      args.files.push(a);
    }
  }
  return args;
}

function listSpecFiles(): string[] {
  const dir = path.resolve('tests/e2e');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort()
    .map((f) => path.join('tests', 'e2e', f));
}

interface GroupResult {
  files: string[];
  /** 每一輪的結束碼（--repeat N 時有 N 筆；輪與輪之間共用同一個臨時 DB） */
  statuses: number[];
}

function runGroup(files: string[], port: number, repeat: number, seedV2Active: boolean): GroupResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const databasePath = path.join(tmpDir, 'app.sqlite');
  // D2d E：每輪 server 啟動前重建「既有 v2 DB」現況，因此保留一份未被 server 觸碰的樣板，
  // 供每輪以複製取代重跑（同一個 DB 路徑、同一個 tmpDir，隔離契約不變）。
  const seedPath = path.join(tmpDir, 'seed-v2-active.sqlite');
  let statuses: number[] = [];
  try {
    assertIsolatedE2eTarget({ databasePath, port });
    if (seedV2Active) {
      const seeded = spawnSync('npx', ['tsx', 'scripts/e2e-seed-v2-active.ts', seedPath], {
        stdio: 'inherit',
      });
      if (seeded.status !== 0) throw new Error('建立 v2 前置狀態失敗（e2e-seed-v2-active.ts）');
    }
    statuses = [];
    for (let pass = 1; pass <= repeat; pass++) {
      console.log(
        `\n=== 隔離 E2E：${files.join(', ')}｜埠 ${port}｜第 ${pass}/${repeat} 輪｜DB ${databasePath} ===`
      );
      if (seedV2Active) {
        // 從樣板複製一份，確保每輪都從同一個 v2 現況開始（--repeat 跨輪不殘留）
        fs.rmSync(databasePath, { force: true });
        fs.copyFileSync(seedPath, databasePath);
        for (const suffix of ['-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
      }
      const res = spawnSync(
        'npx',
        ['playwright', 'test', '-c', 'playwright.isolated.config.ts', ...files],
        {
          stdio: 'inherit',
          env: { ...process.env, E2E_DATABASE_PATH: databasePath, E2E_PORT: String(port) },
        }
      );
      statuses.push(res.status ?? 1);
    }
    return { files, statuses };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main(): void {
  if (!fs.existsSync('playwright.isolated.config.ts')) {
    throw new Error('請在 web/ 目錄執行（找不到 playwright.isolated.config.ts）');
  }
  const args = parseArgs(process.argv.slice(2));
  const files = args.files.length > 0 ? args.files : listSpecFiles();
  const groups = args.shared ? [files] : files.map((f) => [f]);

  const results = groups.map((g) => runGroup(g, args.port, args.repeat, args.seedV2Active));

  console.log('\n=== 隔離 E2E 結果 ===');
  for (const r of results) {
    const perPass = r.statuses.map((s) => (s === 0 ? 'PASS' : 'FAIL')).join(' → ');
    console.log(`${perPass}  ${r.files.join(', ')}`);
  }
  process.exit(results.every((r) => r.statuses.every((s) => s === 0)) ? 0 : 1);
}

main();

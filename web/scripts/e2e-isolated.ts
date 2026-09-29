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
 *
 * 每組執行都建立系統臨時目錄下的獨立 sqlite，結束後刪除；不會讀寫 data/app.sqlite，也不會連 3000 服務。
 */

interface Args {
  shared: boolean;
  port: number;
  repeat: number;
  files: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { shared: false, port: DEFAULT_ISOLATED_E2E_PORT, repeat: 1, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shared') {
      args.shared = true;
    } else if (a === '--port') {
      args.port = Number(argv[++i]);
    } else if (a === '--repeat') {
      args.repeat = Number(argv[++i]);
      if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error('--repeat 必須是正整數');
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

function runGroup(files: string[], port: number, repeat: number): GroupResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const databasePath = path.join(tmpDir, 'app.sqlite');
  const statuses: number[] = [];
  try {
    assertIsolatedE2eTarget({ databasePath, port });
    for (let pass = 1; pass <= repeat; pass++) {
      console.log(
        `\n=== 隔離 E2E：${files.join(', ')}｜埠 ${port}｜第 ${pass}/${repeat} 輪｜DB ${databasePath} ===`
      );
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

  const results = groups.map((g) => runGroup(g, args.port, args.repeat));

  console.log('\n=== 隔離 E2E 結果 ===');
  for (const r of results) {
    const perPass = r.statuses.map((s) => (s === 0 ? 'PASS' : 'FAIL')).join(' → ');
    console.log(`${perPass}  ${r.files.join(', ')}`);
  }
  process.exit(results.every((r) => r.statuses.every((s) => s === 0)) ? 0 : 1);
}

main();

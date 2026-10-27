import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 隔離 E2E 執行器 `--repeat` 的 DB 重設語意（issue #47）。
 *
 * 以「假 npx」驅動**真實**的 scripts/e2e-isolated.ts：假 npx 攔下 `playwright` 呼叫，
 * 記錄該輪起點時 E2E_DATABASE_PATH 的狀態，再留下一個殘留（模擬 spec 寫入 DB），
 * 其他 npx 呼叫（seed 腳本）原樣轉給真的 npx。因此不需啟動瀏覽器或 server，
 * 驗證的是 runner 在每輪之間實際對 DB 檔做了什麼。
 *
 * 隔離：子行程的 TMPDIR 指向本測試自建的目錄，runner 的 sb-e2e-* 都建在裡面；
 * 清理只刪這個自建目錄，不掃 os.tmpdir()。
 */

const web = path.resolve(__dirname, '../..');
const runner = path.join(web, 'scripts/e2e-isolated.ts');
const loader = path.join(web, 'node_modules/tsx/dist/loader.mjs');
const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// 一輪的起點觀察：DB 檔是否存在、大小、內容摘要（以位元組長度與前綴辨識殘留／seed）。
interface PassObservation {
  exists: boolean;
  size: number;
  sidecars: string[];
}

function runRunner(args: string[]) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-repeat-test-')));
  sandboxes.push(sandbox);
  const bin = path.join(sandbox, 'bin');
  const tmp = path.join(sandbox, 'tmp');
  const log = path.join(sandbox, 'passes.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  const shim = path.join(bin, 'npx');
  fs.writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'if [ "$1" = "playwright" ]; then',
      '  size=-1; [ -e "$E2E_DATABASE_PATH" ] && size=$(wc -c < "$E2E_DATABASE_PATH" | tr -d " ")',
      '  side=""; for s in -wal -shm; do [ -e "$E2E_DATABASE_PATH$s" ] && side="$side $s"; done',
      '  echo "size=$size sidecars=$side" >> "$FAKE_NPX_LOG"',
      '  echo residue-from-spec >> "$E2E_DATABASE_PATH"',
      '  echo wal-residue > "$E2E_DATABASE_PATH-wal"',
      '  exit 0',
      'fi',
      'PATH="$REAL_PATH" exec npx "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  const result = spawnSync(process.execPath, ['--import', loader, runner, '--port', '3499', ...args], {
    cwd: web,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      TMPDIR: tmp,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      REAL_PATH: process.env.PATH ?? '',
      FAKE_NPX_LOG: log,
    },
  });
  const passes: PassObservation[] = fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const m = /^size=(-?\d+) sidecars=(.*)$/.exec(line)!;
          return { exists: Number(m[1]) >= 0, size: Number(m[1]), sidecars: m[2].trim().split(/\s+/).filter(Boolean) };
        })
    : [];
  return { result, passes, tmp };
}

describe('e2e-isolated --repeat：每輪 DB 起點', () => {
  it('預設（無 seed）：--repeat 2 每輪都從全新（不存在）的 DB 開始，-wal／-shm 也清掉', () => {
    const { result, passes, tmp } = runRunner(['--repeat', '2', 'tests/e2e/fake.spec.ts']);
    expect(result.status, result.stderr).toBe(0);
    expect(passes.length, '應跑 2 輪').toBe(2);
    expect(passes[0], '第 1 輪起點').toEqual({ exists: false, size: -1, sidecars: [] });
    expect(passes[1], '第 2 輪起點必須與第 1 輪相同＝全新 DB，不得帶著上一輪 spec 的殘留').toEqual({ exists: false, size: -1, sidecars: [] });
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith('sb-e2e-')), 'runner 結束後 sb-e2e-* 臨時目錄已刪除（tsx 自己的快取目錄不算）').toEqual([]);
  }, 150000);

  it('--keep-db：明確 opt-in 才保留跨輪殘留（重現 issue #25 的診斷用途）', () => {
    const { result, passes } = runRunner(['--repeat', '2', '--keep-db', 'tests/e2e/fake.spec.ts']);
    expect(result.status, result.stderr).toBe(0);
    expect(passes.length).toBe(2);
    expect(passes[0].exists, '第 1 輪起點仍是全新').toBe(false);
    expect(passes[1].exists, '--keep-db：第 2 輪看得到第 1 輪留下的 DB').toBe(true);
    expect(passes[1].size).toBeGreaterThan(0);
    expect(passes[1].sidecars, '--keep-db 連 -wal 一併保留').toContain('-wal');
  }, 150000);



  it('--keep-db 沒有搭配 --repeat N（N≥2）沒有意義：明確報錯而不是靜默忽略', () => {
    const { result, passes } = runRunner(['--keep-db', 'tests/e2e/fake.spec.ts']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--keep-db');
    expect(result.stderr).toContain('--repeat');
    expect(passes.length).toBe(0);
  }, 150000);


});

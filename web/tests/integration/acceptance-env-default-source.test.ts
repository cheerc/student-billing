import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';

const web = path.resolve(__dirname, '../..');
const children: ChildProcess[] = [];
const states: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  for (const state of states.splice(0)) fs.rmSync(state, { recursive: true, force: true });
});

/** 從目前 HEAD 的追蹤檔解出 web/（不帶 node_modules／.next／data）——與 T1 對來源做的事一致。 */
function trackedWeb(repo: string): string {
  const sourceRoot = (() => {
    let root = web;
    while (!fs.existsSync(path.join(root, '.git'))) root = path.dirname(root);
    return root;
  })();
  spawnSync('tar', ['-x', '-C', repo], { input: execFileSync('git', ['archive', 'HEAD', 'web'], { cwd: sourceRoot, maxBuffer: 1 << 28 }) });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.email', 'acceptance@test.invalid');
  git('config', 'user.name', 'acceptance test');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'acceptance default source');
  return path.join(repo, 'web');
}

/**
 * B1（批次 E rework r1，Lead 點查 exact head）：使用者路徑必須可用。
 *
 * specs/12 §4 記載的指令是 `cd web && npx tsx scripts/acceptance-env.ts --port 3300`，
 * **不帶任何環境變數**。工具的 SOURCE 預設必須指向套件目錄（`__dirname/..`，含
 * package.json）；若預設指向 repo 根（`__dirname/../..`），為了讓哨兵測試可控而加的
 * `existsSync(SOURCE/package.json)` 檢查就會在使用者路徑上必定 throw——測試綠（它只傳
 * ACCEPTANCE_SOURCE_DIR）而使用者紅。
 *
 * 本測試把 scripts（含相依的 e2e-isolation.ts）與真實追蹤檔的 web/ 放進測試自建的暫存 repo，
 * 在該 web/ 下以「不帶 ACCEPTANCE_SOURCE_DIR」執行：__dirname 於是指向暫存 repo 的 scripts/，
 * SOURCE 走**預設值**，驗證的就是使用者路徑。
 *
 * 只斷言「越過來源檢查、archive 成功並開始 npm ci」——build 與 READY 由
 * acceptance-env.test.ts 的哨兵測試覆蓋（它用 ACCEPTANCE_SOURCE_DIR 指向完整暫存 repo）。
 */
describe('T1：使用者路徑（不帶 ACCEPTANCE_SOURCE_DIR）能越過來源檢查', () => {
  it('以預設 SOURCE 啟動：不因 package.json 檢查 throw，並完成 archive、開始 npm ci', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-t1-default-source-')));
    states.push(repo);
    const pkg = trackedWeb(repo);
    const loader = path.join(pkg, 'node_modules/tsx/dist/loader.mjs');
    fs.symlinkSync(path.join(web, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');   // 只為啟動 tsx；T1 自己在 workspace 跑 npm ci

    const env = { ...process.env };
    delete env.ACCEPTANCE_SOURCE_DIR;   // 使用者路徑：完全沒有這個變數
    const child = spawn(process.execPath, ['--import', loader, path.join(pkg, 'scripts/acceptance-env.ts'), '--port', '3844'],
      { cwd: pkg, stdio: ['ignore', 'pipe', 'pipe'], env });
    children.push(child);
    const output = await new Promise<string>((resolve, reject) => {
      let text = '';
      const deadline = setTimeout(() => reject(new Error(`120s 內既未開始 npm ci 也未結束：\n${text}`)), 120000);
      const onData = (data: Buffer) => {
        text += data.toString();
        if (/> npm ci|npm ci|added \d+ packages/i.test(text)) { clearTimeout(deadline); resolve(text); }   // archive 已成功、workspace 已有 package.json
        if (/package\.json（請由 web\/ 目錄啟動本工具/.test(text)) { clearTimeout(deadline); resolve(text); }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.on('exit', (code) => { clearTimeout(deadline); resolve(`${text}\n[exit ${code}]`); });
    });
    console.log('T1 default-source output', JSON.stringify({ output: output.slice(-1200) }));
    // RED（3baf51f）：含「package.json（請由 web/ …）」throw；GREEN：不含，且已進入 npm ci（archive 成功）。
    expect(output, '不帶 ACCEPTANCE_SOURCE_DIR 時不得因 package.json 檢查 throw').not.toMatch(/package\.json（請由 web\/ 目錄啟動本工具/);
    expect(output, '應已越過來源檢查、archive 成功並開始 npm ci').toMatch(/> npm ci|npm ci|added \d+ packages/i);
  }, 150000);
});
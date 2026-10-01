import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';

const web = path.resolve(__dirname, '../..');
const script = path.join(web, 'scripts/acceptance-env.ts');
const loader = path.join(web, 'node_modules/tsx/dist/loader.mjs');
const children: ChildProcess[] = [];
const states: string[] = [];
const files: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
  for (const state of states.splice(0)) fs.rmSync(state, { recursive: true, force: true });
});

function cli(args: string[], repo = web) {
  return spawnSync(process.execPath, ['--import', loader, script, ...args], { cwd: web, encoding: 'utf8', timeout: 20000, env: { ...process.env, ACCEPTANCE_SOURCE_DIR: repo } });
}

// 注意 cwd 固定為 web（對應 CI 的 working-directory）：工具必須自行處理 pathspec，
// 不能依賴呼叫者的 cwd。
async function start(repo = web) {
  const child = spawn(process.execPath, ['--import', loader, script, '--port', '3840'], { cwd: web, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ACCEPTANCE_SOURCE_DIR: repo } });
  children.push(child);
  return new Promise<{ child: ChildProcess; state: string; database: string; workspace: string; url: string; source: string }>((resolve, reject) => {
    let output = '';
    const deadline = setTimeout(() => reject(new Error('T1 未在120s內回報 ready；停止自有 child，不放寬門檻')), 120000);
    child.stderr!.on('data', (data) => { output += data.toString(); });
    child.stdout!.on('data', (data) => {
      output += data.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('SESSION ')) {
          const session = JSON.parse(line.slice(8));
          if (!states.includes(session.state)) states.push(session.state);
        }
        if (line.startsWith('READY ')) {
          clearTimeout(deadline);
          resolve({ child, ...JSON.parse(line.slice(6)) });
          return;
        }
      }
    });
    child.on('error', (error) => { clearTimeout(deadline); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(deadline); reject(new Error(`T1 在 ready 前退出 code=${code} signal=${signal}\n${output}`)); });
  });
}

describe('T1：獨立 production build 的隔離驗收環境', () => {
  it('新空 DB→儲存→restart 保留→reset 清空→stop；build 只取追蹤檔、不改 checkout .next', async () => {
    // 被測 checkout 由測試自建（git clone --local 到 tmpdir），不共用受測 worktree：
    // 另一個行程（例如並行 npm run build）若改到受測 worktree 的 source .next，這個斷言
    // 就不受影響。哨兵 .next/BUILD_ID 預先放好，用來證明 T1 完全不寫入它——
    // 內容、mtime 皆須不變，且 T1 workspace 的 BUILD_ID 必須與哨兵不同。
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-acceptance-repo-')));
    states.push(repo);
    fs.writeFileSync(path.join(repo, 'bait.txt'), '合成 untracked 誘餌，不得複製到 build workspace', { flag: 'wx' });
    files.push(path.join(repo, 'bait.txt'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '--quiet');
    git('config', 'user.email', 'acceptance@test.invalid');
    git('config', 'user.name', 'acceptance test');
    // 只取追蹤檔；不複製來源目錄，untracked 的 bait 不會進來。
    // pathspec 與 archive 的 cwd 都用 repo 根：`git archive` 的 pathspec 在 CI 的 git 2.55
    // （ubuntu-24.04）自 repo 根解析，在本機 git 2.50 自 cwd 解析——所以 `cwd: web` + pathspec
    // `web` 在本機通過、在 CI 卻 `pathspec 'web' did not match`（CI run 36904969343，HEAD 207f6b7）。
    // 以 `/usr/bin/git` 在普通 clone 實測：`cwd=web` + pathspec `web` FAIL、`cwd=root` OK；
    // `cwd=web` + pathspec `package.json` OK。cwd=repo 根 ＋ 根相對路徑在兩版皆成立。
    // 這裡模擬「測試自建的暫存 repo 被 T1 當成來源」，repo 根就是剛 git init 的暫存目錄
    // （不經 git rev-parse：sandbox 的 git wrapper 會把它改寫到別的 worktree）。
    const repoRoot = repo;
    // 走檔案而非 execFileSync 的 buffer：repo 的 tar 會超過 sync 的輸出上限（ENOBUFS）。
    fs.writeFileSync(path.join(repo, 'source.tar'), execFileSync('git', ['archive', 'HEAD', 'web'], { cwd: repoRoot, maxBuffer: 1 << 28 }));
    expect(spawnSync('tar', ['-xf', 'source.tar', '-C', repo], { cwd: repo }).status, '解開 git archive').toBe(0);
    fs.rmSync(path.join(repo, 'source.tar'));
    git('add', '-A');
    git('commit', '--quiet', '-m', 'acceptance source');
    const sentinelDir = path.join(repo, 'web/.next');
    const sentinel = path.join(sentinelDir, 'BUILD_ID');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(sentinel, 'SENTINEL-SOURCE-BUILD-ID\n');
    const sentinelStat = fs.statSync(sentinel);

    const buildId = path.join(repo, 'web/.next/BUILD_ID');
    const before = fs.readFileSync(buildId, 'utf8');
    const session = await start(path.join(repo, 'web'));
    expect(session.database.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)).toBe(true);
    expect(session.source).toBe(path.join(repo, 'web'));
    expect(fs.existsSync(path.join(session.workspace, 'bait.txt')), 'build workspace 只取追蹤檔，untracked 誘餌不得出現').toBe(false);
    const after = fs.statSync(buildId);
    expect(fs.readFileSync(buildId, 'utf8'), 'T1 不得改寫 source checkout 的 .next/BUILD_ID 內容').toBe(before);
    expect(after.mtimeMs, 'T1 不得重建 source checkout 的 .next（mtime 會變）').toBe(sentinelStat.mtimeMs);
    expect(fs.readdirSync(sentinelDir), 'T1 不得在 source 的 .next 增刪任何檔案').toEqual(['BUILD_ID']);
    const workspaceBuildId = path.join(session.workspace, '.next/BUILD_ID');
    expect(fs.existsSync(workspaceBuildId), 'T1 必須在自己的 workspace 產出 BUILD_ID').toBe(true);
    expect(fs.readFileSync(workspaceBuildId, 'utf8').trim(), 'T1 的 build 必須發生在 workspace').not.toBe(before.trim());
    const draft = buildSeedDraft();
    draft.classes[0].teacher = '合成T1持久化老師';
    const request = async (endpoint: string, body?: unknown) => {
      // connection: close —— restart 會關閉舊 socket；Node fetch 的 keep-alive 池若重用它會 ECONNRESET。
      const response = await fetch(session.url + endpoint, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) } : { headers: { connection: 'close' } }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const current = await request('/api/v1/runs/current');
    expect(current.activeRunId).toBeNull();
    const preview = await request('/api/v1/settings/preview', { draft, expectedRevision: 0 });
    const applied = await request('/api/v1/settings/apply', { previewId: preview.previewId, expectedRevision: 0, idempotencyKey: 't1-persist' });
    expect(applied.mode).toBe('settings_only');
    expect(cli(['--restart', '--state', session.state], path.join(repo, 'web')).status, 'restart').toBe(0);
    const persisted = await request('/api/v1/settings/deductions');
    expect(persisted.classes.some((item: { teacher: string }) => item.teacher === '合成T1持久化老師')).toBe(true);
    expect(cli(['--reset', '--state', session.state], path.join(repo, 'web')).status, 'reset').toBe(0);
    const reset = await request('/api/v1/settings/deductions');
    expect(reset.classes.some((item: { teacher: string }) => item.teacher === '合成T1持久化老師')).toBe(false);
    // 刪除臨時 repo（含哨兵）也要在測試結束後清理，已由 afterEach 的 states 處理。
    const exited = once(session.child, 'exit');
    expect(cli(['--stop', '--state', session.state], path.join(repo, 'web')).status, 'stop').toBe(0);
    await exited;
    expect(session.child.exitCode).toBe(0);
    expect(fs.readFileSync(buildId, 'utf8'), '整輪結束後 source 哨兵仍不變').toBe(before);
  }, 150000);

  it('拒絕 operator 3000 與沒有 marker 的 state，不啟動或終止未知服務', () => {
    const port = cli(['--port', '3000']);
    expect(port.status).not.toBe(0);
    expect(port.stderr).toContain('3000');
    const unknown = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unknown-acceptance-'));
    states.push(unknown);
    const control = cli(['--reset', '--state', unknown]);
    expect(control.status).not.toBe(0);
    expect(control.stderr).toMatch(/marker|識別/);
    expect(fs.readdirSync(unknown)).toEqual([]);
  });
});

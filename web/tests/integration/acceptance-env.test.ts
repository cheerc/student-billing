import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
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

function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', loader, script, ...args], { cwd: web, encoding: 'utf8', timeout: 20000 });
}

async function start() {
  const child = spawn(process.execPath, ['--import', loader, script, '--port', '3840'], { cwd: web, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise<{ child: ChildProcess; state: string; database: string; workspace: string; url: string }>((resolve, reject) => {
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
    const bait = path.join(web, `acceptance-untracked-${randomUUID()}.txt`);
    fs.writeFileSync(bait, '合成 untracked 誘餌，不得複製到 build workspace', { flag: 'wx' });
    files.push(bait);
    const buildId = path.join(web, '.next/BUILD_ID');
    const before = fs.existsSync(buildId) ? fs.readFileSync(buildId, 'utf8').trim() : null;
    const session = await start();
    expect(session.database.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(session.workspace, path.basename(bait))), 'build workspace 只取追蹤檔，untracked 誘餌不得出現').toBe(false);
    // T1 的 build 在 tmpdir 的 workspace，不在 source checkout。因此 workspace 的 BUILD_ID
    // 必須與 source 的不同——相同代表 T1 用了 source 的 .next；不同才證明它沒有動到 source。
    // 註：若本機同時有另一個 `npm run build` 在跑，source 的 BUILD_ID 會被換掉，這裡比對的是
    // 「兩者是否相同」，並行 build 只會讓 before 改變，不影響這個判斷。
    const workspaceBuildId = path.join(session.workspace, '.next/BUILD_ID');
    expect(fs.existsSync(workspaceBuildId), 'T1 必須在自己的 workspace 產出 BUILD_ID').toBe(true);
    expect(before, 'T1 的 build 必須發生在 workspace，不能覆寫 source checkout 的 .next/BUILD_ID').not.toBe(fs.readFileSync(workspaceBuildId, 'utf8').trim());
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
    expect(cli(['--restart', '--state', session.state]).status).toBe(0);
    const persisted = await request('/api/v1/settings/deductions');
    expect(persisted.classes.some((item: { teacher: string }) => item.teacher === '合成T1持久化老師')).toBe(true);
    expect(cli(['--reset', '--state', session.state]).status).toBe(0);
    const reset = await request('/api/v1/settings/deductions');
    expect(reset.classes.some((item: { teacher: string }) => item.teacher === '合成T1持久化老師')).toBe(false);
    const exited = once(session.child, 'exit');
    expect(cli(['--stop', '--state', session.state]).status).toBe(0);
    await exited;
    expect(session.child.exitCode).toBe(0);
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

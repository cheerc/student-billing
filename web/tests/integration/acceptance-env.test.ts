import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import net from 'net';
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
// timeout 分支與 exit 分支的失敗訊息都要帶上已累積的 child 輸出與 child 狀態（#108）。
// 抽成純函式除了讓兩條分支共用同一組欄位，也讓 timeout 分支可在不真的等滿 120s 的情況下被測到：
// deadline 的 120s 是 scope 內不可改的門檻，若把訊息組裝留在 setTimeout 迴圈裡，就只能靠真的逾時來
// 觀察，而逾時本身就是 #105 尚未收斂的間歇現象（不重跑測試追綠，見 CLAUDE.md §8）。
function timeoutMessage(child: ChildProcess, output: string) {
  return `T1 未在120s內回報 ready；停止自有 child，不放寬門檻 pid=${child.pid} exitCode=${child.exitCode} signalCode=${child.signalCode}\n${output}`;
}

async function start(repo = web, scriptPath = script) {
  const child = spawn(process.execPath, ['--import', loader, scriptPath, '--port', '3840'], { cwd: web, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ACCEPTANCE_SOURCE_DIR: repo } });
  children.push(child);
  return new Promise<{ child: ChildProcess; state: string; database: string; workspace: string; url: string; source: string }>((resolve, reject) => {
    let output = '';
    const deadline = setTimeout(() => reject(new Error(timeoutMessage(child, output))), 120000);
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

describe('T1 timeout 訊息：附上已累積的 child 輸出與 child 狀態', () => {
  // 這組測試要守住的是 start() 內 :48 那一行接線（把 timeoutMessage 的結果交給 reject），
  // 不是 timeoutMessage 函式本體。守門方式是真走 start() 的 reject 路徑：起一個假的 T1 child
  // （script 指向一個永不印 SESSION/READY 的腳本，因此不會真的 mkdtemp、不會起 server），
  // 再用 fake timers 把 deadline 推進到 120s。若有人把 :48 改回固定字串，這裡必然失敗。
  //
  // 為什麼是 fake timers 而不是把 120000 變成可注入參數：120000 是 scope 內凍結的門檻，
  // 把它變成可配置點等於留下一條「有人傳入更長 deadline 來修 flaky」的 regress 通道。
  // vi.useFakeTimers() 只影響本測試行程的 setTimeout，start() spawn 出去的是獨立 OS 行程，
  // 不受影響——所以 deadline 觸發與 child 是否還活著是分開可控的，不必真的等 120s。
  const fakeT1Script = path.join(web, 'tests/integration/fixtures/stub-t1.ts');

  // start() 已經把 child 推進 module 層的 children（afterEach 的清理吃同一份），
  // 這裡取最後一個就是它——不必為了測試而改動 start() 的回傳形狀。
  // Node stream 支援多個 listener，所以掛第二個 listener 不會搶走 start() 自己那份：
  // 兩個 listener 都會收到同一批 chunk，start() 內部的 output 照常累積。
  const lastChild = () => children[children.length - 1];
  function waitForChildOutput(child: ChildProcess, marker: string) {
    return new Promise<void>((resolve, reject) => {
      let seen = '';
      const onData = (data: Buffer) => {
        seen += data.toString();
        if (seen.includes(marker)) { child.stdout!.off('data', onData); resolve(); }
      };
      child.stdout!.on('data', onData);
      child.once('exit', () => reject(new Error(`child 在印出 ${marker} 前就退出了：${JSON.stringify(seen)}`)));
    });
  }

  it('start() 的 deadline 到期時，reject 的訊息附上已累積輸出與 child 狀態（守住 :48 接線）', async () => {
    // 必須在 start() 之前裝 fake timers：:48 的 setTimeout 在 start() 呼叫當下就抓了
    // 當時的 setTimeout 參考，晚一步裝等於 deadline 已經掛在真時鐘上，推進假時鐘不會觸發它。
    // 等 child 印 marker 的那段用的是真實 stream 事件（不是 setTimeout），所以不受假時鐘影響。
    vi.useFakeTimers();
    try {
      const pending = start(web, fakeT1Script);
      // 先掛好 handler 再推進時鐘：reject 是在 deadline 觸發的當下產生的，若那時還沒有
      // 任何 handler 附在 pending 上，Node 會記成 unhandledRejection 並讓測試檔報 Errors。
      const settled = pending.then(() => { throw new Error('deadline 到期後 start() 不應 resolve'); }, (reason: Error) => reason);
      // 等 marker 真的進了 start() 內部的 output，之後才推進時間——確保斷言檢查的是
      // 「截止前已累積的輸出」，而不是碰巧的空字串造成的失敗。
      await waitForChildOutput(lastChild(), 'STUB-T1-READY-NEVER');
      await vi.advanceTimersByTimeAsync(120000);
      const error = await settled;
      // 保留原本的門檻措辭，且 120s 仍是凍結常數（訊息文字寫死 120s，值也沒被參數化）。
      expect(error.message).toContain('T1 未在120s內回報 ready');
      // child 狀態：stub 只印一行 marker 後就停住，故仍在跑 → exitCode 與 signalCode 為 null。
      expect(error.message, '必須附上 child pid').toContain(`pid=${lastChild().pid}`);
      expect(error.message, '存活中的 child 其 exitCode 為 null').toContain('exitCode=null');
      expect(error.message, '存活中的 child 其 signalCode 為 null').toContain('signalCode=null');
      // 已累積輸出：這正是 #108 要補的診斷資訊（能分辨卡在哪一段）。
      expect(error.message, '必須附上截止前已累積的輸出').toContain('STUB-T1-READY-NEVER');
    } finally {
      vi.useRealTimers();
    }
  }, 60000);
});

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
    // 來源 repo 根：以「往上找 .git」判定，不用 git rev-parse（本機的 git wrapper 會改寫它）。
    let sourceRoot = web;
    while (!fs.existsSync(path.join(sourceRoot, '.git'))) {
      const parent = path.dirname(sourceRoot);
      if (parent === sourceRoot) throw new Error(`測試來源 ${web} 不在任何 git repo 內`);
      sourceRoot = parent;
    }
    // 先把**來源 checkout**（受測 worktree）的追蹤檔解出來——archive 必須在來源 repo 執行，
    // 且來源 repo 本來就有 commit；解到暫存 repo 後才 git init／commit。
    // 走檔案而非 execFileSync 的 buffer：repo 的 tar 會超過 sync 的輸出上限（ENOBUFS）。
    fs.writeFileSync(path.join(repo, 'source.tar'), execFileSync('git', ['archive', 'HEAD', 'web'], { cwd: sourceRoot, maxBuffer: 1 << 28 }));
    expect(spawnSync('tar', ['-xf', 'source.tar', '-C', repo], { cwd: repo }).status, '解開 git archive').toBe(0);
    fs.rmSync(path.join(repo, 'source.tar'));
    git('init', '--quiet');
    git('config', 'user.email', 'acceptance@test.invalid');
    git('config', 'user.name', 'acceptance test');
    git('add', '-A', '--', 'web');
    git('commit', '--quiet', '-m', 'acceptance source');
    expect(git('rev-parse', 'HEAD').trim(), '暫存 repo 必須已有 commit 才能被 git archive 讀取').toMatch(/^[0-9a-f]{40,64}$/);
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

  it('ACCEPTANCE_SOURCE_DIR 指向非 git repo：友善訊息、不洩漏 git 原始錯誤、不建立 sb-acceptance-* 目錄', async () => {
    // 來源目錄與子行程的 TMPDIR 都是本測試自建：T1 的 mkdtemp 會落在這個私有 TMPDIR，
    // 因此「有沒有新建 sb-acceptance-*」只看這個目錄，不受並行行程或他人目錄影響，
    // 清理也只刪本測試自建的兩個目錄。
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-nonrepo-test-')));
    states.push(sandbox);
    const source = path.join(sandbox, 'not-a-repo');
    const privateTmp = path.join(sandbox, 'tmp');
    fs.mkdirSync(source);
    fs.mkdirSync(privateTmp);
    fs.writeFileSync(path.join(source, 'package.json'), '{}\n');
    // 自選的空閒埠（由 OS 配置的暫時埠，不碰驗收中的 3000／3200／3300／3301／3302）。
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const result = spawnSync(process.execPath, ['--import', loader, script, '--port', String(port)], {
      cwd: web, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, ACCEPTANCE_SOURCE_DIR: source, TMPDIR: privateTmp },
    });
    expect(result.status, '非 repo 來源必須以非 0 結束').not.toBe(0);
    expect(result.stderr, '必須是工具自己的友善訊息').toContain('不在任何 git repo 內');
    expect(result.stderr, '不得把 git 的原始失敗當成使用者看到的錯誤').not.toContain('Command failed: git rev-parse');
    expect(result.stderr).not.toContain('fatal: not a git repository');
    expect(fs.readdirSync(privateTmp).filter((name) => name.startsWith('sb-acceptance-')), '失敗前不得建立 sb-acceptance-* 目錄').toEqual([]);
  }, 30000);
});

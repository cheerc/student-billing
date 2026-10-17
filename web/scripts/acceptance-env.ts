import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { assertIsolatedE2eTarget } from './e2e-isolation';

/**
 * 來源套件目錄（`web/`）。預設就是本檔所在的 repo 的 web/ —— 與 specs/12 §4 記載的
 * 使用者指令 `cd web && npx tsx scripts/acceptance-env.ts` 一致。
 * `ACCEPTANCE_SOURCE_DIR` 只供測試指向另一份 checkout（例如讓「不動 source .next」
 * 在暫存 repo 上被驗證），語意與預設相同，都必須是含 package.json 的套件目錄。
 */
const SOURCE = fs.realpathSync(path.resolve(process.env.ACCEPTANCE_SOURCE_DIR ?? path.join(__dirname, '..')));
const MARKER = 'acceptance-session.json';
type Action = 'restart' | 'reset' | 'stop';
interface Session {
  kind: 'student-billing-acceptance';
  /**
   * **sha256(明文 token) 的 hex，不是 token 本身**（issue #131）。
   *
   * 本檔會在 T1 存活期間持續留在磁碟上（`:139` 啟動時寫、`:183` stop 時刻意重寫），
   * 而它先前存的是可直接餵進控制端點的明文 token —— 任何同使用者行程讀到這個檔就能
   * 對 session 下 `reset`。現在檔內只留雜湊，比對是 `sha256(輸入) === 本欄位`。
   *
   * 明文只經由啟動時的 stdout（`SESSION {...}`／`READY {...}`）流過，那是它自己所屬
   * 那次啟動的 terminal，不落磁碟。
   */
  token: string;
  source: string;
  head: string;
  port: number;
  state: string;
  database: string;
  workspace: string;
  url: string;
  stopped: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * 控制端點授權。
 *
 * 比對的是雜湊而非明文（#131 —— 明文已不存在於磁碟，無從比對）。用固定長度的 hex
 * 比字串，不涉使用者輸入的長度，故無時序側通道可言。
 */
function authorize(input: { action?: Action; token?: string }, tokenHash: string): boolean {
  if (!input.action || !['restart', 'reset', 'stop'].includes(input.action)) return false;
  return typeof input.token === 'string' && hashToken(input.token) === tokenHash;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 3300;
  let state: string | undefined;
  let action: Action | undefined;
  let token: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') return { help: true, port };
    if (flag === '--port' && args[index + 1]) port = Number(args[++index]);
    else if (flag === '--state' && args[index + 1]) state = args[++index];
    else if (['--restart', '--reset', '--stop'].includes(flag) && !action) action = flag.slice(2) as Action;
    else throw new Error('用法：--port <埠>，或 --restart／--reset／--stop --state <SESSION目錄>');
  }
  if (Boolean(action) !== Boolean(state)) throw new Error('控制操作必須附 --state <啟動時印出的SESSION目錄>；新啟動不要帶 --state');
  if (action && state) token = plaintextToken();
  return { help: false, port, action, state, token };
}

/**
 * 控制指令要用的明文 token。
 *
 * 刻意**不**放行 `--token`：命令列參數會出現在同使用者的 `ps` 輸出，而這條路徑存在的
 * 理由就是收緊「憑證可被同使用者行程取得」。取環境變數 `ACCEPTANCE_TOKEN`，它的生命
 * 週期隨 shell 結束，不像檔案需要記得刪；也不從 state 目錄反推 —— 那等於把同一件事
 * 再寫回磁碟一次。
 *
 * 取不到值時回 undefined，由 `control()` 在跑完 marker 識別檢查之後才報錯：錯的
 * SESSION 目錄要看到識別錯誤（含 stopped 語意），不是先被「缺 token」蓋掉。
 */
function plaintextToken(): string | undefined {
  const token = process.env.ACCEPTANCE_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

function readSession(statePath: string): Session {
  const state = path.resolve(statePath);
  assertIsolatedE2eTarget({ databasePath: path.join(state, 'app.sqlite'), port: 3300 });
  if (!fs.existsSync(state) || fs.lstatSync(state).isSymbolicLink()) throw new Error('state 識別失敗；請使用啟動時印出的原始目錄，不接受 symlink');
  let session: Session;
  try { session = JSON.parse(fs.readFileSync(path.join(state, MARKER), 'utf8')); }
  catch { throw new Error('沒有有效 marker；請重新執行 start 建立隔離環境，不能 reset／停止未知服務'); }
  // token 欄位現為 sha256 hex（#131）。格式檢查仍在此把關：形狀不符的 marker 一律拒絕，
  // 不由後續的雜湊比對去承擔「這是不是本工具寫的」——比對失敗本來就回 403，但這裡擋下的
  // 是「連讀都不該當成一個 session」的檔。舊制（明文 UUID）的 marker 因此一併被拒，
  // 需重新 start；理由見 readSession 的呼叫端。
  if (session.kind !== 'student-billing-acceptance' || session.source !== SOURCE || session.state !== state
    || session.database !== path.join(state, 'app.sqlite') || session.workspace !== path.join(state, 'web')
    || !/^[0-9a-f]{64}$/.test(session.token) || !/^[0-9a-f]{40,64}$/.test(session.head)) {
    throw new Error('marker 識別不符；請從同一 checkout 使用正確 SESSION 目錄');
  }
  assertIsolatedE2eTarget({ databasePath: session.database, port: session.port });
  return session;
}

async function control(action: Action, state: string, plaintextToken: string | undefined) {
  const session = readSession(state);
  if (session.stopped) {
    if (action === 'stop') return console.log(`已停止：${session.database}；port ${session.port}`);
    throw new Error('此 SESSION 已停止；請重新 start 建立新環境。restart／reset 在前景啟動程序仍運行時使用');
  }
  // 明文 token 只可能來自啟動時印出的那兩行，因此自然取得；marker 的 token 是雜湊，
  // 拿它來控制必定 403（#131 的測試就量這一條）。不必為此設計新的憑證通道。
  if (!plaintextToken) throw new Error('控制需要啟動時印出的 token；請設定 ACCEPTANCE_TOKEN，或直接在啟動該 session 的 terminal 執行本指令');
  const body = JSON.stringify({ action, token: plaintextToken });
  await new Promise<void>((resolve, reject) => {
    const request = http.request({ socketPath: path.join(session.state, 'control.sock'), path: '/control', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(text));
        console.log(text);   // 端點回的是 {"ok":true,...}，本來就不含 token（#131 沒有改動回傳形狀）
        resolve();
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('控制逾時；回啟動 terminal 查看狀態，不重複 reset')));
    request.on('error', reject);
    request.end(body);
  });
}

async function assertFreePort(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`port ${port} 已占用；請改用 --port，工具不會終止其他服務`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

/**
 * 來源 repo 根與套件目錄。必須在 start() 建立任何東西（mkdtemp、git rev-parse）之前呼叫：
 * ACCEPTANCE_SOURCE_DIR 指向非 repo 時，使用者要看到下面的友善訊息，而不是 git 的
 * `fatal: not a git repository`＋`Command failed: git rev-parse HEAD`，也不該留下 sb-acceptance-* 目錄。
 */
function resolveSourceLayout() {
  // `git archive` 的 pathspec 在 CI 的 git 2.55（ubuntu-24.04）自 repo 根解析、在本機 2.50 自 cwd 解析，
  // 所以 `cwd=web` + pathspec `web` 在本機通過、在 CI 卻 `pathspec 'web' did not match`
  // （CI run 36904969343，HEAD 207f6b7）。以 `/usr/bin/git` 在普通 clone 實測：cwd=web+`web` FAIL、
  // cwd=root+`web` OK、cwd=web+`package.json` OK。cwd=repo 根＋根相對路徑在兩版皆成立。
  // repo 根以「往上找 .git」判定，不用 `git rev-parse`：sandbox 的 git wrapper 會把它改寫到
  // 別的 worktree，拿到的根不是這個來源。
  let repoRoot = SOURCE;
  while (!fs.existsSync(path.join(repoRoot, '.git'))) {
    const parent = path.dirname(repoRoot);
    if (parent === repoRoot) throw new Error(`來源 ${SOURCE} 不在任何 git repo 內`);
    repoRoot = parent;
  }
  if (!fs.existsSync(path.join(SOURCE, 'package.json'))) {
    throw new Error('來源必須是套件目錄（含 package.json 的 web/）；請在 web/ 內執行本工具，或讓 ACCEPTANCE_SOURCE_DIR 指向含 package.json 的目錄');
  }
  const packageDir = path.relative(repoRoot, SOURCE).split(path.sep).join('/');
  if (!packageDir || packageDir.startsWith('..')) throw new Error('來源套件目錄必須在 git repo 內');
  return { repoRoot, packageDir };
}

async function start(port: number) {
  const { repoRoot, packageDir } = resolveSourceLayout();
  assertIsolatedE2eTarget({ databasePath: path.join(os.tmpdir(), 'sb-acceptance-validation.sqlite'), port });
  await assertFreePort(port);
  const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-acceptance-')));
  fs.chmodSync(state, 0o700);
  // 明文 token 只活在這個行程的記憶體與 stdout（#131）：寫進磁碟的是它的雜湊。
  const token = randomUUID();
  const session: Session = {
    kind: 'student-billing-acceptance', token: hashToken(token), source: SOURCE,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE, encoding: 'utf8' }).trim(),
    port, state, database: path.join(state, 'app.sqlite'), workspace: path.join(state, 'web'),
    url: `http://127.0.0.1:${port}`, stopped: false,
  };
  assertIsolatedE2eTarget({ databasePath: session.database, port });
  fs.mkdirSync(session.workspace);
  // marker 寫的是 session（含雜湊）；印出來的是**明文**，兩者刻意不同 ——
  // 使用者的控制指令靠 `SESSION {...}` 的 token 欄位，而那個欄位只在這裡出現一次。
  const announce = (label = 'SESSION') => console.log(`${label} ` + JSON.stringify({ ...session, token }));
  const saveMarker = () => fs.writeFileSync(path.join(state, MARKER), JSON.stringify(session), { mode: 0o600 });
  saveMarker();
  announce();
  // ACCEPTANCE_ENV 只給 T1 workspace 的 build 用（見 next.config.ts）：T1 需要能起
  // production server，不驗證型別。條件式設定，產品 build 不受影響。
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_PATH: session.database, NEXT_TELEMETRY_DISABLED: '1', ACCEPTANCE_ENV: '1' };
  const jobs = new Set<ChildProcess>();
  const expectedExit = new WeakSet<ChildProcess>();
  let next: ChildProcess | null = null;
  let server: http.Server | null = null;
  let stopping = false;
  let busy = false;

  const track = (child: ChildProcess) => {
    jobs.add(child);
    child.once('close', () => jobs.delete(child));
    return child;
  };
  const completion = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`子程序退出 code=${code} signal=${signal}`)));
  });
  const terminate = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    expectedExit.add(child);
    await new Promise<void>((resolve) => {
      // Unix 子程序各有自有 process group，停止也涵蓋 npm／Next 產生的後代。
      const signal = (kind: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind);
          else child.kill(kind);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      const timeout = setTimeout(() => signal('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timeout); resolve(); });
      signal('SIGTERM');
    });
  };
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all([...jobs].map(terminate));
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    session.stopped = true;
    saveMarker();
    fs.rmSync(path.join(state, 'control.sock'), { force: true });
    // stop 後只保留 DB 與 marker（restart 仍需 DB）；build workspace 已無用途，避免 tmp 堆積。
    fs.rmSync(session.workspace, { recursive: true, force: true });
    console.log(`STOPPED DB=${session.database} port=${port} state=${state}`);
  };
  process.once('SIGINT', () => { void finish(); });
  process.once('SIGTERM', () => { void finish(); });

  const startNext = async () => {
    if (stopping) throw new Error('啟動已取消');
    const child = track(spawn(process.execPath, [path.join(session.workspace, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)],
      { cwd: session.workspace, env, stdio: 'inherit', detached: process.platform !== 'win32' }));
    next = child;
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('close', () => {
      if (!expectedExit.has(child) && !stopping) {
        process.exitCode = 1;
        console.error('production server 意外退出；停止自有程序，請從 terminal 查看錯誤後重新 start');
        void finish();
      }
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (stopping || failed || child.exitCode !== null || child.signalCode !== null) throw new Error('production server 在 ready 前退出');
      const ready = await new Promise<boolean>((resolve) => {
        const request = http.get(session.url, { agent: false }, (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        });
        request.setTimeout(1000, () => request.destroy());
        request.on('error', () => resolve(false));
      });
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('production server 30s 內未 ready；請查看錯誤，不重用未知服務');
  };

  try {
    // 只取 immutable HEAD 的 git 追蹤檔；不複製來源目錄、node_modules、data 或 untracked 資料。
    // archive 的 cwd／pathspec 與 repo 根判定的理由見 start() 開頭的 resolveSourceLayout。
    const archive = track(spawn('git', ['archive', session.head, packageDir], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'], detached: process.platform !== 'win32' }));
    const tar = track(spawn('tar', ['-x', '--strip-components=1', '-C', session.workspace], { stdio: ['pipe', 'inherit', 'inherit'], detached: process.platform !== 'win32' }));
    tar.stdin!.on('error', () => {});
    archive.stdout!.pipe(tar.stdin!);
    await Promise.all([completion(archive), completion(tar)]);
    for (const args of [['ci', '--include=dev'], ['run', 'build']]) {
      if (stopping) throw new Error('啟動已取消');
      await completion(track(spawn('npm', args, { cwd: session.workspace, env, stdio: 'inherit', detached: process.platform !== 'win32' })));
    }
    await startNext();
    server = http.createServer((request, response) => {
      response.setHeader('connection', 'close');
      if (request.method !== 'POST' || request.url !== '/control') { response.writeHead(404).end(); return; }
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) request.destroy();
      });
      request.on('end', async () => {
        let input: { action?: Action; token?: string };
        try { input = JSON.parse(body); } catch { response.writeHead(400).end('請提供合法JSON'); return; }
        // input.action 的白名單移到 authorize()（#131），此處只留結果。
        if (!authorize(input, session.token)) {
          response.writeHead(403).end('SESSION 識別不符'); return;
        }
        if (busy || stopping) { response.writeHead(409).end('正在操作，請等目前控制完成後再執行'); return; }
        busy = true;
        console.log(`CONTROL ${input.action}`);
        try {
          if (next) await terminate(next);
          next = null;
          if (input.action === 'reset') {
            readSession(state);
            for (const suffix of ['', '-wal', '-shm']) fs.rmSync(session.database + suffix, { force: true });
          }
          if (input.action !== 'stop') await startNext();
          await new Promise<void>((resolve) => response.end(JSON.stringify({ ok: true, action: input.action, database: session.database, port }), resolve));
          if (input.action === 'stop') await finish();
        } catch (error) {
          process.exitCode = 1;
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
          await finish();
        } finally { busy = false; }
      });
    });
    server.setTimeout(5000, (socket) => socket.destroy());
    const socket = path.join(state, 'control.sock');
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(socket, () => resolve()); });
    fs.chmodSync(socket, 0o600);
    // 同樣印明文（見上方 announce 的理由）；marker 在磁碟上仍是雜湊。
    // 行首必須維持 `READY `（`SESSION` 同理）：兩行都是既有自動化與測試的解析契約。
    announce('READY');
    console.log(`控制：npx tsx scripts/acceptance-env.ts --restart|--reset|--stop --state ${state}（需 ACCEPTANCE_TOKEN=<上面印出的 token>）`);
  } catch (error) {
    process.exitCode = stopping ? 0 : 1;
    console.error(error instanceof Error ? error.message : String(error));
    await finish();
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) return console.log('start：npx tsx scripts/acceptance-env.ts [--port 3300]\n控制：ACCEPTANCE_TOKEN=<啟動時印出的 token> npx tsx scripts/acceptance-env.ts --restart／--reset／--stop --state <SESSION目錄>');
  if (options.action && options.state) await control(options.action, options.state, options.token);
  else await start(options.port);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

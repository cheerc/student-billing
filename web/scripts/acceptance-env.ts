import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { assertIsolatedE2eTarget } from './e2e-isolation';

const SOURCE = fs.realpathSync(path.resolve(__dirname, '../..'));
const MARKER = 'acceptance-session.json';
type Action = 'restart' | 'reset' | 'stop';
interface Session {
  kind: 'student-billing-acceptance';
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

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 3300;
  let state: string | undefined;
  let action: Action | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') return { help: true, port };
    if (flag === '--port' && args[index + 1]) port = Number(args[++index]);
    else if (flag === '--state' && args[index + 1]) state = args[++index];
    else if (['--restart', '--reset', '--stop'].includes(flag) && !action) action = flag.slice(2) as Action;
    else throw new Error('用法：--port <埠>，或 --restart／--reset／--stop --state <SESSION目錄>');
  }
  if (Boolean(action) !== Boolean(state)) throw new Error('控制操作必須附 --state <啟動時印出的SESSION目錄>；新啟動不要帶 --state');
  return { help: false, port, action, state };
}

function readSession(statePath: string): Session {
  const state = path.resolve(statePath);
  assertIsolatedE2eTarget({ databasePath: path.join(state, 'app.sqlite'), port: 3300 });
  if (!fs.existsSync(state) || fs.lstatSync(state).isSymbolicLink()) throw new Error('state 識別失敗；請使用啟動時印出的原始目錄，不接受 symlink');
  let session: Session;
  try { session = JSON.parse(fs.readFileSync(path.join(state, MARKER), 'utf8')); }
  catch { throw new Error('沒有有效 marker；請重新執行 start 建立隔離環境，不能 reset／停止未知服務'); }
  if (session.kind !== 'student-billing-acceptance' || session.source !== SOURCE || session.state !== state
    || session.database !== path.join(state, 'app.sqlite') || session.workspace !== path.join(state, 'web')
    || !/^[0-9a-f-]{36}$/.test(session.token) || !/^[0-9a-f]{40,64}$/.test(session.head)) {
    throw new Error('marker 識別不符；請從同一 checkout 使用正確 SESSION 目錄');
  }
  assertIsolatedE2eTarget({ databasePath: session.database, port: session.port });
  return session;
}

async function control(action: Action, state: string) {
  const session = readSession(state);
  if (session.stopped) {
    if (action === 'stop') return console.log(`已停止：${session.database}；port ${session.port}`);
    throw new Error('此 SESSION 已停止；請重新 start 建立新環境。restart／reset 在前景啟動程序仍運行時使用');
  }
  const body = JSON.stringify({ action, token: session.token });
  await new Promise<void>((resolve, reject) => {
    const request = http.request({ socketPath: path.join(session.state, 'control.sock'), path: '/control', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(text));
        console.log(text);
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

async function start(port: number) {
  assertIsolatedE2eTarget({ databasePath: path.join(os.tmpdir(), 'sb-acceptance-validation.sqlite'), port });
  await assertFreePort(port);
  const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-acceptance-')));
  fs.chmodSync(state, 0o700);
  const session: Session = {
    kind: 'student-billing-acceptance', token: randomUUID(), source: SOURCE,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE, encoding: 'utf8' }).trim(),
    port, state, database: path.join(state, 'app.sqlite'), workspace: path.join(state, 'web'),
    url: `http://127.0.0.1:${port}`, stopped: false,
  };
  assertIsolatedE2eTarget({ databasePath: session.database, port });
  fs.mkdirSync(session.workspace);
  const saveMarker = () => fs.writeFileSync(path.join(state, MARKER), JSON.stringify(session), { mode: 0o600 });
  saveMarker();
  console.log('SESSION ' + JSON.stringify(session));
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_PATH: session.database, NEXT_TELEMETRY_DISABLED: '1' };
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
    const archive = track(spawn('git', ['archive', session.head, 'web'], { cwd: SOURCE, stdio: ['ignore', 'pipe', 'inherit'], detached: process.platform !== 'win32' }));
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
        if (input.token !== session.token || !input.action || !['restart', 'reset', 'stop'].includes(input.action)) {
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
    console.log('READY ' + JSON.stringify(session));
    console.log(`控制：npx tsx scripts/acceptance-env.ts --restart|--reset|--stop --state ${state}`);
  } catch (error) {
    process.exitCode = stopping ? 0 : 1;
    console.error(error instanceof Error ? error.message : String(error));
    await finish();
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) return console.log('start：npx tsx scripts/acceptance-env.ts [--port 3300]\n控制：--restart／--reset／--stop --state <SESSION目錄>');
  if (options.action && options.state) await control(options.action, options.state);
  else await start(options.port);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

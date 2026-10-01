import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import net from 'net';
import path from 'path';
import { once } from 'events';

const web = path.resolve(__dirname, '../..');
const script = path.join(web, 'scripts/acceptance-proxy.ts');
const loader = path.join(web, 'node_modules/tsx/dist/loader.mjs');
const PROXY_PORT = 3850;
const upstreamPorts = [3860, 3861, 3862, 3863];
const children: ChildProcess[] = [];
const states: string[] = [];
const files: string[] = [];
const sockets: net.Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  for (const server of sockets.splice(0)) server.close();
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
  for (const state of states.splice(0)) fs.rmSync(state, { recursive: true, force: true });
});

function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', loader, script, ...args], { cwd: web, encoding: 'utf8', timeout: 20000 });
}

/** 真 localhost 上游；chunked=true 時第一片立即送出、其餘延後，用來觀察代理是否緩衝。 */
async function upstream(port: number, status: number, chunked = false) {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    // 沒有 data 監聽的請求（GET）必須 resume()，否則 request 串流不流動、'end' 永不觸發，
    // 上游就永遠不回應——那是本測試上游自己的缺陷，不是代理行為。
    if (request.method === 'GET' || request.method === 'HEAD') request.resume();
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      if (!chunked) {
        // 不等 request 事件就結束：POST 的 body 還在抵達上游時就回應，會讓 client 看不到回應。
        response.end(JSON.stringify({ ok: true, method: request.method, url: request.url, body }));
        return;
      }
      response.write(JSON.stringify({ part: 1 }));
      response.flushHeaders();
      setTimeout(() => response.end(JSON.stringify({ part: 2 })), 2000);
    });
  });
  server.keepAliveTimeout = 0;
  sockets.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** 測試埠必須空閒：除錯遺留的代理會讓後續案例掛起，卻看起來像產品缺陷。 */
function assertPortFree(port: number) {
  return new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`port ${port} 已被占用；請先停止自己的 acceptance-proxy（pkill -f 'acceptance-proxy.ts --port ${port}'）再重跑`)));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

async function proxy(upstreamPort: number) {
  await assertPortFree(PROXY_PORT);
  const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-acceptance-proxy-')));
  states.push(state);
  const child = spawn(process.execPath, ['--import', loader, script, '--port', String(PROXY_PORT), '--upstream', `http://127.0.0.1:${upstreamPort}`, '--token', 'test-token', '--state', state], { cwd: web, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const transcript = path.join(state, 'transcript.log');
  files.push(transcript);
  const log = fs.createWriteStream(transcript);
  return new Promise<{ child: ChildProcess; state: string; control: (action: string, body?: Record<string, unknown>) => Promise<{ status: number; body: string }>; output: () => string }>((resolve, reject) => {
    let output = '';
    const deadline = setTimeout(() => { process.stderr.write('PROXY-OUTPUT ' + output + '\n'); reject(new Error(`T2 未在30s內 ready\n${output}`)); }, 30000);
    const record = (data: Buffer) => {
      const text = data.toString();
      log.write(text);
      output += text;
      for (const line of output.split('\n')) {
        if (line.startsWith('READY ')) {
          clearTimeout(deadline);
          resolve({
            child, state, output: () => output,
            control: (action, body) => new Promise((send, fail) => {
              const payload = JSON.stringify({ action, ...(body ?? {}) });
              const request = http.request({ port: PROXY_PORT, host: '127.0.0.1', path: '/__control', method: 'POST', agent: false,
                headers: { 'content-type': 'application/json', 'x-proxy-token': 'test-token', 'content-length': Buffer.byteLength(payload), connection: 'close' } }, (response) => {
                let text = '';
                response.on('data', (chunk) => { text += chunk; });
                response.on('end', () => send({ status: response.statusCode ?? 0, body: text }));
              });
              request.on('error', fail);
              request.end(payload);
            }),
          });
          return;
        }
      }
    };
    child.stdout!.on('data', record);
    child.stderr!.on('data', record);
    child.on('exit', (code) => { clearTimeout(deadline); reject(new Error(`T2 在 ready 前退出 code=${code}\n${output}`)); });
  });
}

function get(pathname: string) {
  // 每個案例都用新的 raw agent：abort 情境會留下已毀的 socket，Node fetch 的共用
  // keep-alive 池會重用它並把後續請求掛住（本批實測）。這是測試 harness，不是代理行為。
  return raw('GET', pathname);
}

/** 原始 http 請求：觀察代理原樣轉發的 status／headers／body，不受 fetch 的 CORS 標頭過濾與 keep-alive 池影響。 */
function raw(method: string, pathname: string, body?: string) {
  // 標頭一到就 resolve（response 是可讀串流）；`body` 自行 await response 的 'end'。
  // 若等到 end 才 resolve，串流案例量到的時間會是 upstream 的結束時間，證明不了「未緩衝」。
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; stream: import('node:stream').Readable }>((resolve, reject) => {
    const request = http.request({ port: PROXY_PORT, host: '127.0.0.1', path: pathname, method, agent: new http.Agent({ keepAlive: false }),
      headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, (response) => {
      resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error(`無回應（逾時）${method} ${pathname}`)));
    request.end(body);
  });
}

function readAll(stream: import('node:stream').Readable) {
  return new Promise<string>((resolve) => {
    let text = '';
    stream.on('data', (chunk) => { text += chunk; });
    stream.on('end', () => resolve(text));
  });
}

function firstChunk(stream: import('node:stream').Readable) {
  return new Promise<string>((resolve) => {
    stream.once('data', (chunk) => resolve(chunk.toString()));
  });
}

const post = (endpoint: string, body: unknown) => raw('POST', endpoint, JSON.stringify(body));

describe('T2：隔離驗收環境前的故障注入代理', () => {
  it('next GET 500 後恢復、GET 故障不擋 POST、abort／delay／streaming／query-body-header 與停止', async () => {
    const app = await upstream(upstreamPorts[0], 200);
    const instance = await proxy(upstreamPorts[0]);
    expect((await get('/api/v1/settings/class-name-report')).status).toBe(200);
    const injected = await instance.control('rules', { rules: [{ method: 'GET', path: '/api/v1/settings/class-name-report', action: 'status', status: 500, times: 1 }] });
    expect(injected.status, `規則注入被拒：${injected.body}`).toBe(200);
    expect((await get('/api/v1/settings/class-name-report')).status).toBe(500);
    expect((await get('/api/v1/settings/class-name-report')).status).toBe(200);
    const response = await post('/api/v1/settings/apply?x=1', { a: 1 });
    expect(response.status).toBe(200);
    expect(JSON.parse(await readAll(response.stream))).toMatchObject({ method: 'POST', url: '/api/v1/settings/apply?x=1', body: '{"a":1}' });
    expect(response.headers['x-upstream'], '代理原樣轉發上游標頭').toBe('yes');
    // 2 次 GET 到達上游（第1次 200；第2次被500規則攔下、不到上游）；之後 POST 不受 GET 規則影響。
    expect(app.hits).toEqual(['GET /api/v1/settings/class-name-report', 'GET /api/v1/settings/class-name-report', 'POST /api/v1/settings/apply?x=1']);
    await instance.control('rules', { rules: [{ method: 'POST', path: '/api/v1/settings/calculate', action: 'abort' }] });
    await expect(raw('POST', '/api/v1/settings/calculate', '{}')).rejects.toThrow();
    await instance.control('rules', { rules: [{ method: 'GET', path: '/api/v1/runs/current', action: 'delay', delayMs: 300 }] });
    const started = Date.now();
    expect((await get('/api/v1/runs/current')).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await instance.control('clear');
    const bad = await instance.control('rules', { rules: [{ method: 'GET', path: '/api/v1/x', action: 'status', status: 99999, times: 1 }] });
    expect(bad.status).toBe(400);
    expect(bad.body).toContain('status');
    // action=rules 帶空陣列＝清除所有規則（200）；未知 action＝400。
    expect((await instance.control('rules', { rules: [] })).status).toBe(200);
    expect((await instance.control('nonsense')).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${PROXY_PORT}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const exited = once(instance.child, 'exit');
    await instance.control('stop');
    await exited;
    await app.close();
    const output = instance.output();
    expect(output).toContain('HIT');
    expect(output).not.toContain('R3_');
    expect(output).not.toContain('"a":1');
  }, 60000);

  it('chunked streaming 第一片在 upstream 結束前抵達 client，且不緩衝', async () => {
    await upstream(upstreamPorts[1], 200, true);
    const instance = await proxy(upstreamPorts[1]);
    // 第一片必須在 upstream 結束前抵達（上游 400ms 才送第二片）；用時間戳證明「未被緩衝」。
    const firstAt = Date.now();
    const response = await get('/stream');
    expect(response.headers['transfer-encoding']).toBe('chunked');
    expect(await firstChunk(response.stream), '第一片應為 {"part":1}').toBe('{"part":1}');
    expect(Date.now() - firstAt, '第一片不可等到 upstream 結束才到').toBeLessThan(1500);
    response.stream.destroy();
    expect((await instance.control('stop')).status).toBe(200);
  }, 60000);

  it('拒絕 3000 upstream 與非法指令；缺檔時 CLI 真實失敗', () => {
    expect(cli(['--port', '3851', '--upstream', 'http://127.0.0.1:3000', '--token', 't']).stderr).toContain('3000');
    expect(cli(['--upstream', 'http://127.0.0.1:3300']).status).not.toBe(0);
    expect(cli(['--port', '3851', '--upstream', 'http://example.com', '--token', 't']).status).not.toBe(0);
  });
});
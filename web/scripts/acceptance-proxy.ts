import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import net from 'net';
import { randomUUID } from 'crypto';
import { assertIsolatedE2eTarget } from './e2e-isolation';

type Action = 'status' | 'abort' | 'delay';
interface Rule {
  method: string;
  path: string;
  action: Action;
  status?: number;
  delayMs?: number;
  times?: number;
}
interface Stored extends Rule {
  remaining: number | null;
}

const MAX_BODY = 64 * 1024;
const MAX_DELAY_MS = 60000;
const sockets = new Set<net.Socket>();
const timers = new Set<NodeJS.Timeout>();
const USAGE = `用法：npx tsx scripts/acceptance-proxy.ts --port 3200 --upstream http://127.0.0.1:3300 --token <token> [--state <記錄目錄>]
控制：POST /__control，帶 x-proxy-token；action 為 rules／clear／stop。
  {"action":"rules","rules":[{"method":"GET","path":"/api/v1/runs/current","action":"status","status":500,"times":1}]}
  {"action":"clear"} 清空全部規則（含持續規則）；{"action":"rules","rules":[]} 同樣清空。
  {"action":"stop"} 停止代理。
規則：method=GET／POST／PUT／PATCH／DELETE／HEAD；path=完整 pathname（不含 query／#）。
  action=status（status=400–599）／abort（中斷連線）／delay（delayMs=0–60000，可搭配 status）。
  times=1–1000；省略時持續生效。`;

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 3200;
  let upstream = '';
  let token = '';
  let state: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') return { help: true, port };
    if (flag === '--port' && args[index + 1]) port = Number(args[++index]);
    else if (flag === '--upstream' && args[index + 1]) upstream = args[++index];
    else if (flag === '--token' && args[index + 1]) token = args[++index];
    else if (flag === '--state' && args[index + 1]) state = args[++index];
    else throw new Error(USAGE);
  }
  if (!upstream || !token) throw new Error(`必須提供 --upstream 與 --token（token 不寫入檔案）\n${USAGE}`);
  return { help: false, port, upstream, token, state };
}

function validateRules(input: unknown): Stored[] {
  if (!Array.isArray(input)) throw new Error('rules 必須是陣列');
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('每條規則必須是物件');
    const rule = raw as Record<string, unknown>;
    const method = String(rule.method ?? '').toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) throw new Error(`method 不合法：${String(rule.method)}`);
    if (typeof rule.path !== 'string' || !rule.path.startsWith('/') || rule.path.includes('?') || rule.path.includes('#')) throw new Error('path 必須是以 / 開頭的完整 pathname，不含 query');
    const action = rule.action as Action;
    if (!['status', 'abort', 'delay'].includes(action)) throw new Error(`action 不合法：${String(rule.action)}`);
    if (action === 'status' && (!Number.isInteger(rule.status) || Number(rule.status) < 400 || Number(rule.status) > 599)) throw new Error('status 必須是400–599的整數');
    if (action === 'delay' && (!Number.isInteger(rule.delayMs) || Number(rule.delayMs) < 0 || Number(rule.delayMs) > MAX_DELAY_MS)) throw new Error(`delayMs 必須是0–${MAX_DELAY_MS}的整數`);
    if (rule.times !== undefined && (!Number.isInteger(rule.times) || Number(rule.times) < 1 || Number(rule.times) > 1000)) throw new Error('times 必須是1–1000的整數');
    return { method, path: rule.path, action, status: rule.status as number | undefined, delayMs: rule.delayMs as number | undefined, remaining: rule.times === undefined ? null : Number(rule.times) };
  });
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY) throw new Error('控制請求過大');
  }
  return body;
}

async function main() {
  const options = parseArgs();
  if (options.help) { console.log(USAGE); return; }
  const upstream = new URL(options.upstream as string);
  if (upstream.hostname !== '127.0.0.1' || upstream.protocol !== 'http:') throw new Error('upstream 必須是 http://127.0.0.1 的隔離環境（本工具不連外部服務、不連 operator 3000）');
  const upstreamPort = Number(upstream.port);
  assertIsolatedE2eTarget({ databasePath: path.join(os.tmpdir(), 'sb-acceptance-proxy-validation.sqlite'), port: upstreamPort });
  assertIsolatedE2eTarget({ databasePath: path.join(require('os').tmpdir(), 'sb-acceptance-proxy-validation.sqlite'), port: options.port });
  const selfOrigin = `http://127.0.0.1:${options.port}`;
  const upstreamOrigin = `http://${upstream.hostname}:${upstreamPort}`;
  /**
   * 僅當 incoming origin 與 proxy 自身 origin 相同才改寫；foreign／null／malformed 原樣，產品照舊 fail-closed。
   * 一律回傳 string：空字串是合法 client 值，必須原樣透傳——回傳 undefined 會被寫回 headers
   * 並使 http.request 於 setHeader 拋 ERR_HTTP_INVALID_HEADER_VALUE，終止整個 proxy（r1 B-1）。
   */
  const rewriteIfSelfOrigin = (value: string | string[]): string => {
    const text = Array.isArray(value) ? value[0] : value;
    if (text === undefined) return '';
    let parsed: URL;
    try { parsed = new URL(text); } catch { return text; }
    return parsed.origin === selfOrigin ? upstreamOrigin : text;
  };
  /** Referer 保留 path／query，只換 origin 部分（產品只比 host，但保留語意較可預期）；空字串同樣原樣透傳。 */
  const rewriteRefererIfSelfOrigin = (value: string | string[]): string => {
    const text = Array.isArray(value) ? value[0] : value;
    if (text === undefined) return '';
    let parsed: URL;
    try { parsed = new URL(text); } catch { return text; }
    return parsed.origin === selfOrigin ? upstreamOrigin + parsed.pathname + parsed.search + parsed.hash : text;
  };
  if (options.state) fs.mkdirSync(options.state, { recursive: true, mode: 0o700 });
  let rules: Stored[] = [];
  const hit = (rule: Stored, method: string, pathname: string) => {
    if (rule.remaining !== null) rule.remaining -= 1;
    rules = rules.filter((item) => item.remaining !== 0);
    // 只記 method／pathname／動作；不記 query、student body、token。
    console.log(`HIT ${method} ${pathname} action=${rule.action} at=${new Date().toISOString()}`);
  };

  const server = http.createServer((request, response) => {
    let outgoing: http.ClientRequest | undefined;
    let upstreamStream: http.IncomingMessage | undefined;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      request.unpipe();
      outgoing?.destroy();
      upstreamStream?.destroy();
      request.resume();
      if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
      else response.destroy();
    };
    // 每次請求自行處理例外；延後的 timer／串流 callback 也必須使用此邊界。
    const protect = (operation: () => void) => {
      if (failed) return;
      try { operation(); } catch { fail(); }
    };
    request.on('error', fail);
    response.on('error', fail);
    protect(() => {
      (request.socket as net.Socket).setNoDelay(true);
      sockets.add(request.socket);
      request.socket.once('close', () => { sockets.delete(request.socket); });
      const pathname = (request.url ?? '/').split('?')[0];
      if (pathname === '/__control') {
        // 控制請求本身不受注入規則影響，且只接受本機 token。
        if (request.method !== 'POST' || request.headers['x-proxy-token'] !== options.token) { response.writeHead(403).end('需要正確的 x-proxy-token'); return; }
        void readBody(request).then(async (body) => {
          let input: { action?: string; rules?: unknown; clear?: boolean };
          try { input = JSON.parse(body); } catch { response.writeHead(400).end('請提供合法JSON'); return; }
          if (input.clear) rules = [];
          if (input.rules !== undefined) rules = validateRules(input.rules);
          if (!input.action || !['rules', 'clear', 'stop'].includes(input.action)) {
            response.writeHead(400).end('未知 action；可用 rules／clear／stop');
            return;
          }
          if (input.action === 'clear') rules = [];
          if (input.action === 'rules' || input.action === 'clear') {
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, rules: rules.map((rule) => ({ method: rule.method, path: rule.path, action: rule.action, remaining: rule.remaining })) }));
            return;
          }
          if (input.action === 'stop') { response.writeHead(200).end('{"ok":true,"action":"stop"}'); shutdown(); return; }
        }).catch((error: unknown) => protect(() => { response.writeHead(400).end(error instanceof Error ? error.message : String(error)); }));
        return;
      }
      // 不緩衝：RSC／streaming／上傳 body 逐片原樣串接，socket 生命週期交給 Node。
      // client 的 expect:100-continue 由代理自己回 100，轉發時不再帶 expect：
      // 上游沒有 100 時 Node 的 http client 會中止請求，回應變成空標頭（實測 x-upstream 遺失）。
      // 其餘請求標頭（含 query、content-type）原樣轉發。
      const forward = () => protect(() => {
        const headers = { ...request.headers, host: `${upstream.hostname}:${upstreamPort}` };
        // Host 改為 upstream 後，瀏覽器帶的同源 Origin／Referer 會與 Host 不符而遭產品拒絕；
        // 只改寫「本來就會被拒」的 proxy 自身值（security.ts 比對的是 origin.host 與 Host）。
        if (headers.origin !== undefined) headers.origin = rewriteIfSelfOrigin(headers.origin);
        if (headers.referer !== undefined) headers.referer = rewriteRefererIfSelfOrigin(headers.referer);
        if (headers.expect) {
          delete headers.expect;
          // 用原生 write 而非 request.writeContinue()（後者要新版 ServerResponse 介面）：
          // client 等不到 100 就不送 body、也不讀回應，代理這邊只能靠 socket 直接回應。
          request.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        }
        outgoing = http.request({ host: upstream.hostname, port: upstreamPort, path: request.url, method: request.method, headers },
          (upstreamResponse) => {
            upstreamStream = upstreamResponse;
            upstreamResponse.on('error', fail);
            protect(() => {
              // 轉發回應時不要帶回 connection:close 這類 hop-by-hop 標頭，避免下游 client 中斷。
              const keep: http.OutgoingHttpHeaders = { ...upstreamResponse.headers };
              delete keep.connection;
              delete keep['keep-alive'];
              delete keep['transfer-encoding'];
              response.writeHead(upstreamResponse.statusCode ?? 502, keep);
              upstreamResponse.pipe(response);
            });
            if (failed) upstreamResponse.destroy();
          }).on('error', fail);
        request.pipe(outgoing);
      });
      const rule = rules.find((item) => item.method === request.method && item.path === pathname && (item.remaining === null || item.remaining > 0));
      if (!rule) {
        // 不緩衝：RSC／streaming／上傳 body 逐片原樣串接；socket 生命週期交給 Node，不自行提前結束。
        forward();
        return;
      }
      hit(rule, request.method ?? '', pathname);
      if (rule.action === 'abort') { request.socket.destroy(); return; }
      if (rule.action === 'delay') {
        const timer = setTimeout(() => {
          timers.delete(timer);
          protect(() => {
            if (rule.status !== undefined) {
              request.resume();
              request.on('end', () => protect(() => { response.writeHead(Number(rule.status), { 'content-type': 'application/json' }).end(JSON.stringify({ injected: true })); }));
            } else forward();
          });
        }, Number(rule.delayMs));
        timers.add(timer);
        return;
      }
      // status：回應前先收完 request body。實測：body 還在途就回應，Node client 等不到
      // 自己 socket 的半關閉，回應因此被中止（回頭看不到任何標頭）。
      request.resume();
      request.on('end', () => protect(() => { response.writeHead(Number(rule.status), { 'content-type': 'application/json' }).end(JSON.stringify({ injected: true, status: rule.status, at: randomUUID().slice(0, 8) })); }));
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.setTimeout(0);
  // 瀏覽器 / Next 會長連線重連；不能用 keep-alive timeout 提前砍掉正在串流的回應。
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    server.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    setTimeout(() => process.exit(0), 50).unref();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  console.log(`READY proxy=http://127.0.0.1:${options.port} upstream=${options.upstream} control=POST /__control (x-proxy-token)`);
  if (options.state) fs.writeFileSync(path.join(options.state, 'proxy-session.json'), JSON.stringify({ port: options.port, upstream: options.upstream, startedAt: new Date().toISOString() }), { mode: 0o600 });
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';

/**
 * #131：T1 session marker 不得成為控制端點的憑證。
 *
 * ## 這組測試在守什麼
 *
 * 控制端點（`POST /control`，unix socket）能對 T1 環境下 `restart`／`reset`／`stop`，
 * 其中 `reset` 會清空該 session 自己的 SQLite。修正前，授權比對是
 * `input.token !== session.token`，而 `session.token` 以明文寫進
 * `acceptance-session.json` 並在 T1 存活期間持續留在磁碟 —— 任何同使用者行程只要讀得到
 * 那個檔（state 目錄 0o700、marker 0o600，對同使用者的其他行程不構成阻礙）就能構造請求。
 *
 * 修正後 marker 只存 `sha256(token)`，明文只經由啟動時的 stdout 流過。
 *
 * ## 三個 case 的分工，以及各自「沒有」證明的事
 *
 * | case | 證明的命題 | 沒證明的事 |
 * |---|---|---|
 * | 1 | marker 檔內容不足以通過端點授權（實測送檔內值被拒） | 其他檔案沒被寫入 token（由 case 1 的目錄掃描補） |
 * | 2 | `--restart`／`--reset`／`--stop` 在雜湊制下仍可用（I2） | 控制端點的授權強度 |
 * | 3 | 格式不符的 marker 一律被拒，且拒的理由是格式而非「連不上」（I3） | 授權正確性 |
 *
 * 「marker 的 `token` 是 64 位 hex」這條斷言**編碼的是 operator 裁決的設計**
 * （marker 存雜湊），不是安全命題本身 —— 若日後改成「marker 完全不帶 token 欄位」
 * 的另一種設計，安全命題仍成立但這條會紅。它留在這裡是因為它讓「只有公開欄位改名、
 * 雜湊比對其實沒接上」這種假修正在 case 1 的線路探針之外多一道早期訊號。
 *
 * ## mutation 自檢（PR 描述有紀錄）
 *
 * 把 `authorize` 的雜湊比對改回 `sha256(input.token) === input.token` 之外等價的明碼比對、
 * 或讓 marker 改回寫明文，case 1 必須變紅。若不會紅，代表這組測試沒抓到重點。
 */
const web = path.resolve(__dirname, '../..');
const script = path.join(web, 'scripts/acceptance-env.ts');
const loader = path.join(web, 'node_modules/tsx/dist/loader.mjs');
const MARKER = 'acceptance-session.json';

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

const cli = (args: string[], repo = web, token?: string) =>
  spawnSync(process.execPath, ['--import', loader, script, ...args], {
    cwd: web, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ACCEPTANCE_SOURCE_DIR: repo, ...(token ? { ACCEPTANCE_TOKEN: token } : {}) },
  });

interface Session { token: string; state: string; database: string; workspace: string; url: string; source: string; }

/** 以真實來源 checkout（受測 worktree 自己）啟動一次 T1，回傳 READY 的內容。 */
function start(repo = web) {
  const child = spawn(process.execPath, ['--import', loader, script, '--port', '3845'], {
    cwd: web, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ACCEPTANCE_SOURCE_DIR: repo },
  });
  children.push(child);
  return new Promise<Session & { child: ChildProcess }>((resolve, reject) => {
    let output = '';
    const deadline = setTimeout(() => reject(new Error(`120s 內未 READY：\n${output}`)), 120000);
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
    child.on('exit', (code, signal) => { clearTimeout(deadline); reject(new Error(`T1 在 READY 前退出 code=${code} signal=${signal}\n${output}`)); });
  });
}

/** 直接送控制端點，繞過 CLI —— 用來驗「餵這份內容進端點會怎樣」，與 tooling 是否解析無關。 */
function postControl(state: string, body: unknown): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: path.join(state, 'control.sock'), path: '/control', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), connection: 'close' },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.setTimeout(20000, () => request.destroy(new Error('控制逾時')));
    request.on('error', reject);
    request.end(payload);
  });
}

/** 在暫存目錄寫一份「結構正確、來源正確，但 token／head 由呼叫端指定」的 marker。 */
function forgedState(token: string) {
  const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-forged-marker-')));
  states.push(state);
  fs.chmodSync(state, 0o700);
  fs.writeFileSync(path.join(state, MARKER), JSON.stringify({
    kind: 'student-billing-acceptance', token, source: fs.realpathSync(web),
    head: 'a'.repeat(40), port: 3845, state,
    database: path.join(state, 'app.sqlite'), workspace: path.join(state, 'web'),
    url: 'http://127.0.0.1:3845', stopped: false,
  }), { mode: 0o600 });
  return state;
}

describe('#131：marker 檔不得持有可直接控制端點的憑證', () => {
  it('marker 檔內的值無法通過端點授權；控制只認啟動 stdout 上的明文 token（I1）', async () => {
    const session = await start();
    const markerPath = path.join(session.state, MARKER);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

    // 明文 token 只從 stdout（READY 那一行的 JSON）取得。
    expect(session.token, 'READY 必須帶明文 token，否則控制流程無從取得憑證').toMatch(/^[0-9a-f-]{36}$/);

    // (a) 設計斷言：marker 存的是雜湊，不是明文。見檔頭「編碼的是設計」。
    expect(marker.token, 'marker 的 token 應為 sha256 hex（雜湊制），而非可用的明文').toMatch(/^[0-9a-f]{64}$/);
    expect(marker.token, 'marker 不得等於 stdout 上的明文 token').not.toBe(session.token);

    // (b) I1 的本體：整個 state 目錄不得有任何檔案含明文 token。
    //     這一條同時蓋掉「把 token 改寫到別的檔案」這種繞道。
    const offenders = fs.readdirSync(session.state)
      .filter((name) => fs.statSync(path.join(session.state, name)).isFile())
      .filter((name) => fs.readFileSync(path.join(session.state, name)).includes(session.token));
    expect(offenders, 'state 目錄內不得有任何檔案含明文 token').toEqual([]);

    // (c) 線路探針：把 marker 檔裡的東西原樣餵進端點，必須被拒。
    //     這才是 I1「不存在可直接用於控制端點的憑證」的直接量測 —— 只看檔案形狀
    //     會放過「欄位改名但比對仍是明碼」的假修正。
    const forged = await postControl(session.state, { action: 'stop', token: marker.token });
    expect(forged.status, `marker 內的值不得通過授權；實得 ${forged.status} ${forged.text}`).toBe(403);

    // (d) 對照組：stdout 上的明文仍能控制 —— 證明 (c) 的 403 不是「端點本來就壞」。
    //     這一步會真的停掉 session，因此放在最後。
    const handedOver = await postControl(session.state, { action: 'stop', token: session.token });
    expect(handedOver.status, `stdout 的明文 token 必須仍可控制；實得 ${handedOver.status} ${handedOver.text}`).toBe(200);
    await once(session.child, 'exit');
  }, 150000);

  it('--restart／--reset／--stop 三條流程不受影響（I2）', async () => {
    const session = await start();

    // --restart：服務重啟，DB 保留。明文 token 由**啟動的那一行**取得，與使用者的
    // 做法一致（讀 SESSION／READY 的 token 欄位，經環境變數帶給控制指令）。
    const restarted = cli(['--restart', '--state', session.state], web, session.token);
    expect(restarted.status, `--restart 必須成功：${restarted.stderr}`).toBe(0);
    expect(restarted.stdout, '--restart 必須回報 ok').toContain('ok');

    // 重啟後端點仍在，且憑證不變（token 只換了存放形式）。
    const alive = await fetch(session.url + '/api/v1/runs/current', { headers: { connection: 'close' } });
    expect(alive.status, 'restart 後服務必須活著').toBe(200);

    const stopped = cli(['--stop', '--state', session.state], web, session.token);
    expect(stopped.status, `--stop 必須成功：${stopped.stderr}`).toBe(0);
    await once(session.child, 'exit');
    expect(session.child.exitCode).toBe(0);

    // stop 後 --stop 冪等（I4）；--reset 則須報錯（既有語意）。
    const again = cli(['--stop', '--state', session.state], web, session.token);
    expect(again.status, '--stop 在已停止的 session 上必須冪等成功').toBe(0);
    const reset = cli(['--reset', '--state', session.state], web, session.token);
    expect(reset.status, '已停止的 session 不得被 reset').not.toBe(0);
    expect(reset.stderr).toContain('已停止');
  }, 200000);

  it('--reset 仍是「清空該 session 的 DB 並重啟」：端點回 ok、DB 確實歸零（I2）', async () => {
    const session = await start();
    // 先寫入一筆可觀察的狀態，否則「清空」無從證明（空 DB 清空後還是空的）。
    const draft = buildSeedDraft();
    draft.classes[0].teacher = '合成 marker 測試老師';
    const post = async (endpoint: string, body: unknown) => {
      const response = await fetch(session.url + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body),
      });
      expect(response.status, `${endpoint} 應為 200`).toBe(200);
      return response.json();
    };
    const preview = await post('/api/v1/settings/preview', { draft, expectedRevision: 0 });
    await post('/api/v1/settings/apply', { previewId: preview.previewId, expectedRevision: 0, idempotencyKey: 'marker-reset' });
    const before = await (await fetch(session.url + '/api/v1/settings/deductions', { headers: { connection: 'close' } })).json();
    expect(before.classes.some((item: { teacher: string }) => item.teacher === '合成 marker 測試老師'), '寫入必須生效，reset 才有東西可清').toBe(true);

    const reset = cli(['--reset', '--state', session.state], web, session.token);
    expect(reset.status, `--reset 必須成功：${reset.stderr}`).toBe(0);
    expect(reset.stdout, '--reset 必須回報 ok').toContain('ok');

    const after = await (await fetch(session.url + '/api/v1/settings/deductions', { headers: { connection: 'close' } })).json();
    expect(after.classes.some((item: { teacher: string }) => item.teacher === '合成 marker 測試老師'), '--reset 必須清空該 session 的 DB').toBe(false);

    expect(cli(['--stop', '--state', session.state], web, session.token).status, '--stop 收尾').toBe(0);
    await once(session.child, 'exit');
  }, 200000);

  it('格式不符的 marker 一律被拒，且拒的理由是 marker 本身而非連不上 socket（I3）', () => {
    // token 不是 32 位 hex → 格式檢查擋下（訊息來自 readSession）。
    const malformed = cli(['--stop', '--state', forgedState('not-a-hash')]);
    expect(malformed.status, '格式不符的 token 不得放行').not.toBe(0);
    expect(malformed.stderr).toMatch(/marker 識別不符/);

    // 舊制遺留的 UUID：雜湊制下不再是合法格式（不被解讀成 sha256 hex）。
    const legacy = cli(['--stop', '--state', forgedState(randomUUID())]);
    expect(legacy.status, '舊制 UUID 不得被當成合法 marker token').not.toBe(0);
    expect(legacy.stderr).toMatch(/marker 識別不符/);

    // 格式正確（64 位 hex）但並非任何存活 session 的雜湊：格式檢查放行，
    // 真正的防線是「socket 不存在／只能由所屬程序提供控制」。斷言的重點是
    // **拒絕的理由**：不得是 marker 識別失敗，而必須是連線失敗。
    // 若哪天有人把授權退回「只比對 marker 內容」，這一條會先於安全問題本身變紅。
    const unused = cli(['--stop', '--state', forgedState('b'.repeat(64))]);
    expect(unused.status, '不存在的 session 不得被控制').not.toBe(0);
    expect(unused.stderr, '格式正確的 marker 不該由格式檢查擋下（那會讓本 case 失去區辨力）')
      .not.toMatch(/marker 識別不符/);
  }, 60000);
});

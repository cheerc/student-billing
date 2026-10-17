import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

/**
 * #130 守門測試：next.config.ts 的 T1 型別檢查豁免必須是**兩個條件同時成立**。
 *
 * 閘控一旦被改成單條件（只認 ACCEPTANCE_ENV），T1 的 env 物件被同源腳本繼承時
 * 就會意外開啟 —— 而跳過型別檢查是會讓真實型別錯誤溜過的 gate。本測試存在的理由
 * 就是讓那個回歸變紅。
 *
 * ## 判準為什麼是 exit code，不是輸出字串
 *
 * 三個 case 都注入**同一個真實型別錯誤**（`TYPE_ERROR_PROBE`），再以 build 的
 * exit code 判斷閘控是否放行：
 *
 * | 條件 | build | 意義 |
 * |---|---|---|
 * | 閘控關閉（應擋） | exit ≠ 0 | 型別錯誤確實被擋下 |
 * | 閘控開啟（應放行） | exit = 0 | 型別錯誤確實被靜默放行 |
 *
 * 早期版本以「輸出是否含 `Skipping validation of types`」為判準，那是**空洞斷言**：
 * build 因語法錯誤、缺依賴或任何其他原因失敗時輸出裡同樣沒有該字串，負向 case 照樣
 * 綠。exit code 是二元且互斥的答案，不會被無關的失敗模式偽裝成通過。
 * 輸出字串只留作失敗訊息，不再作為斷言依據。
 *
 * 三個 case 用同一份注入，於是同一個型別錯誤在三種條件下得到三種結果 —— 那才是完整
 * 的證明，也讓它們互為對照。
 *
 * 兩條 mutation 都必須能被抓到（已實測）：
 *   - 移除條件 1（ACCEPTANCE_ENV）→ 正面 case 紅（型別錯誤不再被放行）
 *   - 移除條件 2（marker 存在）→ 負向 case 紅（繼承逃逸時被誤放行）
 *
 * 本測試**不**涵蓋「marker 存在但內容錯誤」：marker 的 JSON 內容不參與判斷，
 * 測試名稱不得承諾它偵測不到的東西。
 */
const web = path.resolve(__dirname, '../..');

/** 真實的型別錯誤：字串賦給 number，tsc 必報 TS2322。 */
const TYPE_ERROR_PROBE = 'export const __typeErrProbe: number = "not a number";\n';

/**
 * 在暫存目錄組一個可 build 的最小 Next 專案，回傳其路徑。
 *
 * 用真實檔案系統而非純字串推導：`process.cwd()` 與 marker 的相對位置關係是本測試
 * 的核心前提，用臨時目錄實跑才能證明條件 2 的行為符合預期。
 */
function fixture(workspace: string, opts: { marker: boolean; markerDepth?: number }) {
  fs.mkdirSync(workspace, { recursive: true });
  // next.config.ts 複製真實檔案 —— 測的是實際會跑的那份，不是複製品
  fs.copyFileSync(path.join(web, 'next.config.ts'), path.join(workspace, 'next.config.ts'));
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'gate-fixture', version: '1.0.0', private: true }),
  );
  fs.writeFileSync(
    path.join(workspace, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
    }),
  );
  fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app/page.tsx'), 'export default function P() { return <div>probe</div>; }\n');
  // 探針放進 lib/：tsc 的 include（`**/*.ts`）會讀它，但 Turbopack 不會編譯它 ——
  // 放進 app/ 會讓編譯階段就先失敗（Ecmascript file had an error），那會讓三個 case
  // 都紅，且失敗原因不是型別錯誤，等於測不到閘控。
  fs.mkdirSync(path.join(workspace, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'lib/type-probe.ts'), TYPE_ERROR_PROBE);
  // 不用 symlink：Turbopack 會 panic「Symlink ... points out of the filesystem root」
  // （CLAUDE.md §8）。
  //
  // 複製方式依平台分流：macOS 用 `cp -Rc`（APFS clone，CLAUDE.md §8 記載的手段，實測
  // 531MB 約 8 秒），Linux 用 `cp -R`。**僅為資源準備手段差異，兩者皆執行後續相同的
  // 真實 `next build`，故閘控行為在兩個平台都被驗證。**
  //
  // 不採 fallback（先試 -Rc 失敗再改 -R）：fallback 在 CI 每次都會先失敗一次並輸出
  // `cp: invalid option -- 'c'`，讓未來讀 CI log 的人每次都要重新判斷那是預期還是新問題。
  // 也不採 fs.cpSync：跨平台但沒有 clone 加速，531MB 會變成完整複製；而它的
  // `{ clone: true }` 選項實測報 ERR_FS_CP_EINVAL（Node 不支援該選項）。
  const cloneFlag = process.platform === 'darwin' ? '-Rc' : '-R';
  execFileSync('cp', [cloneFlag, path.join(web, 'node_modules'), path.join(workspace, 'node_modules')]);
  if (opts.marker) {
    // markerDepth=1（預設）寫在相鄰上一層，也就是 T1 真實的 state/ 對 state/web/ 關係。
    // markerDepth=2 往上多一層，用來區分「嚴格 dirname(cwd)」與「任意祖先層級搜尋」——
    // 後者會在這種 fixture 上誤判通過。
    const markerDir = opts.markerDepth === 2
      ? path.dirname(path.dirname(workspace))
      : path.dirname(workspace);
    fs.writeFileSync(path.join(markerDir, 'acceptance-session.json'), '{"kind":"student-billing-acceptance"}');
  }
  return workspace;
}

interface BuildResult {
  /** build 是否以 exit 0 結束 —— 這是判斷閘控是否放行型別錯誤的唯一依據。 */
  ok: boolean;
  output: string;
  /**
   * 逾時是**獨立狀態**，不可併入 ok=false。
   *
   * 若逾時也回傳 { ok: false }，負向 case 的「exit 不為 0」斷言會把它誤判為通過 ——
   * 那等於重新引入上一輪被 reviewer 打回的那種空洞斷言。逾時必須讓測試明確失敗，
   * 並說明是逾時而非型別錯誤。
   */
  timedOut?: boolean;
  /** output 是否已截斷（超過 OUTPUT_LIMIT），讓診斷知道看到的不是全部。 */
  truncated?: boolean;
}

/** build 逾時上限。實測正常 build 需 10–26 秒，180s 有充分餘裕。 */
const BUILD_TIMEOUT_MS = 180_000;

/**
 * output 上限，對應舊版 execFileSync 的 maxBuffer（16MB）。
 *
 * 改用 spawn 後必須自己重新建立上限，否則四個 case 各持一份完整 build log，
 * CI runner 記憶體較小時是真實風險。
 */
const OUTPUT_LIMIT = 16 * 1024 * 1024;

/**
 * 非同步跑 build。
 *
 * 用 spawn 而非 execFileSync：同步版本會把 worker 主執行緒整段阻塞住，最長可達
 * 數十秒（實測每個 case 10–26 秒），期間 worker 無法回應 vitest 的 RPC 心跳，
 * 會冒出 `[vitest-worker]: Timeout calling "onTaskUpdate"` 的 unhandled error。
 * 那個錯誤不影響斷言結果，但會讓測試輸出出現與被測行為無關的紅字 —— 那是噪音，
 * 掩蓋真正該看的失敗訊息。
 */
function build(workspace: string, env: NodeJS.ProcessEnv): Promise<BuildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(workspace, 'node_modules/next/dist/bin/next'), 'build'], {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let truncated = false;
    const append = (chunk: Buffer) => {
      const next = stdout + chunk.toString();
      if (next.length <= OUTPUT_LIMIT) {
        stdout = next;
        return;
      }
      // 保留**頭尾兩段**，不只留頭：TS 診斷在建置早期出現，但 Turbopack 的進度輸出
      // 可能很多，而帶行號的診斷行可能落在輸出的中段 —— 只留頭部會讓
      // /TS\d+/ 斷言失效，而那正是這個測試用來區分「型別錯誤被擋」與「build 因無關
      // 原因失敗」的唯一訊號。
      const half = Math.floor(OUTPUT_LIMIT / 2);
      stdout = `${next.slice(0, half)}\n...[輸出已截斷，保留頭尾各 ${half} 字元]...\n${next.slice(-half)}`;
      truncated = true;
    };

    const timer = setTimeout(() => {
      // 先殺再等退出，不可 timeout 一到就直接 settle —— 否則 child 還在跑而 Promise
      // 已回傳，那會留下佔用 CPU 的行程，並讓「逾時」與「build 失敗」在結果上同形。
      child.kill('SIGTERM');
      const grace = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('close', () => {
        clearTimeout(grace);
        clearTimeout(timer);
        resolve({ ok: false, output: stdout, timedOut: true, truncated });
      });
    }, BUILD_TIMEOUT_MS);

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: stdout, truncated });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${stdout}\n${error.message}`, truncated });
    });
  });
}

/**
 * 逾時必須讓斷言明確失敗並說明是逾時。
 *
 * 沒有這道閘，逾時回傳的 ok:false 會被「exit 不為 0」的斷言當成通過 —— build 因為
 * 沒跑完而失敗，與 build 因型別錯誤而失敗，在結果上無法區分。
 */
function assertNotTimedOut(result: BuildResult) {
  expect(result.timedOut, 'build 逾時（180s）——這不是型別錯誤的結果，測試環境有問題').toBeUndefined();
}

/** 失敗時附上 build 輸出尾段 —— 只為讓診斷可讀，不參與判定。 */
function tail(result: BuildResult) {
  const parts = [`\n--- build 輸出（判定依據是 exit code，這裡僅供診斷）---`];
  // 四種失敗要能從訊息裡分出來，否則排查時會把「build 沒跑到那裡」誤讀成
  // 「沒有型別診斷」—— 一個正確但誤導的失敗訊息會浪費下一輪時間。
  if (result.timedOut) parts.push('[結果] 逾時終止：build 未跑完，不代表型別檢查擋下了什麼');
  else if (result.ok) parts.push('[結果] build 成功：閘控放行了型別錯誤');
  else if (/TS\d+/.test(result.output)) parts.push('[結果] build 失敗且含 TS 診斷：型別錯誤被擋下');
  else parts.push('[結果] build 失敗但無 TS 診斷：失敗原因與型別無關（語法錯誤或缺依賴）');
  if (result.truncated) parts.push('[注意] output 超過上限，已保留頭尾兩段');
  parts.push(result.output.slice(-1200));
  return parts.join('\n');
}

describe('#130：T1 型別檢查豁免必須兩條件同時成立', () => {
  it('兩條件同時成立時放行：注入的型別錯誤不擋 build（exit 0）', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb130-both-')));
    const workspace = fixture(path.join(root, 'state', 'web'), { marker: true });
    const result = await build(workspace, { ...process.env, ACCEPTANCE_ENV: '1' });
    // T1 路徑：閘控開啟 → 真實型別錯誤被靜默放行。
    expect(result.ok, `T1 路徑（env + marker）應跳過型別檢查，型別錯誤不應擋下 build${tail(result)}`).toBe(true);
  }, 200_000);

  it('無 ACCEPTANCE_ENV 時不豁免：注入的型別錯誤擋下 build（exit ≠ 0）', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb130-none-')));
    // marker 刻意存在：證明即使結構條件成立，缺 env 也不豁免。
    const workspace = fixture(path.join(root, 'state', 'web'), { marker: true });
    const env = { ...process.env };
    delete env.ACCEPTANCE_ENV;
    const result = await build(workspace, env);
    assertNotTimedOut(result);
    expect(result.ok, `無 ACCEPTANCE_ENV 時不得豁免，型別錯誤必須擋下 build${tail(result)}`).toBe(false);
    expect(result.output, '失敗必須來自型別診斷（TS####），否則可能只是 build 因無關原因失敗').toMatch(/TS\d+/);
  }, 200_000);

  it('marker 在更上層但非相鄰上一層時不豁免（守住 dirname 的嚴格性）', async () => {
    // 這個 case 存在的理由：`path.dirname(cwd)` 與「向上逐層搜尋 marker」在三個基本
    // fixture 上行為完全相同（marker 都在相鄰上一層），所以前三個 case 分不出來 ——
    // 實測把條件 2 改成 ancestor walk 時它們全綠。這個 fixture 把 marker 往上多挪一層，
    // 兩種實作才會產生不同結果。
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb130-deep-')));
    // cwd = <root>/state/web，相鄰上一層是 <root>/state/；marker 放在 <root>/。
    const workspace = fixture(path.join(root, 'state', 'web'), { marker: true, markerDepth: 2 });
    const result = await build(workspace, { ...process.env, ACCEPTANCE_ENV: '1' });
    assertNotTimedOut(result);
    expect(result.ok, `marker 不在相鄰上一層時不得豁免 —— 條件 2 必須嚴格限定 dirname(cwd)${tail(result)}`).toBe(false);
    expect(result.output, '失敗必須來自型別診斷（TS####）').toMatch(/TS\d+/);
  }, 200_000);

  it('有 ACCEPTANCE_ENV 但上一層無 marker 時不豁免：注入的型別錯誤擋下 build（exit ≠ 0）', async () => {
    // 這條是核心：只靠條件 1 會被繼承開啟；marker 條件才是真正關住它的那道閘。
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb130-nomarker-')));
    const workspace = fixture(path.join(root, 'state', 'web'), { marker: false });
    const result = await build(workspace, { ...process.env, ACCEPTANCE_ENV: '1' });
    assertNotTimedOut(result);
    expect(result.ok, `缺少 marker 時不得豁免（繼承逃逸情境），型別錯誤必須擋下 build${tail(result)}`).toBe(false);
    expect(result.output, '失敗必須來自型別診斷（TS####），否則可能只是 build 因無關原因失敗').toMatch(/TS\d+/);
  }, 200_000);
});

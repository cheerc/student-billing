import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * #130 守門測試：next.config.ts 的 T1 型別檢查豁免必須是**兩個條件同時成立**。
 *
 * 閘控一旦被改成單條件（只認 ACCEPTANCE_ENV），T1 的 env 物件被同源腳本繼承時
 * 就會意外開啟 —— 而跳過型別檢查是會讓真實型別錯誤溜過的 gate。本測試存在的理由
 * 就是讓那個回歸變紅。
 *
 * 兩條 mutation 都必須能被抓到（已實測）：
 *   - 移除條件 1（ACCEPTANCE_ENV）→ 「兩者皆具才開啟」變紅
 *   - 移除條件 2（marker 存在）→ 「僅條件 1 時必須關閉」變紅
 *
 * 本測試**不**涵蓋「marker 存在但內容錯誤」：marker 的 JSON 內容不參與判斷，
 * 測試名稱不得承諾它偵測不到的東西。
 *
 * 判定方式刻意用「真的跑 next build」而非靜態比對程式碼文字：靜態比對只能證明
 * 字串在檔案裡，證明不了閘控真的生效，而這正是 #105 記下的教訓（只看錯誤訊息第一
 * 行就下結論）。build 輸出是這裡唯一可觀察的裁判。
 */
const web = path.resolve(__dirname, '../..');

/**
 * 在暫存目錄組一個可 build 的最小 Next 專案，回傳其 next.config.ts 路徑。
 *
 * 用真實檔案系統而非純字串推導：`process.cwd()` 與 marker 的相對位置關係是本測試
 * 的核心前提，用臨時目錄實跑才能證明條件 2 的行為符合預期。
 */
function fixture(workspace: string, opts: { marker: boolean; env: boolean }) {
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
  if (opts.marker) fs.writeFileSync(path.join(path.dirname(workspace), 'acceptance-session.json'), '{"kind":"student-billing-acceptance"}');
  return workspace;
}

function build(workspace: string, env: NodeJS.ProcessEnv) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(workspace, 'node_modules/next/dist/bin/next'), 'build'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 180_000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 24,
    });
    // 閘控開啟與否的證據在 stdout 裡 —— build 成功不代表輸出是空的。
    return { ok: true, output: stdout };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

/** build 是否跳過了型別檢查 —— 這才是閘控是否開啟的可觀察結果。 */
function skippedTypecheck(output: string) {
  return /Skipping validation of types/.test(output);
}

describe('#130：T1 型別檢查豁免必須兩條件同時成立', () => {
  it('無 ACCEPTANCE_ENV 時不豁免，即使 marker 存在於上一層', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb130-none-')));
    const workspace = fixture(path.join(root, 'state', 'web'), { marker: true, env: false });
    const env = { ...process.env };
    delete env.ACCEPTANCE_ENV;
    const result = build(workspace, env);
    expect(skippedTypecheck(result.output), '無 ACCEPTANCE_ENV 時不得跳過型別檢查').toBe(false);
  }, 200_000);

  it('有 ACCEPTANCE_ENV 但上一層無 marker 時不豁免（繼承逃逸情境）', () => {
    // 這條是核心：只靠條件 1 會被繼承開啟；marker 條件才是真正關住它的那道閘。
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb130-nomarker-')));
    const workspace = fixture(path.join(root, 'state', 'web'), { marker: false, env: true });
    const env = { ...process.env, ACCEPTANCE_ENV: '1' };
    const result = build(workspace, env);
    expect(skippedTypecheck(result.output), '缺少 marker 時不得跳過型別檢查').toBe(false);
  }, 200_000);

  it('兩條件同時成立時才豁免', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb130-both-')));
    const workspace = fixture(path.join(root, 'state', 'web'), { marker: true, env: true });
    const env = { ...process.env, ACCEPTANCE_ENV: '1' };
    const result = build(workspace, env);
    expect(skippedTypecheck(result.output), 'T1 路徑（env + marker）應跳過型別檢查').toBe(true);
  }, 200_000);
});

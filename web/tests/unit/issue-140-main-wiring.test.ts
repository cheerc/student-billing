import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeSyntheticBillingReport, writeSyntheticSessionsReport } from '../helpers/synthetic-report-xlsx';

/**
 * issue #140 第 1 項：`main()` 的快照接線。
 *
 * ## 為什麼單元測試抓不到這條
 *
 * `rateContext = run?.classCategories ? { isV3Run: true, … } : undefined`
 * （`compare-billing-report.mjs`、`compare-session-pricing-report.mjs` 各一行）
 * 是「快照真的被傳進 `compare()`」的唯一接線。既有單元測試**恆以顯式參數**
 * 呼叫 `compare()`，所以把這一行改成 `undefined` 不會讓任何測試轉紅——
 * 測到的是「有人手動餵快照時對不對」，不是「工具自己會不會去拿快照」。
 *
 * ## 這裡怎麼測
 *
 * 直接跑真正的 `main()`：以 `tsx --import` 注入一個 fetch stub，把
 * `/runs/current`、`/runs/{id}`、`/students` 換成受控回應，跑完讀輸出的 HTML。
 * 因此測的是**未經改寫的產品工具**，不是複本。
 *
 * ## 判讀槓桿
 *
 * 快照的 `category` **可以被維護者手動覆寫**（CLAUDE.md §9.3）：即「班名本身會映射到
 * 甲的類別，快照卻說乙」。工具若真的把快照傳進 `compare()`，適用率就由**快照**決定；
 * 接線一斷，適用率會退回**名稱映射**。兩者取到不同的學生層欄位，於是報表寫哪個折數
 * 就會得到相反的結論。
 *
 *   | | 快照（category: math） | 接線斷（名稱映射） |
 *   |---|---|---|
 *   | 國小輔導工具 | `applicableMathBps` = 8500 | `applicableTutoringBps` = 8888 |
 *   | 按堂計價工具 | `applicableMathBps` = 8500 | `applicableEnglishBps` = 8000 |
 *
 * 報表寫「課程費 85折」（＝8500，在報表白名單內）時：
 *   - 接線正常 → 8500 vs 8500 → `MATCH`
 *   - 接線失效 → 8888／8000 vs 8500 → `DISCOUNT_DIFF`
 *
 * 兩者結論相反，且**只由「API 有沒有回 classCategories」這一個變因決定**。
 * 這同時就是 #122 的第二個分歧面（`category` 被手動覆寫），不只是固定 5 天。
 *
 * 測試資料全為合成字串（`測試生`／`115國小輔導-三年級`），不含任何真實個資（CLAUDE.md §3）。
 */

const WEB_DIR = path.resolve(__dirname, '..', '..');

/**
 * 「名冊班名」與「報表明細上的班名」是兩個東西：
 *   - 名冊班名（＝快照 `base_name`）不含修飾，工具端以 `baseClassName` 去修飾後查快照；
 *   - 報表明細把級距寫在同一欄（`[團][3]`），`parseTuition` 從這裡讀週收費天數。
 * 兩者刻意分開，才驗得到「去修飾後查得到快照」這條路徑。
 */
const CARE_CLASS = '115國小輔導-三年級';
const CARE_CLASS_TOKEN = '115國小輔導-三年級[團][3]';
const ENGLISH_CLASS = '兒童美語-A';

/** 報表白名單裡可解析的折數：`課程費 85折` → 8500（`RATE_PATTERNS`）。 */
const REPORT_RATE_DETAIL = '課程費 85折';
const REPORT_RATE_BPS = 8500;
/** 週收費天數：名冊的 `tutoringDays` 與報表級距 `[3]` 必須一致，才把變因鎖在「適用率」那一維。 */
const WEB_DAYS = 3;

/** 取自 HTML 的 `data-cat`，即每一列的比對結果分類。 */
function statusCategories(html: string): string[] {
  return [...html.matchAll(/data-cat="([A-Z_]+)"/g)].map((m) => m[1]!);
}

function writeFetchStub(stubPath: string, runBody: Record<string, unknown>, students: unknown[]): void {
  fs.writeFileSync(
    stubPath,
    `const RUN = ${JSON.stringify(runBody)};
const STUDENTS = ${JSON.stringify(students)};
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  if (u.includes('/api/v1/runs/current')) return json({ activeRunId: 'run_v3', run: { id: 'run_v3' } });
  if (u.includes('/students')) return json({ items: STUDENTS, nextCursor: null });
  if (u.includes('/api/v1/runs/')) return json(RUN);
  throw new Error('未預期的 URL：' + u);
};
`,
    'utf8'
  );
}

function runTool(
  script: string,
  args: string[],
  stubPath: string,
  tmp: string
): { status: number; html: string; output: string } {
  const outPath = path.join(tmp, 'out.html');
  fs.rmSync(outPath, { force: true });
  const res = spawnSync(
    'npx',
    ['tsx', '--import', `file://${stubPath}`, path.join('scripts', script), ...args, '--out', outPath],
    { cwd: WEB_DIR, encoding: 'utf8' }
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0) throw new Error(`工具非零結束（${res.status}）：\n${output}`);
  return { status: res.status ?? 1, html: fs.readFileSync(outPath, 'utf8'), output };
}

/** 名冊學生：`enrollments` 決定工具端取哪個班名去查快照。 */
function rosterStudent(enrollments: string[], overrides: Record<string, unknown> = {}) {
  return {
    personCode: 'S001',
    name: '測試生',
    grade: 4,
    gradeRaw: '4年級',
    baseDiscountBps: 10000,
    enrollments: enrollments.map((baseName) => ({
      rawToken: baseName,
      baseName,
      erpBillingTier: 3,
      withdrawalDate: null,
    })),
    // 國小輔導工具的「天數」取這裡（`w.tutoringDays`），**不經過快照**——
    // 故本測試的天數恆為 3，用來把變因鎖在「適用率」那一維。
    anqinDays: WEB_DAYS,
    anqinDisplay: String(WEB_DAYS),
    tutoringDays: WEB_DAYS,
    tutoringDisplay: String(WEB_DAYS),
    trace: { rawTags: '', careDays: { tutoring: { isEnrolled: true, status: 'ok', hasExtraFlag: false } } },
    applicableAnqinBps: 9500,
    applicableTutoringBps: 8888,
    applicableMathBps: REPORT_RATE_BPS,
    applicableEnglishBps: 8000,
    applicableBaseBps: 10000,
    ...overrides,
  };
}

/** v3 run 的回應；`snapshots` 為 `undefined` 時**整欄不帶**（模擬 API 未回傳）。 */
function runV3Body(snapshots?: Array<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: 'run_v3',
    asOfDate: '2026-10-01',
    ruleSetVersion: 'erp-tag-v3',
    numericPolicy: 'v1',
  };
  if (snapshots) body.classCategories = snapshots;
  return body;
}

/**
 * 快照列：兩個班的 `category` 都被**手動覆寫成 `math`**。
 *
 * 這是關鍵設定——班名本身映射到別的類別，只有快照說 math：
 *   - `115國小輔導-三年級` → `rateCategoryOfClass` 給 `care`，快照說 `math`
 *   - `兒童美語-A`         → `rateCategoryOfClass` 給 `english`，快照說 `math`
 * 因此「有沒有走快照」在適用率上必然可辨（分別是 8888／8000 對 8500）。
 */
const OVERRIDDEN_ROWS = [
  { base_name: CARE_CLASS, category: 'math', fixed_five_days: 0 },
  { base_name: ENGLISH_CLASS, category: 'math', fixed_five_days: 0 },
];

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-i140-main-'));
});

describe('issue #140 第 1 項：`main()` 的快照接線（國小輔導工具）', () => {
  const reportPath = () => path.join(tmp, 'billing-report.xlsx');

  it('v3 run 帶快照：main() 把快照傳進 compare()（快照說 math → 8500，對上報表 85折 → MATCH）', async () => {
    await writeSyntheticBillingReport(reportPath(), { className: CARE_CLASS_TOKEN, rateDetail: REPORT_RATE_DETAIL });
    const stub = path.join(tmp, 'billing-stub-a.mjs');
    writeFetchStub(stub, runV3Body(OVERRIDDEN_ROWS), [rosterStudent([CARE_CLASS])]);

    const { html } = runTool(
      'compare-billing-report.mjs',
      ['--xlsx', reportPath(), '--base', 'http://127.0.0.1:1'],
      stub,
      tmp
    );
    // 接線正常：走快照 → math → 8500，與報表 8500 一致。
    // 接線若斷：退回名稱映射的 care → applicableTutoringBps 8888 → DISCOUNT_DIFF。
    expect(statusCategories(html)).toEqual(['MATCH']);
  });

  it('v3 run 但 API 未回 classCategories：不可回退名稱映射，標為 WEB_RATE_NOT_CONFIGURED', async () => {
    await writeSyntheticBillingReport(reportPath(), { className: CARE_CLASS_TOKEN, rateDetail: REPORT_RATE_DETAIL });
    const stub = path.join(tmp, 'billing-stub-b.mjs');
    writeFetchStub(stub, runV3Body(undefined), [rosterStudent([CARE_CLASS])]);

    const { html } = runTool(
      'compare-billing-report.mjs',
      ['--xlsx', reportPath(), '--base', 'http://127.0.0.1:1'],
      stub,
      tmp
    );
    // snapshot-capable run 若 API 漏回快照，必須 fail closed，不用今天的班名猜測。
    expect(statusCategories(html)).toEqual(['WEB_RATE_NOT_CONFIGURED']);
  });

  it('v3 run 的快照查無該班：不得靜默，標為 WEB_RATE_NOT_CONFIGURED（D17）', async () => {
    await writeSyntheticBillingReport(reportPath(), { className: CARE_CLASS_TOKEN, rateDetail: REPORT_RATE_DETAIL });
    // 快照只有另一個班，名冊學生卻有輔導班 → 走得到快照分支，但查無該班
    const stub = path.join(tmp, 'billing-stub-c.mjs');
    writeFetchStub(stub, runV3Body([{ base_name: '115國小輔導-四年級', category: 'math', fixed_five_days: 0 }]), [
      rosterStudent([CARE_CLASS]),
    ]);

    const { html } = runTool(
      'compare-billing-report.mjs',
      ['--xlsx', reportPath(), '--base', 'http://127.0.0.1:1'],
      stub,
      tmp
    );
    // 不得落回「無折扣」也不得略過：該列必須存在且被顯眼標記
    expect(statusCategories(html)).toEqual(['WEB_RATE_NOT_CONFIGURED']);
  });
});

describe('issue #140 第 1 項：`main()` 的快照接線（按堂計價工具）', () => {
  const reportPath = () => path.join(tmp, 'sessions-report.xlsx');

  it('v3 run 帶快照：main() 把快照傳進 compare()（快照說 math → 8500 → MATCH）', async () => {
    await writeSyntheticSessionsReport(reportPath(), {
      tuitionRows: [`${ENGLISH_CLASS}[團] - 16 堂課`],
      rateDetail: `${ENGLISH_CLASS}[團] - ${REPORT_RATE_DETAIL}`,
    });
    const stub = path.join(tmp, 'sessions-stub-a.mjs');
    writeFetchStub(stub, runV3Body(OVERRIDDEN_ROWS), [
      // 本測試走 v3 快照路徑：`resolveApplicableRate` 只判 `ctx.isV3Run`
      // （compare-session-pricing-report.mjs:313），**沒有**「該生有無國小輔導班」這道閘門。
      // 名冊的 enrollment 內容因此不影響本斷言——實測把本行清成 `rosterStudent([])`
      // 仍 5/5 綠；CARE_CLASS 只讓名冊反映真實多班學生。
      rosterStudent([ENGLISH_CLASS, CARE_CLASS]),
    ]);

    const { html } = runTool(
      'compare-session-pricing-report.mjs',
      ['--xlsx', reportPath(), '--base', 'http://127.0.0.1:1'],
      stub,
      tmp
    );
    expect(statusCategories(html)).toEqual(['MATCH']);
  });

  it('v3 run 但 API 未回 classCategories：不可回退名稱映射，標為 WEB_RATE_NOT_CONFIGURED', async () => {
    await writeSyntheticSessionsReport(reportPath(), {
      tuitionRows: [`${ENGLISH_CLASS}[團] - 16 堂課`],
      rateDetail: `${ENGLISH_CLASS}[團] - ${REPORT_RATE_DETAIL}`,
    });
    const stub = path.join(tmp, 'sessions-stub-b.mjs');
    writeFetchStub(stub, runV3Body(undefined), [rosterStudent([ENGLISH_CLASS, CARE_CLASS])]);

    const { html } = runTool(
      'compare-session-pricing-report.mjs',
      ['--xlsx', reportPath(), '--base', 'http://127.0.0.1:1'],
      stub,
      tmp
    );
    expect(statusCategories(html)).toEqual(['WEB_RATE_NOT_CONFIGURED']);
  });
});

import ExcelJS from 'exceljs';
import { expect, type Page } from '@playwright/test';

/**
 * B2 E2E 共用：全合成名冊（不含任何真實資料）與 API 對照工具。
 *
 * 名冊由測試內建，可獨立手算（specs/04 UX25／UX28／UX29）：
 *   - 共 210 人，代碼 B2E_0000…B2E_0209（依代碼排序，前 50 人為第一頁）；
 *   - 預設班 `國小數學-一A`，年級依序輪替一…六；
 *   - 列 0、1、2：零報名（「無課程」，共 3 人；列 2 另帶「員工家屬」標籤 → 有真實問題，仍計入需確認）；
 *   - 列 3：只有寫功課；列 4：只有交通車；列 5：班級欄只有 `[團]`，parser 會建立 baseName 為空的報名（「班名無法解析」，共 1 人）；
 *   - 列 6–10、15：國小輔導-一A（本班適用折扣案例，手算見各常數）；
 *   - 最後一列：只在後頁出現的班 `後頁獨有班`。
 */

export const B2 = {
  MATH: '國小數學-一A',
  ENGLISH: '兒童美語-Gino',
  CARE: '國小輔導-一A',
  OTHER: '國語文-合成',
  LATE: '後頁獨有班',
  SIZE: 210,
  /** 零報名（無課程）人數：列 0、1、2 */
  NO_COURSE: 3,
  /** 班級欄只有 [團]、baseName 為空的人數：列 5 */
  UNPARSED: 1,
} as const;

export const code = (i: number) => `B2E_${String(i).padStart(4, '0')}`;
export const studentName = (i: number) => `合成學生${String(i).padStart(3, '0')}`;
const GRADE = ['一年級', '二年級', '三年級', '四年級', '五年級', '六年級'];

interface RowSpec {
  classes: string;
  grade: string;
  tags: string;
}

function rowSpec(i: number): RowSpec {
  const grade = GRADE[i % 6];
  const base: RowSpec = { classes: `${B2.MATH}[團]`, grade, tags: '' };
  switch (i) {
    case 0:
    case 1:
      return { ...base, classes: '' };
    case 2:
      return { ...base, classes: '', tags: '員工家屬' };
    case 3:
      return { ...base, classes: '國小輔導-寫功課[團]' };
    case 4:
      return { ...base, classes: '交通車[團]' };
    case 5:
      return { ...base, classes: '[團]' };
    case 6:
      // 一年級、只報國小輔導-一A、園內生 → 科數 1、基本率 10000（無折扣）；R13 安親 max(9000, 10000-500)=9500（95折）
      return { classes: `${B2.CARE}[團]`, grade: '一年級', tags: '園內生' };
    case 7:
      // 一年級、國小輔導＋數學、園內生 → 科數 2、基本率 9500（95折）；R13 安親 max(9000, 9500-500)=9000（9折）
      return { classes: `${B2.CARE}[團]\n${B2.MATH}[團]`, grade: '一年級', tags: '園內生' };
    case 8:
      // 三年級、只報國小輔導-一A → 課輔側；基本率與適用率皆 10000（R14 無園內生）
      return { classes: `${B2.CARE}[團]`, grade: '三年級', tags: '' };
    case 9:
      return { classes: `${B2.CARE}[團]`, grade: '二年級', tags: '' };
    case 10:
      // 年級未知 → 國小輔導班的本班適用率無法判定（null，顯示「—」，不是「未設定」）
      return { classes: `${B2.CARE}[團]`, grade: '', tags: '' };
    case 11:
      return { ...base, classes: `${B2.MATH}[團]\n${B2.ENGLISH}[團]`, grade: '三年級' };
    case 12:
      return { ...base, classes: `${B2.OTHER}[團]` };
    case 13:
      return { ...base, tags: '特殊折扣95折' };
    case 14:
      return { ...base, tags: '有兄弟姊妹折扣' };
    case 15:
      return { classes: `${B2.CARE}[團]`, grade: '一年級', tags: '安課額外扣0.5天' };
    default:
      if (i === B2.SIZE - 1) return { ...base, classes: `${B2.LATE}[團]` };
      return base;
  }
}

/** 合成名冊 xlsx（只含匯入必要欄位；全部為合成資料）。 */
export async function buildB2Workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
  for (let i = 0; i < B2.SIZE; i++) {
    const s = rowSpec(i);
    ws.addRow([code(i), studentName(i), '本校', s.classes, s.grade, s.tags, '']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 上傳合成名冊並使用（冪等：已有 active 結果頁就直接返回）。 */
export async function ensureB2Activated(page: Page): Promise<void> {
  await page.goto('/');
  if ((await page.locator('.data-banner-current').count()) > 0) return;
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'b2-synthetic.xlsx',
    mimeType: XLSX_MIME,
    buffer: await buildB2Workbook(),
  });
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
  await page.locator('button', { hasText: '使用這份名單' }).click();
  await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });
  await page.goto('/');
  await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
}

export interface ApiEnrollment { baseName: string; rawToken: string }
export interface ApiStudent {
  personCode: string;
  name: string;
  grade: number | null;
  baseDiscountBps: number | null;
  applicableAnqinBps: number | null;
  applicableTutoringBps: number | null;
  applicableMathBps: number | null;
  applicableEnglishBps: number | null;
  tierMismatch: boolean;
  hasIssues: boolean;
  issues: Array<{ code: string }>;
  enrollments: ApiEnrollment[];
  trace?: { rawTags?: string; careDays?: { anqin?: { hasExtraFlag?: boolean }; tutoring?: { hasExtraFlag?: boolean } } };
}

export async function currentRunId(page: Page): Promise<string> {
  const res = await page.request.get('/api/v1/runs/current');
  const json = await res.json();
  expect(json.activeRunId, '需要已啟用的 run').toBeTruthy();
  return json.activeRunId as string;
}

/** 以 API 分頁讀完整個 run（不套篩選）——獨立於選項端點與 SQL 篩選，作為 expected 的來源。 */
export async function allStudents(page: Page, runId?: string): Promise<ApiStudent[]> {
  const id = runId ?? (await currentRunId(page));
  const out: ApiStudent[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const qs = new URLSearchParams({ limit: '200' });
    if (cursor) qs.set('cursor', cursor);
    const res = await page.request.get(`/api/v1/runs/${id}/students?${qs}`);
    expect(res.ok()).toBe(true);
    const json = await res.json();
    out.push(...json.items);
    cursor = json.nextCursor;
    if (!cursor) return out;
  }
  throw new Error('分頁沒有結束');
}

export const classesOf = (s: ApiStudent): string[] => [...new Set(s.enrollments.map((e) => e.baseName))];

import ExcelJS from 'exceljs';
import { expect, type Page } from '@playwright/test';

/**
 * R4-F03 共用：4 人全合成小名冊（每一列的年級與標籤都明列，可逐條手算）。
 *
 * 設計目標是重現第四輪驗收 6.2A step5→6→7 的**操作形狀**：
 *   step5：年級勾「5年級、6年級」→ 4 人
 *   step6：再加兄弟姊妹「有」→ 1 人（此時 6年級 已勾選、count 變 0，仍顯示可取消）
 *          再取消「6年級」→ 0 人
 *   step7：0 人後重開年級面板仍看得到已勾選的 6年級（count=0），
 *          改為取消兄弟姊妹「有」→ 恢復 2 人（5年級）
 *
 * ── 手算（4 列）────────────────────────────────────────
 * | 列 | 代碼   | 姓名      | 年級 | 班級            | 標籤          |
 * |----|--------|-----------|------|-----------------|---------------|
 * | 0  | F03_00 | 合成五甲  | 五年級 | 國小數學-三A[團] | （無）        |
 * | 1  | F03_01 | 合成六甲  | 六年級 | 國小數學-三A[團] | 有兄弟姊妹折扣 |
 * | 2  | F03_02 | 合成六乙  | 六年級 | 國小數學-三A[團] | （無）        |
 * | 3  | F03_03 | 合成五乙  | 五年級 | 國小數學-三A[團] | （無）        |
 *
 *   全部                      → 4 人
 *   年級＝5年級               → 2 人（列 0、3）
 *   年級＝6年級               → 2 人（列 1、2）
 *   年級＝5年級 ∪ 6年級       → 4 人（列 0–3）
 *   兄弟姊妹＝有               → 1 人（列 1，六年級）
 *   (5年級 ∪ 6年級) ∩ 兄弟姊妹＝有 → 1 人（列 1）★ 與驗收一致
 *   取消 6年級 → 只剩 5年級 ∩ 兄弟姊妹＝有 → 空 → 0 人 ★ 與驗收一致
 *   取消兄弟姊妹＝有 → 只剩 5年級 → 2 人（列 0、3）
 *
 * 關鍵設計：帶「有兄弟姊妹折扣」的列 1 必須是**六年級**，取消 6年級後交集才會歸零；
 * 若它是五年級，則「五年級 ∩ 兄弟姊妹＝有」恆為 1 人，永遠無法經此路徑歸零。
 */

export const F03 = {
  SIZE: 4,
  YEAR5: '5年級',
  YEAR6: '6年級',
  SIBLING_YES: '有',
  MATH: '國小數學-三A',
  /** 年級＝5年級 ∪ 6年級 → 全部 4 人 */
  BOTH_YEARS_COUNT: 4,
  /** (5年級 ∪ 6年級) ∩ 兄弟姊妹＝有 → 列 1 */
  BOTH_YEARS_SIBLING_COUNT: 1,
  /** 取消 6年級 後只剩 5年級 → 列 0、3 */
  YEAR5_COUNT: 2,
} as const;

interface RowSpec {
  grade: string;
  tags: string;
}

const ROWS: RowSpec[] = [
  { grade: '五年級', tags: '' },
  { grade: '六年級', tags: '有兄弟姊妹折扣' },
  { grade: '六年級', tags: '' },
  { grade: '五年級', tags: '' },
];

export const code = (i: number) => `F03_${String(i).padStart(2, '0')}`;
export const studentName = (i: number) => `合成${ROWS[i].grade}生${'甲乙丙丁'[i]}`;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 4 人合成名冊 xlsx（只含匯入必要欄位；全部為合成資料）。 */
export async function buildF03Workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
  ROWS.forEach((r, i) => {
    ws.addRow([code(i), studentName(i), '合成分校', `${F03.MATH}[團]`, r.grade, r.tags, '']);
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 匯入並啟用合成名冊（冪等：已有 active 結果就直接返回）。 */
export async function ensureF03Activated(page: Page): Promise<void> {
  await page.goto('/');
  if ((await page.locator('.data-banner-current').count()) > 0) return;
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'f03-synthetic.xlsx',
    mimeType: XLSX_MIME,
    buffer: await buildF03Workbook(),
  });
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
  await page.locator('button', { hasText: '使用這份名單' }).click();
  await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });
  await page.goto('/');
  await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
}
/**
 * D66（03 §5.1 R6）：學生總表 13 欄的欄位定義。
 *
 * 每欄對每列產生 `Cell[]`（底層值＋顯示文字）；儲存格渲染（`SummaryTable`）與 server／client 的
 * 篩選、選項、排序都呼叫同一份 `cells()`，顯示與篩選不可能分岔。空白＝空陣列（儲存格以「—」呈現）。
 *
 * 純 TS、無 Node／SQLite 依賴（沿用 `summary-table.tsx` 本來就在 client import 的模組）。
 */
import type { StudentCalculationItem } from '@/application/query-students';
import { formatDiscountBps } from '@/application/roster-changes';
import { applicableRateForClass, type RunClassCategorySnapshot } from '@/application/applicable-rate';
import { parseTagDiscounts } from '@/domain/billing/discount-rules';
import { issueLabel } from '@/lib/issue-copy';
import { UNPARSEABLE_CLASS_TEXT } from '@/contracts/column-filter';
import { cell, type Cell, type ColumnSpec, type TextCell } from './cell';

export { UNPARSEABLE_CLASS_TEXT };

export interface StudentColumnCtx {
  /** 恰選一班時的班名（名冊班名）；非 null 才有「本班適用折扣」。 */
  singleClass: string | null;
  /** 該 run 的班級類別快照；缺該班快照時本班適用折扣＝「未設定」。 */
  snapshots: readonly RunClassCategorySnapshot[] | null | undefined;
}
export type StudentColumnSpec = ColumnSpec<StudentCalculationItem, StudentColumnCtx>;

export const NOT_CONFIGURED_TEXT = '未設定';

const NO_CELLS: Cell[] = [];

/** 所屬班級（多值）：每個報名項目 → baseName；baseName 為空字串顯示「班名無法解析」；零報名＝空白。 */
export function enrollmentCellsOf(enrollments: ReadonlyArray<{ baseName: string }>): Cell[] {
  return enrollments.map((e) => (e.baseName === '' ? cell('', UNPARSEABLE_CLASS_TEXT) : cell(e.baseName)));
}
const one = (c: Cell): Cell[] => (c === null ? NO_CELLS : [c]);

/** 年級：`grade` 非 null → 數值／`N年級`；否則 `grade_raw` 非空白 → 字串原文；否則空白。匯入「名單」表（P5）共用。 */
export function gradeCell(grade: number | null | undefined, gradeRaw: string | null | undefined): Cell {
  if (grade !== null && grade !== undefined) return cell(grade, `${grade}年級`);
  const raw = gradeRaw?.trim();
  return raw ? cell(raw, raw) : null;
}

/** 合計折扣（基本率）：bps／`formatDiscountBps`；null → 字串「未設定」（UX14：未配置不當 100%）。 */
export function baseDiscountCell(bps: number | null | undefined): TextCell {
  if (bps === null || bps === undefined) return cell(NOT_CONFIGURED_TEXT);
  return cell(bps, formatDiscountBps(bps));
}

/** 數值欄：null＝非適用／無法判定＝空白（不是 0，UX14）。 */
function numberCell(v: number | null | undefined): Cell {
  return v === null || v === undefined ? null : cell(v);
}

/** 天數欄：底層值＝天數、顯示文字＝`*_display`（如 `4`、`4*額`）；無顯示文字＝空白。 */
function daysCell(days: number | null, display: string | null | undefined): Cell {
  if (!display) return null;
  return cell(days ?? display, display);
}

type CareTrace = { careDays?: { anqin?: { hasExtraFlag?: boolean }; tutoring?: { hasExtraFlag?: boolean } }; rawTags?: string };

/** 額外扣天：`hasExtraFlag`（「*額」標記）→ `N*`；無旗標 → `N`；無旗標且兩側天數皆 null → 空白（0 天與「無額外」不同）。 */
function extraDeductionCell(stu: StudentCalculationItem): Cell {
  const trace = stu.trace as CareTrace | undefined;
  const hasExtra = Boolean(trace?.careDays?.anqin?.hasExtraFlag || trace?.careDays?.tutoring?.hasExtraFlag);
  const total = (stu.anqinDays ?? 0) + (stu.tutoringDays ?? 0);
  if (hasExtra) return cell(total, `${total}*`);
  return stu.anqinDays === null && stu.tutoringDays === null ? null : cell(total);
}

/**
 * 恰選一班時的本班適用折扣：未配置（缺快照）＝字串「未設定」（不是 100%）；已配置但無法判定＝空白。
 *
 * D2b 3（N-8）：查詢 key 必須是**名冊班名**（快照的 base_name 存名冊班名；`singleClass` 亦來自名冊報名 key，兩者同源）。
 * 缺快照時不猜，一律「未設定」。
 */
function applicableDiscountCell(stu: StudentCalculationItem, ctx: StudentColumnCtx): Cell {
  if (ctx.singleClass === null) return null;
  const r = applicableRateForClass(ctx.singleClass, stu, {
    findSnapshot: (name) => ctx.snapshots?.find((x) => x.base_name === name),
  });
  if (r.status === 'not_configured') return cell(NOT_CONFIGURED_TEXT);
  return r.bps === null ? null : cell(r.bps, formatDiscountBps(r.bps));
}

const tagsOf = (stu: StudentCalculationItem) => parseTagDiscounts((stu.trace as CareTrace | undefined)?.rawTags ?? '');

/** 需確認（多值）：`天數不同`、每個 actionable issue 的中文標籤（同標籤只列一次）、只有 needsReview 而無 issue 時 `待核對`。 */
function reviewCells(stu: StudentCalculationItem): Cell[] {
  const texts: string[] = [];
  if (stu.tierMismatch) texts.push('天數不同');
  if (stu.actionableHasIssues) {
    if (stu.actionableIssues.length > 0) {
      for (const issue of stu.actionableIssues) {
        const label = issueLabel(issue.code);
        if (!texts.includes(label)) texts.push(label);
      }
    } else texts.push('待核對');
  }
  return texts.map((t) => cell(t));
}

const spec = (key: string, label: string, filterable: boolean, sortable: boolean, cells: StudentColumnSpec['cells']): StudentColumnSpec => ({
  key,
  label,
  filterable,
  sortable,
  cells,
});

/** 表格順序（本班適用折扣緊接合計折扣，僅 `singleClass` 時渲染）。 */
export const STUDENT_COLUMN_SPECS: readonly StudentColumnSpec[] = [
  spec('name', '姓名', false, true, (s) => [cell(s.name)]),
  spec('grade', '年級', true, true, (s) => one(gradeCell(s.grade, s.gradeRaw))),
  spec('enrollment', '所屬班級', true, false, (s) => enrollmentCellsOf(s.enrollments)),
  spec('anqinDays', '安親天數', true, true, (s) => one(daysCell(s.anqinDays, s.anqinDisplay))),
  spec('tutoringDays', '課輔天數', true, true, (s) => one(daysCell(s.tutoringDays, s.tutoringDisplay))),
  spec('extraDeduction', '額外扣天', true, false, (s) => one(extraDeductionCell(s))),
  spec('baseDiscount', '合計折扣', true, true, (s) => one(baseDiscountCell(s.baseDiscountBps))),
  spec('applicableDiscount', '本班適用折扣', true, false, (s, ctx) => one(applicableDiscountCell(s, ctx))),
  spec('subjectCount', '已補科數', false, true, (s) => one(numberCell(s.subjectCount))),
  spec('sibling', '兄弟姊妹折扣', true, false, (s) => (tagsOf(s).sibling ? [cell('有')] : NO_CELLS)),
  spec('specialDiscount', '特殊折扣', true, false, (s) => {
    const rate = tagsOf(s).specialDiscount;
    if (rate === null) return NO_CELLS;
    const bps = Math.round(rate * 10000);
    return [cell(bps, formatDiscountBps(bps))];
  }),
  spec('internalStudent', '園內生', true, false, (s) => (tagsOf(s).internalStudent ? [cell('是')] : NO_CELLS)),
  spec('review', '需確認', true, false, (s) => reviewCells(s)),
];

export function studentColumnSpec(key: string): StudentColumnSpec | undefined {
  return STUDENT_COLUMN_SPECS.find((s) => s.key === key);
}

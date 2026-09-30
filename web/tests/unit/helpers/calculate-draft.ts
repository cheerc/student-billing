import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { gridRowsToCalculateClasses, type CalculateDraft, type ScheduleGridRow } from '@/contracts/settings';

/**
 * 元件測試用：把平鋪列轉成 calculate 的輸入 draft，走與 settings-editor 相同的
 * gridRowsToCalculateClasses（含 rowId、保留每一列），窗口取 seed（＝ruleSet 固定窗口）。
 */
export function toCalculateDraft(rows: ScheduleGridRow[]): CalculateDraft {
  const seed = buildSeedDraft();
  return { ...seed, classes: gridRowsToCalculateClasses(rows, seed.classes) };
}

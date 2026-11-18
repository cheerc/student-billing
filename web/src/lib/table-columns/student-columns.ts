// RED stub：僅匯出形狀，cells 尚未實作（GREEN commit 取代）。
import type { StudentCalculationItem } from '@/application/query-students';
import type { RunClassCategorySnapshot } from '@/application/applicable-rate';
import type { Cell, ColumnSpec } from './cell';

export interface StudentColumnCtx {
  singleClass: string | null;
  snapshots: readonly RunClassCategorySnapshot[] | null | undefined;
}
export type StudentColumnSpec = ColumnSpec<StudentCalculationItem, StudentColumnCtx>;

const none = (): Cell[] => [];
const spec = (key: string, label: string, filterable: boolean, sortable: boolean): StudentColumnSpec => ({ key, label, cells: none, filterable, sortable });

export const STUDENT_COLUMN_SPECS: readonly StudentColumnSpec[] = [
  spec('name', '姓名', false, true),
  spec('grade', '年級', true, true),
  spec('enrollment', '所屬班級', true, false),
  spec('anqinDays', '安親天數', true, true),
  spec('tutoringDays', '課輔天數', true, true),
  spec('extraDeduction', '額外扣天', true, false),
  spec('baseDiscount', '合計折扣', true, true),
  spec('applicableDiscount', '本班適用折扣', true, false),
  spec('subjectCount', '已補科數', false, true),
  spec('sibling', '兄弟姊妹折扣', true, false),
  spec('specialDiscount', '特殊折扣', true, false),
  spec('internalStudent', '園內生', true, false),
  spec('review', '需確認', true, false),
];

export function studentColumnSpec(key: string): StudentColumnSpec | undefined {
  return STUDENT_COLUMN_SPECS.find((s) => s.key === key);
}

export function gradeCell(_grade: number | null, _gradeRaw: string | null): Cell {
  return null;
}

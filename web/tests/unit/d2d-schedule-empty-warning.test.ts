import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildClassSettingMap } from '@/application/calculate-run';
import { manualCategories } from '../helpers/manual-categories';
import type { StudentSnapshot } from '@/domain/students/types';

/**
 * D2d D（RED）：不可計算候選（課表空白）必須保留需確認警告。
 *
 * 02 §9.3 第 4 點（Q5／Q6）：`schedule_not_found` 與 `schedule_empty` 皆視為不可計算；
 * 扣天視為 0 但**保留其需確認警告**；全部不可計算時沿用首班 0 fallback 並保留警告。
 * S manifest §7.5 第 5 點：未入選候選的需確認警告一律保留。
 *
 * 現行 billing-calculator.ts:218-225（數學）與 :291-298（美語）只在
 * `ses.status === 'schedule_not_found'` 時 push issue，`schedule_empty` 靜默。
 *
 * ── 手算（D24；課輔窗口 990–1170，每日 180 分；年級 4 ＝課輔側）──
 * ① 國小數學-三A：override 空時段 → schedule_empty → 不可計算，扣天 0，正值 0
 * ② 國小數學-三B：週一 1080–1170（重疊 90 分 → raw −0.5 → |frac| 0.5∈[0.3,0.8) → rounded −0.5，
 *    以產品 calculateClassDeductionD24 實算確認）→ 可計算，正值 0.5
 *
 * v2 首班語意 → 選①（空）→ 扣天 0 → 天數 max(3, 5−0) = **5**（v2 凍結，不在本次修正範圍）
 * v3 取正量最多 → 選② → 天數 max(3, 5−0.5) = **4.5**
 *
 * 期望：v3 的 issues 必含 SCHEDULE_EMPTY（指明①）與重複報名提示。
 * 現況：issues 只有 DUPLICATE_SUBJECT_ENROLLMENT，空課表候選靜默（needsReview 亦為 false，
 * 因為 mathScheduleStatus 取選中班的 calculated，未反映未入選候選的不可計算狀態）。
 */

/** 注意：傳入 scheduleOverride 會使 classMapFor 改用 NO_SEED_CLASSES（billing-calculator.ts:48-50），
 *  這正是本案例要的路徑——「已對應但時段為空」只可能出現在有 override 的情境。 */
const OVERRIDE = new Map<string, Array<{ weekday: string; start: number; end: number }>>([
  ['國小數學-三A', []], // schedule_empty
  ['國小數學-三B', [{ weekday: '一', start: 1080, end: 1170 }]],
]);

const ENROLLMENTS = ['國小數學-三A', '國小數學-三B'];

function makeStudent(personCode: string): StudentSnapshot {
  return {
    personCode,
    name: '合成學生',
    branch: null,
    grade: 4,
    gradeRaw: '4',
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: ENROLLMENTS.map((b) => ({
      baseName: b,
      rawToken: b,
      yearPrefix: null,
      groupFlag: null,
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable' as const,
      parseStatus: 'ok' as const,
    })),
  };
}

function run(version: 'erp-tag-v4' = 'erp-tag-v4') {
  return calculateStudentBilling(makeStudent('S-EMPTY'), {
    ruleSetVersion: version,
    aliasMap: new Map(),
    classSettings: manualCategories({ math: ['國小數學-三A', '國小數學-三B'] }),
    scheduleOverride: new Map(OVERRIDE),
  });
}

describe('D2d D: 空課表候選（schedule_empty）保留需確認警告', () => {

  it('v4：首班時段為空、次班可計算 → 必須出 SCHEDULE_EMPTY 需確認警告', () => {
    const codes = run('erp-tag-v4').issues.map((i) => i.code);
    expect(codes).toContain('SCHEDULE_EMPTY');
  });

  it('v4：空課表候選必須被標為需確認（tierComparisons needsReview）', () => {
    const r = run('erp-tag-v4');
    expect(r.tierComparisons.some((c) => c.needsReview)).toBe(true);
  });

  it('v4：美語全部候選皆空時段 → 必須出 SCHEDULE_EMPTY 警告，不靜默', () => {
    const r = calculateStudentBilling(
      {
        ...makeStudent('S-EMPTY-EN'),
        enrollments: [{ ...makeStudent('x').enrollments[0], baseName: '兒童美語-Gino', rawToken: '兒童美語-Gino' }],
      },
      {
        ruleSetVersion: 'erp-tag-v4',
        aliasMap: new Map(),
        classSettings: manualCategories({
          math: ['國小數學-三A', '國小數學-三B'],
          english: ['兒童美語-Gino'],
        }),
        scheduleOverride: new Map([['兒童美語-Gino', []]]),
      }
    );
    expect(r.issues.map((i) => i.code)).toContain('SCHEDULE_EMPTY');
  });


});

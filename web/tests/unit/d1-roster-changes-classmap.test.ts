import { describe, it, expect } from 'vitest';
import { computeRosterChanges } from '@/application/roster-changes';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { makeStudent } from '../helpers/d1-test-kit';

/**
 * D1 F-7（specs/11 §3 D1、04 §8 UX40；S manifest §1.3 #16、§A F-7）：
 * 匯入異動明細的 classSide 必須與 calculator 對「課表來源」的判斷一致。
 *
 * 舊行為的錯：calculateStudentBilling 在帶入 scheduleOverride（＝已有儲存設定）時，班級只以該設定為準，
 * 不在其中的班判 schedule_not_found、不退回 seed（09 §8.2.4 方案 A）；但 roster-changes 的 classSide
 * 呼叫 resolveClassSessions 時沒帶 classMap，預設仍是 seed——同一位學生的天數（calculator）說找不到課表、
 * 逐班明細卻用 seed 課表算出扣天，兩者互相矛盾。
 *
 * expected 獨立手算：
 *   國小數學-一A（新設定）＝週一 13:00–14:30（780–870）→ 安親窗口 780–960 重疊 90 分
 *   → raw −90/180＝−0.5 → D24：d=0.5，f=0.5∈[0.3,0.8) → 扣 0.5 → 年級 1 安親天數＝max(3.5, 5−0.5)＝4.5；
 *   舊設定沒有這個班 → schedule_not_found → 0 扣 → 5 天。
 */

const session = [{ start: 780, end: 870, weekday: '一' }];

describe('F-7：roster-changes classSide 與 calculator 的課表來源一致', () => {
  const s = makeStudent('S1', ['國小數學-一A'], { grade: 1 });

  it('before 設定（有 override）不含該班 → 明細 statusBefore＝schedule_not_found、扣除量 null；after 設定含該班 → 0.5', () => {
    // 前提：calculator 對 before／after 的判斷
    const beforeOverride = new Map([['國小數學-二A', session]]);
    const afterOverride = new Map([['國小數學-一A', session]]);
    expect(calculateStudentBilling(s, { ruleSetVersion: 'erp-tag-v2', scheduleOverride: beforeOverride }).careDays.anqin.days).toBe(5);
    expect(calculateStudentBilling(s, { ruleSetVersion: 'erp-tag-v2', scheduleOverride: afterOverride }).careDays.anqin.days).toBe(4.5);

    const result = computeRosterChanges([s], [s], { scheduleOverride: beforeOverride }, { scheduleOverride: afterOverride });
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    expect(change.dayChange).toMatchObject({ beforeAnqinDays: 5, afterAnqinDays: 4.5 });

    const row = change.dayChange!.classBreakdown.find((r) => r.baseName === '國小數學-一A')!;
    expect(row.presence).toBe('kept');
    // 這一格在 D1 前是 'calculated'（用 seed 的一A 時段算出扣除量），與 calculator 判 schedule_not_found 互相矛盾
    expect(row.statusBefore).toBe('schedule_not_found');
    expect(row.beforeAnqinDeduction).toBeNull();
    expect(row.beforeTutoringDeduction).toBeNull();
    expect(row.statusAfter).toBe('calculated');
    expect(row.afterAnqinDeduction).toBe(0.5);
  });

  it('特徵化：兩側都沒有儲存設定（未帶 override，走 seed）→ 新報名的一A 逐班明細用 seed 課表：安親扣 0.5、statusAfter＝calculated', () => {
    // seed 一A：週四 15:00–16:30（900–990）→ 安親重疊 60 分 → raw −0.333 → D24 扣 0.5（週六上午與週一至五窗口無交集，v2）
    // 年級 1：before 沒有數學班 → 5 天；after 報一A → max(3.5, 5−0.5)＝4.5
    const before = makeStudent('S1', ['國小輔導-一A'], { grade: 1 });
    const after = makeStudent('S1', ['國小輔導-一A', '國小數學-一A'], { grade: 1 });
    const result = computeRosterChanges([before], [after], {}, {});
    const change = result.changes[0];
    expect(change.dayChange).toMatchObject({ beforeAnqinDays: 5, afterAnqinDays: 4.5 });
    const row = change.dayChange!.classBreakdown.find((r) => r.baseName === '國小數學-一A')!;
    expect(row).toMatchObject({ presence: 'added', statusBefore: 'no_enrollment', statusAfter: 'calculated', afterAnqinDeduction: 0.5 });
  });
});

import { describe, it, expect } from 'vitest';
import path from 'path';
import { runFixtureGates } from '../../scripts/verify-fixtures';

describe('T07: 兩條資料 Gate 驗證 (07 §5.4, §6)', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

  it('Gate 1: 正式標籤、排課與計算 Gate 應全數通過，筆數、標籤與問題碼精準吻合', async () => {
    const result = await runFixtureGates(fixturePath);
    expect(result.gate1.passed).toBe(true);

    // 核心數據斷言
    expect(result.gate1.totalStudents).toBe(477);
    expect(result.gate1.studentsWithClass).toBe(384);
    expect(result.gate1.studentsWithoutClass).toBe(93);

    // 標籤統計
    expect(result.gate1.siblingCount).toBe(133);
    expect(result.gate1.internalCount).toBe(97);
    expect(result.gate1.specialDiscountCount).toBe(14);
    expect(result.gate1.extraDeductionCount).toBe(14);
    expect(result.gate1.nonEmptyNotesCount).toBe(171);

    // 離班與年級
    expect(result.gate1.withdrawnStudentsCount).toBe(34);
    expect(result.gate1.withdrawnTokensCount).toBe(37);
    expect(result.gate1.gradeUnavailableCount).toBe(1);

    // 5 筆級距 mismatch 來源列
    expect(result.gate1.anqinMismatchRows).toEqual([30, 35, 43, 51, 52]);

    // 13 人數學缺排課全數 match
    expect(result.gate1.mathNotFoundCount).toBe(13);
    expect(result.gate1.mathNotFoundAllMatch).toBe(true);

    // 問題碼提示
    expect(result.gate1.duplicateEnrollmentCount).toBe(2);
    expect(result.gate1.staffFamilyCount).toBe(5);
    expect(result.gate1.conflictingNoteCount).toBe(1);

    // 班名對照 42 / 12 / 7
    expect(result.gate1.erpTokensCount).toBe(95);
    expect(result.gate1.erpBaseNamesCount).toBe(54);
    expect(result.gate1.erpMatchedCount).toBe(42);
    expect(result.gate1.erpUnmatchedCount).toBe(12);
    expect(result.gate1.seedNotAppearedCount).toBe(7);
  });

  it('Gate 2: 歷史 Compat 雙軌差異 Gate 應精確吻合（基本率差 107 人、課輔天數差 12 人）', async () => {
    const result = await runFixtureGates(fixturePath);
    expect(result.gate2.passed).toBe(true);
    expect(result.gate2.baseDiscountDiffCount).toBe(107);
    expect(result.gate2.tutoringDaysDiffCount).toBe(12);
    expect(result.gate2.anqinDaysDiffCount).toBe(0);
    expect(result.gate2.totalDifferences).toBe(119);
  });
});

import { describe, it, expect } from 'vitest';
import path from 'path';
import { runFixtureGates } from '../../scripts/verify-fixtures';

describe('T07: v4 fixture data gate (07 §5.4, §6)', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

  it('import and seed integrity gate should pass with exact synthetic fixture counts', async () => {
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

    // 班名對照 42 / 12 / 7
    expect(result.gate1.erpTokensCount).toBe(95);
    expect(result.gate1.erpBaseNamesCount).toBe(54);
    expect(result.gate1.erpMatchedCount).toBe(42);
    expect(result.gate1.erpUnmatchedCount).toBe(12);
    expect(result.gate1.seedNotAppearedCount).toBe(7);
  });

});

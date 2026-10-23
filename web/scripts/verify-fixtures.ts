import fs from 'fs';
import path from 'path';
import { readErpWorkbook } from '../src/adapters/xlsx/erp-reader';
import { parseTagDiscounts } from '../src/domain/billing/discount-rules';
import { classifyErpBaseNames } from '../src/domain/schedules/seed-manifest';
import seedData from '../src/domain/schedules/schedule-seed.json';

export interface GateVerificationResult {
  gate1: {
    passed: boolean;
    totalStudents: number;
    studentsWithClass: number;
    studentsWithoutClass: number;
    siblingCount: number;
    internalCount: number;
    specialDiscountCount: number;
    extraDeductionCount: number;
    nonEmptyNotesCount: number;
    withdrawnStudentsCount: number;
    withdrawnTokensCount: number;
    gradeUnavailableCount: number;
    seedTotalClasses: number;
    seedSessionRows: number;
    erpTokensCount: number;
    erpBaseNamesCount: number;
    erpMatchedCount: number;
    erpUnmatchedCount: number;
    seedNotAppearedCount: number;
  };
  passed: boolean;
}

export async function runFixtureGates(fixturePath?: string): Promise<GateVerificationResult> {
  const filePath = fixturePath || path.resolve(__dirname, '../tests/fixtures/conforming-erp-fixture.xlsx');
  const buf = fs.readFileSync(filePath);
  const erp = await readErpWorkbook(buf);

  // -------------------------------------------------------------
  // Gate 1: import and seed data integrity
  // -------------------------------------------------------------
  let siblingCount = 0;
  let internalCount = 0;
  let specialDiscountCount = 0;
  let extraDeductionCount = 0;
  let nonEmptyNotesCount = 0;
  const withdrawnStudents = new Set<string>();
  let withdrawnTokensCount = 0;
  let gradeUnavailableCount = 0;

  for (const s of erp.students) {
    const discounts = parseTagDiscounts(s.tagsRaw);
    if (discounts.sibling) siblingCount++;
    if (discounts.internalStudent) internalCount++;
    if (discounts.specialDiscount !== null) specialDiscountCount++;
    if (discounts.extraDeduction !== null) extraDeductionCount++;
    if (s.notesRaw && s.notesRaw.trim()) nonEmptyNotesCount++;
    if (s.gradeStatus === 'unavailable') gradeUnavailableCount++;

    for (const e of s.enrollments) {
      if (e.withdrawalDate) {
        withdrawnStudents.add(s.personCode);
        withdrawnTokensCount++;
      }
    }

  }

  // 班名與 Seed 對照統計
  const erpTokens = new Set<string>();
  const erpBaseNames = new Set<string>();
  erp.students.forEach((s) => {
    s.enrollments.forEach((e) => {
      erpTokens.add(e.rawToken);
      erpBaseNames.add(e.baseName);
    });
  });
  const seedComparison = classifyErpBaseNames(Array.from(erpBaseNames));

  const gate1Passed =
    erp.students.length === 477 &&
    erp.studentsWithClass === 384 &&
    erp.studentsWithoutClass === 93 &&
    siblingCount === 133 &&
    internalCount === 97 &&
    specialDiscountCount === 14 &&
    extraDeductionCount === 14 &&
    nonEmptyNotesCount === 171 &&
    withdrawnStudents.size === 34 &&
    withdrawnTokensCount === 37 &&
    gradeUnavailableCount === 1 &&
    seedData.classes.length === 49 &&
    seedData.totalSessionRows === 89 &&
    erpTokens.size === 95 &&
    erpBaseNames.size === 54 &&
    seedComparison.matchedCount === 42 &&
    seedComparison.unmatchedCount === 12 &&
    seedComparison.seedNotAppearedCount === 7;

  return {
    gate1: {
      passed: gate1Passed,
      totalStudents: erp.students.length,
      studentsWithClass: erp.studentsWithClass,
      studentsWithoutClass: erp.studentsWithoutClass,
      siblingCount,
      internalCount,
      specialDiscountCount,
      extraDeductionCount,
      nonEmptyNotesCount,
      withdrawnStudentsCount: withdrawnStudents.size,
      withdrawnTokensCount,
      gradeUnavailableCount,
      seedTotalClasses: seedData.classes.length,
      seedSessionRows: seedData.totalSessionRows,
      erpTokensCount: erpTokens.size,
      erpBaseNamesCount: erpBaseNames.size,
      erpMatchedCount: seedComparison.matchedCount,
      erpUnmatchedCount: seedComparison.unmatchedCount,
      seedNotAppearedCount: seedComparison.seedNotAppearedCount,
    },
    passed: gate1Passed,
  };
}

// 支援命令列直接執行
if (process.argv[1]?.endsWith('verify-fixtures.ts')) {
  console.log('=== 執行 v4 fixture data gate (verify:fixtures) ===\n');
  runFixtureGates()
    .then((result) => {
      console.log('Gate (import and seed integrity):', result.gate1.passed ? '✓ 通過' : '✗ 失敗');
      console.log(`- 學生總數: ${result.gate1.totalStudents} (384有班, 93無班)`);
      console.log(`- 標籤統計: 兄弟姊妹 ${result.gate1.siblingCount}, 園內生 ${result.gate1.internalCount}, 特殊折扣 ${result.gate1.specialDiscountCount}, 額外扣天 ${result.gate1.extraDeductionCount}`);
      console.log(`- 備註保留: ${result.gate1.nonEmptyNotesCount} 筆非空`);
      console.log(`- 離班統計: ${result.gate1.withdrawnStudentsCount} 人 (${result.gate1.withdrawnTokensCount} tokens)`);
      console.log(`- Seed 49 班 / 89 rows; ERP 95 token -> 54 baseName (42候選 / 12待設定 / 7未出現)`);

      if (!result.passed) {
        console.error('\nv4 fixture data gate failed!');
        process.exit(1);
      }
      console.log('\n=== v4 fixture data gate passed ===');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

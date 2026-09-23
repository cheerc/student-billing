import fs from 'fs';
import path from 'path';
import { readErpWorkbook } from '../src/adapters/xlsx/erp-reader';
import { calculateStudentBilling } from '../src/domain/billing/billing-calculator';
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
    mathNotFoundCount: number;
    mathNotFoundAllMatch: boolean;
    conflictingNoteCount: number;
    duplicateEnrollmentCount: number;
    staffFamilyCount: number;
    seedTotalClasses: number;
    seedSessionRows: number;
    erpTokensCount: number;
    erpBaseNamesCount: number;
    erpMatchedCount: number;
    erpUnmatchedCount: number;
    seedNotAppearedCount: number;
    anqinMismatchCount: number;
    anqinMismatchRows: number[];
  };
  gate2: {
    passed: boolean;
    baseDiscountDiffCount: number;
    tutoringDaysDiffCount: number;
    anqinDaysDiffCount: number;
    totalDifferences: number;
  };
  passed: boolean;
}

export async function runFixtureGates(fixturePath?: string): Promise<GateVerificationResult> {
  const filePath = fixturePath || path.resolve(__dirname, '../tests/fixtures/conforming-erp-fixture.xlsx');
  const buf = fs.readFileSync(filePath);
  const erp = await readErpWorkbook(buf);

  // -------------------------------------------------------------
  // Gate 1: 正式標籤、排課與計算 Gate
  // -------------------------------------------------------------
  let siblingCount = 0;
  let internalCount = 0;
  let specialDiscountCount = 0;
  let extraDeductionCount = 0;
  let nonEmptyNotesCount = 0;
  const withdrawnStudents = new Set<string>();
  let withdrawnTokensCount = 0;
  let gradeUnavailableCount = 0;

  let duplicateEnrollmentCount = 0;
  let staffFamilyCount = 0;
  let conflictingNoteCount = 0;
  let mathNotFoundCount = 0;
  let mathNotFoundAllMatch = true;

  const anqinMismatchRows: number[] = [];

  // Gate 2 統計
  let baseDiscountDiffCount = 0;
  let tutoringDaysDiffCount = 0;
  let anqinDaysDiffCount = 0;

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

    const formal = calculateStudentBilling(s, { ruleSetVersion: 'erp-tag-v1' });
    const compat = calculateStudentBilling(s, { ruleSetVersion: 'excel-v260922-compat' });

    // 檢查問題碼
    if (formal.issues.some((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT')) {
      duplicateEnrollmentCount++;
    }
    if (formal.issues.some((i) => i.code === 'STAFF_FAMILY_NO_DISCOUNT')) {
      staffFamilyCount++;
    }
    if (formal.issues.some((i) => i.code === 'CONFLICTING_NOTE_SOURCE')) {
      conflictingNoteCount++;
    }

    // 檢查國小數學-一 缺排課
    const mathToken = s.enrollments.find((e) => e.rawToken.includes('國小數學-一[團]'));
    if (mathToken) {
      mathNotFoundCount++;
      const careComps = formal.tierComparisons.filter((c) => c.status === 'match' || c.status === 'mismatch');
      const allMatch = careComps.length > 0 && careComps.every((c) => c.status === 'match');
      if (!allMatch || !formal.hasIssues) {
        mathNotFoundAllMatch = false;
      }
    }

    // 檢查一般輔導 mismatch 來源列
    const hasCareMismatch = formal.tierComparisons.some(
      (c) => (c.baseName.includes('國小輔導') || c.baseName.includes('安親') || c.baseName.includes('課輔')) && c.status === 'mismatch'
    );
    if (hasCareMismatch) {
      anqinMismatchRows.push(s.sourceRow);
    }

    // Gate 2: 雙軌差異
    if (formal.baseDiscountBps !== compat.baseDiscountBps) {
      baseDiscountDiffCount++;
    }
    if (formal.careDays.tutoring.days !== compat.careDays.tutoring.days) {
      tutoringDaysDiffCount++;
    }
    if (formal.careDays.anqin.days !== compat.careDays.anqin.days) {
      anqinDaysDiffCount++;
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

  anqinMismatchRows.sort((a, b) => a - b);

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
    mathNotFoundCount === 13 &&
    mathNotFoundAllMatch &&
    conflictingNoteCount === 1 &&
    duplicateEnrollmentCount === 2 &&
    staffFamilyCount === 5 &&
    seedData.classes.length === 49 &&
    seedData.totalSessionRows === 89 &&
    erpTokens.size === 95 &&
    erpBaseNames.size === 54 &&
    seedComparison.matchedCount === 42 &&
    seedComparison.unmatchedCount === 12 &&
    seedComparison.seedNotAppearedCount === 7 &&
    anqinMismatchRows.length === 5 &&
    JSON.stringify(anqinMismatchRows) === JSON.stringify([30, 35, 43, 51, 52]);

  const gate2Passed =
    baseDiscountDiffCount === 107 &&
    tutoringDaysDiffCount === 12 &&
    anqinDaysDiffCount === 0;

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
      mathNotFoundCount,
      mathNotFoundAllMatch,
      conflictingNoteCount,
      duplicateEnrollmentCount,
      staffFamilyCount,
      seedTotalClasses: seedData.classes.length,
      seedSessionRows: seedData.totalSessionRows,
      erpTokensCount: erpTokens.size,
      erpBaseNamesCount: erpBaseNames.size,
      erpMatchedCount: seedComparison.matchedCount,
      erpUnmatchedCount: seedComparison.unmatchedCount,
      seedNotAppearedCount: seedComparison.seedNotAppearedCount,
      anqinMismatchCount: anqinMismatchRows.length,
      anqinMismatchRows,
    },
    gate2: {
      passed: gate2Passed,
      baseDiscountDiffCount,
      tutoringDaysDiffCount,
      anqinDaysDiffCount,
      totalDifferences: baseDiscountDiffCount + tutoringDaysDiffCount + anqinDaysDiffCount,
    },
    passed: gate1Passed && gate2Passed,
  };
}

// 支援命令列直接執行
if (process.argv[1]?.endsWith('verify-fixtures.ts')) {
  console.log('=== 執行雙資料 Gate 驗證 (verify:fixtures) ===\n');
  runFixtureGates()
    .then((result) => {
      console.log('Gate 1 (正式標籤與計算):', result.gate1.passed ? '✓ 通過' : '✗ 失敗');
      console.log(`- 學生總數: ${result.gate1.totalStudents} (384有班, 93無班)`);
      console.log(`- 標籤統計: 兄弟姊妹 ${result.gate1.siblingCount}, 園內生 ${result.gate1.internalCount}, 特殊折扣 ${result.gate1.specialDiscountCount}, 額外扣天 ${result.gate1.extraDeductionCount}`);
      console.log(`- 備註保留: ${result.gate1.nonEmptyNotesCount} 筆非空`);
      console.log(`- 離班統計: ${result.gate1.withdrawnStudentsCount} 人 (${result.gate1.withdrawnTokensCount} tokens)`);
      console.log(`- 級距差異 (5筆): 來源列 [${result.gate1.anqinMismatchRows.join(', ')}]`);
      console.log(`- 缺排課全數 match: ${result.gate1.mathNotFoundAllMatch} (${result.gate1.mathNotFoundCount}人)`);
      console.log(`- 問題碼: 重複報名 ${result.gate1.duplicateEnrollmentCount}人, 員工家屬無折扣 ${result.gate1.staffFamilyCount}人, 備註衝突 ${result.gate1.conflictingNoteCount}人`);
      console.log(`- Seed 49 班 / 89 rows; ERP 95 token -> 54 baseName (42候選 / 12待設定 / 7未出現)`);

      console.log('\nGate 2 (歷史 Compat 雙軌差異):', result.gate2.passed ? '✓ 通過' : '✗ 失敗');
      console.log(`- 基本折扣率差異人數: ${result.gate2.baseDiscountDiffCount} 人 (預期: 恰 107 人)`);
      console.log(`- 課輔天數差異人數: ${result.gate2.tutoringDaysDiffCount} 人 (預期: 恰 12 人)`);
      console.log(`- 安親天數差異人數: ${result.gate2.anqinDaysDiffCount} 人 (預期: 恰 0 人)`);

      if (!result.passed) {
        console.error('\n雙 Gate 驗證失敗！');
        process.exit(1);
      }
      console.log('\n=== 雙 Gate 全部通過！ ===');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

import fs from 'fs';
import path from 'path';
import { readErpWorkbook } from '../src/adapters/xlsx/erp-reader';
import { calculateStudentBilling } from '../src/domain/billing/billing-calculator';
import { classifyErpBaseNames, SEED_CLASSES } from '../src/domain/schedules/seed-manifest';
import seedData from '../src/domain/schedules/schedule-seed.json';

async function verifyBaseline() {
  console.log('=== 開始執行 T03 基準驗證 (verify-baseline) ===\n');

  // 1. 驗證排課種子 49 班基準
  console.log('1. 排課種子驗證:');
  console.log(`- 班級總數: ${seedData.classes.length} (預期: 49)`);
  console.log(`- Session 列數: ${seedData.totalSessionRows} (預期: 89)`);
  const withSchedule = seedData.classes.filter((c: any) => c.source === 'schedule');
  const careWindows = seedData.classes.filter((c: any) => c.source === 'care_window');
  const emptyClasses = seedData.classes.filter((c: any) => c.source === 'empty');
  console.log(`- 有排課班級: ${withSchedule.length} (預期: 40)`);
  console.log(`- 共用窗口班級: ${careWindows.length} (預期: 8)`);
  console.log(`- 空排課班級: ${emptyClasses.length} (預期: 1, ${emptyClasses[0].rawName})`);

  if (seedData.classes.length !== 49 || seedData.totalSessionRows !== 89) {
    throw new Error('排課種子統計不符');
  }

  // 2. 驗證 ERP 54 baseName 與 Seed 42/12/7 對照
  console.log('\n2. ERP 班名與 Seed 對照驗證 (I19):');
  const fixturePath = path.resolve(__dirname, '../tests/fixtures/conforming-erp-fixture.xlsx');
  const buf = fs.readFileSync(fixturePath);
  const erp = await readErpWorkbook(buf);

  const erpTokens = new Set<string>();
  const erpBaseNames = new Set<string>();
  erp.students.forEach((s) => {
    s.enrollments.forEach((e) => {
      erpTokens.add(e.rawToken);
      erpBaseNames.add(e.baseName);
    });
  });

  const comparison = classifyErpBaseNames(Array.from(erpBaseNames));
  console.log(`- ERP Tokens 總數: ${erpTokens.size} (預期: 95)`);
  console.log(`- ERP BaseNames 總數: ${erpBaseNames.size} (預期: 54)`);
  console.log(`- 自動候選匹配數: ${comparison.matchedCount} (預期: 42)`);
  console.log(`- 待設定班級數: ${comparison.unmatchedCount} (預期: 12)`);
  console.log(`- Seed 未出現數: ${comparison.seedNotAppearedCount} (預期: 7)`);

  if (
    comparison.matchedCount !== 42 ||
    comparison.unmatchedCount !== 12 ||
    comparison.seedNotAppearedCount !== 7
  ) {
    throw new Error('I19 班名對照總量不符');
  }

  // 3. 驗證全量 477 學生計算與問題統計
  console.log('\n3. 全量 477 學生計算與問題統計:');
  let duplicateEnrollmentCount = 0;
  let staffFamilyCount = 0;
  let noteConflictCount = 0;
  let mathNotFoundCount = 0;
  let mathNotFoundAllMatch = true;

  for (const s of erp.students) {
    const calc = calculateStudentBilling(s);

    if (calc.issues.some((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT')) {
      duplicateEnrollmentCount++;
    }
    if (calc.issues.some((i) => i.code === 'STAFF_FAMILY_NO_DISCOUNT')) {
      staffFamilyCount++;
    }
    if (calc.issues.some((i) => i.code === 'CONFLICTING_NOTE_SOURCE')) {
      noteConflictCount++;
    }

    const mathToken = s.enrollments.find((e) => e.rawToken.includes('國小數學-一[團]'));
    if (mathToken) {
      mathNotFoundCount++;
      const careComparisons = calc.tierComparisons.filter((c) => c.status === 'match' || c.status === 'mismatch');
      const hasAnyMismatch = careComparisons.some((c) => c.status === 'mismatch');
      const allMatch = careComparisons.length > 0 && careComparisons.every((c) => c.status === 'match');
      if (hasAnyMismatch || !allMatch || !calc.hasIssues) {
        mathNotFoundAllMatch = false;
      }
    }
  }

  console.log(`- DUPLICATE_SUBJECT_ENROLLMENT 學生數: ${duplicateEnrollmentCount} (預期: 恰 2 人)`);
  console.log(`- STAFF_FAMILY_NO_DISCOUNT 學生數: ${staffFamilyCount} (預期: 恰 5 人)`);
  console.log(`- CONFLICTING_NOTE_SOURCE 學生數: ${noteConflictCount} (預期: 恰 1 人)`);
  console.log(`- 國小數學-一 缺排課學生數: ${mathNotFoundCount} (預期: 恰 13 人)`);
  console.log(`- 缺排課學生是否全部為 match 且 needsReview: ${mathNotFoundAllMatch} (預期: true)`);

  if (duplicateEnrollmentCount !== 2 || staffFamilyCount !== 5 || noteConflictCount !== 1 || mathNotFoundCount !== 13 || !mathNotFoundAllMatch) {
    throw new Error('全量學生計算基準驗證不符');
  }

  console.log('\n=== T03 基準驗證全部成功通過！ ===');
}

verifyBaseline().catch((err) => {
  console.error(err);
  process.exit(1);
});

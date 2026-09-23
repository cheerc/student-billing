import { StudentSnapshot, ParsedToken } from '../students/types';
import {
  StudentBillingCalculation,
  TierComparison,
} from './types';
import {
  parseTagDiscounts,
  calculateSubjectCount,
  calculateBaseDiscountBps,
  calculateApplicableRate,
} from './discount-rules';
import { calculateCareDays } from './care-days';
import { detectStudentIssues, compareTier } from './issues-detector';
import {
  calculateClassDeductionD24,
  calculateClassDeductionCompat,
} from '../schedules/overlap-calculator';
import seedData from '../schedules/schedule-seed.json';

export interface CalculationOptions {
  ruleSetVersion?: 'erp-tag-v1' | 'excel-v260922-compat';
}

const seedClassMap = new Map<string, any>();
for (const cls of seedData.classes) {
  seedClassMap.set(cls.baseName, cls);
}

/**
 * 依學生之報名、標籤、年級與排課種子，計算該學生之收費、天數、折扣與問題診斷 (T03)。
 */
export function calculateStudentBilling(
  student: StudentSnapshot,
  options: CalculationOptions = {}
): StudentBillingCalculation {
  const isCompat = options.ruleSetVersion === 'excel-v260922-compat';

  // 1. 標籤 / 備註折扣來源解析 (02 §1 & §5: formal 讀標籤, compat 讀備註)
  const discountSourceText = isCompat ? student.notesRaw : student.tagsRaw;
  const tagDiscounts = parseTagDiscounts(discountSourceText);

  // 2. 科數 (R09) 與基本折扣 (R10)
  const subjectCount = calculateSubjectCount(student.enrollments);
  const baseDiscountBps = calculateBaseDiscountBps(
    subjectCount,
    tagDiscounts.sibling,
    tagDiscounts.specialDiscount
  );

  // 3. 抽取數學與美語之衝堂扣天
  // 找第一個國小數學
  const mathToken = student.enrollments.find((e) => e.baseName.includes('國小數學'));
  let mathAnqinDed = 0;
  let mathTutoringDed = 0;
  let mathScheduleStatus = 'no_enrollment';

  if (mathToken) {
    const mathClass = seedClassMap.get(mathToken.baseName);
    if (!mathClass) {
      mathScheduleStatus = 'schedule_not_found';
    } else if (mathClass.source === 'empty' || mathClass.sessions.length === 0) {
      mathScheduleStatus = 'schedule_empty';
    } else {
      mathScheduleStatus = 'calculated';
      const validSessions = mathClass.sessions.filter((s: any) => s.startMinutes !== null && s.endMinutes !== null);
      if (validSessions.length === 0) {
        mathScheduleStatus = 'schedule_empty';
      } else {
        const sessions = validSessions.map((s: any) => ({ start: s.startMinutes, end: s.endMinutes }));
        const anqinRes = isCompat
          ? calculateClassDeductionCompat(sessions, 'anqin')
          : calculateClassDeductionD24(sessions, 'anqin');
        const tutoringRes = isCompat
          ? calculateClassDeductionCompat(sessions, 'tutoring')
          : calculateClassDeductionD24(sessions, 'tutoring');
        mathAnqinDed = anqinRes.rounded;
        mathTutoringDed = tutoringRes.rounded;
      }
    }
  }

  // 找第一個兒童美語
  const englishToken = student.enrollments.find((e) => e.baseName.includes('兒童美語'));
  let englishAnqinDed = 0;
  let englishTutoringDed = 0;

  if (englishToken) {
    const englishClass = seedClassMap.get(englishToken.baseName);
    if (englishClass && englishClass.sessions.length > 0) {
      const validSessions = englishClass.sessions.filter((s: any) => s.startMinutes !== null && s.endMinutes !== null);
      if (validSessions.length > 0) {
        const sessions = validSessions.map((s: any) => ({ start: s.startMinutes, end: s.endMinutes }));
        const anqinRes = isCompat
          ? calculateClassDeductionCompat(sessions, 'anqin')
          : calculateClassDeductionD24(sessions, 'anqin');
        const tutoringRes = isCompat
          ? calculateClassDeductionCompat(sessions, 'tutoring')
          : calculateClassDeductionD24(sessions, 'tutoring');
        englishAnqinDed = anqinRes.rounded;
        englishTutoringDed = tutoringRes.rounded;
      }
    }
  }

  // 4. 計算安親與課輔每週收費天數 (R11, R12)
  const hasHomeworkOrMeian = student.enrollments.some(
    (e) => e.baseName.includes('寫功課') || e.baseName.includes('美安')
  );
  const isEnrolledAnqin =
    (student.grade === 1 || student.grade === 2) &&
    student.enrollments.some((e) => e.baseName.includes('國小輔導'));
  const isEnrolledTutoring =
    student.grade !== null &&
    student.grade >= 3 &&
    student.grade <= 6 &&
    student.enrollments.some((e) => e.baseName.includes('國小輔導'));

  const careDays = calculateCareDays({
    grade: student.grade,
    mathDeductionAnqin: mathAnqinDed,
    mathDeductionTutoring: mathTutoringDed,
    englishDeductionAnqin: englishAnqinDed,
    englishDeductionTutoring: englishTutoringDed,
    extraDeduction: tagDiscounts.extraDeduction,
    hasHomeworkOrMeian,
    isEnrolledAnqin,
    isEnrolledTutoring,
  });

  // 5. 計算各課程適用折扣 (R13–R15)
  const applicableRates = {
    anqin: calculateApplicableRate('anqin', baseDiscountBps, tagDiscounts.internalStudent, hasHomeworkOrMeian),
    tutoring: calculateApplicableRate('tutoring', baseDiscountBps, tagDiscounts.internalStudent, hasHomeworkOrMeian),
    english: calculateApplicableRate('english', baseDiscountBps, tagDiscounts.internalStudent, hasHomeworkOrMeian),
    math: calculateApplicableRate('math', baseDiscountBps, tagDiscounts.internalStudent, hasHomeworkOrMeian),
    enrichment: calculateApplicableRate('enrichment', baseDiscountBps, tagDiscounts.internalStudent, hasHomeworkOrMeian),
    chinese: calculateApplicableRate('chinese', baseDiscountBps, tagDiscounts.internalStudent, hasHomeworkOrMeian),
  };

  // 6. 級距比較 (Tier Comparisons, U43, U47)
  const tierComparisons: TierComparison[] = [];
  for (const enr of student.enrollments) {
    let computedTierForEnr: number | null = null;
    if (student.grade === 1 || student.grade === 2) {
      computedTierForEnr = careDays.anqin.days;
    } else if (student.grade !== null && student.grade >= 3 && student.grade <= 6) {
      computedTierForEnr = careDays.tutoring.days;
    }

    let schStatus = 'calculated';
    if (mathScheduleStatus !== 'calculated' && mathScheduleStatus !== 'no_enrollment') {
      schStatus = mathScheduleStatus;
    }

    const comp = compareTier({
      enrollmentId: `${student.personCode}_${enr.rawToken}`,
      rawToken: enr.rawToken,
      baseName: enr.baseName,
      computedTier: computedTierForEnr,
      erpDeclaredTier: enr.erpBillingTier,
      scheduleStatus: schStatus,
    });
    tierComparisons.push(comp);
  }

  // 7. 問題診斷 (Issues Detection, R17, R18, U41)
  const issues = detectStudentIssues({
    personCode: student.personCode,
    tagsRaw: student.tagsRaw,
    notesRaw: student.notesRaw,
    enrollments: student.enrollments,
    sibling: tagDiscounts.sibling,
    internalStudent: tagDiscounts.internalStudent,
    specialDiscount: tagDiscounts.specialDiscount,
    isStaffFamily: tagDiscounts.isStaffFamily,
  });

  if (mathScheduleStatus === 'schedule_not_found') {
    issues.push({
      code: 'SCHEDULE_NOT_FOUND',
      message: `學生報名之數學班級「${mathToken?.rawToken}」未於排課種子中找到，天數採 0 扣天 fallback，待確認排課或 alias 對應。`,
    });
  }

  return {
    personCode: student.personCode,
    subjectCount,
    baseDiscountBps,
    applicableRates,
    careDays,
    tierComparisons,
    issues,
    hasIssues: issues.length > 0,
  };
}

import { StudentSnapshot, ParsedToken } from '../students/types';
import {
  StudentBillingCalculation,
  TierComparison,
  ClassSelection,
  StudentSelection,
} from './types';
import {
  parseTagDiscounts,
  calculateSubjectCount,
  calculateSubjectCountV3,
  calculateBaseDiscountBps,
  calculateApplicableRate,
} from './discount-rules';
import { calculateCareDays } from './care-days';
import { detectStudentIssues, compareTier } from './issues-detector';
import {
  calculateClassDeductionD24,
  calculateClassDeductionCompat,
  isUnknownWeekday,
} from '../schedules/overlap-calculator';
import seedData from '../schedules/schedule-seed.json';
import { ruleSetCapabilities } from './rule-set';
import { resolveClassEnrollment, ClassSettingLookup, ClassCategory } from '../classification/class-category';

export type RuleSetVersion = 'erp-tag-v1' | 'excel-v260922-compat' | 'erp-tag-v2' | 'erp-tag-v3';

export interface CalculationOptions {
  ruleSetVersion?: RuleSetVersion;
  /** T05: alias 覆寫（rawToken baseName → seed baseName），不自動批准時為空 */
  aliasMap?: Map<string, string>;
  /** T05: schedule 覆寫（seed baseName → 時段 sessions），供設定維護自訂時段 */
  scheduleOverride?: Map<string, Array<{ start: number; end: number; weekday?: string | null }>>;
  /** D2a: 班級設定快照 (提供手動/自動類別與固定 5 天) */
  classSettings?: Map<string, ClassSettingLookup>;
}

const seedClassMap = new Map<string, any>();
for (const cls of seedData.classes) {
  seedClassMap.set(cls.baseName, cls);
}

/**
 * 已儲存設定不含任何班級時，seed 不再參與（無此班 → schedule_not_found）。
 */
const NO_SEED_CLASSES = new Map<string, any>();

/** 選班評估的內部形狀（數學／美語兩區塊共用）。 */
interface CandidateEval {
  enr: ParsedToken;
  idx: number;
  status: string;
  anqinDed: number;
  tutoringDed: number;
  positiveDeduction: number;
  isCalculable: boolean;
}

/**
 * D2d B（04 §8 UX71／UX68）：把選中的候選轉成對外輸出。
 * 數學／美語共用此轉換，確保兩類別的輸出形狀一致、下游只需讀同一種東西。
 */
function toClassSelection(
  best: CandidateEval,
  candidateCount: number,
  calculableCount: number,
  tieBreak: ClassSelection['tieBreak']
): ClassSelection {
  return {
    selectedBaseName: best.enr.baseName,
    selectedRawToken: best.enr.rawToken,
    status: best.status,
    anqinDeduction: best.anqinDed,
    tutoringDeduction: best.tutoringDed,
    positiveDeduction: best.positiveDeduction,
    isCalculable: best.isCalculable,
    candidateCount,
    calculableCount,
    tieBreak,
  };
}

/**
 * 班級與時段的來源（09 §8.2.4 方案 A）：帶入 scheduleOverride 代表已有儲存設定版本，
 * 其全量 draft 是唯一來源，不在其中的班不退回 seed；未帶入才用 seed 預設（尚無任何已儲存設定）。
 */
export function classMapFor(options: Pick<CalculationOptions, 'scheduleOverride'>): Map<string, any> {
  return options.scheduleOverride ? NO_SEED_CLASSES : seedClassMap;
}

/**
 * T05: 解析班級時段（含 alias 與 schedule 覆寫）。
 * 回傳 { sessions, status, resolvedBaseName }。
 */
export function resolveClassSessions(
  token: ParsedToken | undefined,
  aliasMap: Map<string, string> | undefined,
  scheduleOverride: Map<string, Array<{ start: number; end: number; weekday?: string | null }>> | undefined,
  classMap: Map<string, any> = seedClassMap
): {
  sessions: Array<{ start: number; end: number; weekday?: string | null }>;
  status: string;
  resolvedBaseName: string | null;
} {
  if (!token) {
    return { sessions: [], status: 'no_enrollment', resolvedBaseName: null };
  }
  const resolvedBaseName = aliasMap?.get(token.baseName) ?? token.baseName;

  const override = scheduleOverride?.get(resolvedBaseName);
  if (override) {
    if (override.length === 0) {
      return { sessions: [], status: 'schedule_empty', resolvedBaseName };
    }
    return { sessions: override, status: 'calculated', resolvedBaseName };
  }

  const cls = classMap.get(resolvedBaseName);
  if (!cls) {
    return { sessions: [], status: 'schedule_not_found', resolvedBaseName };
  }
  if (cls.source === 'empty' || cls.sessions.length === 0) {
    return { sessions: [], status: 'schedule_empty', resolvedBaseName };
  }
  const valid = cls.sessions.filter(
    (s: any) => s.startMinutes !== null && s.endMinutes !== null
  );
  if (valid.length === 0) {
    return { sessions: [], status: 'schedule_empty', resolvedBaseName };
  }
  return {
    sessions: valid.map((s: any) => ({
      start: s.startMinutes,
      end: s.endMinutes,
      weekday: s.weekday ?? null,
    })),
    status: 'calculated',
    resolvedBaseName,
  };
}

/**
 * T05: 以已解析時段計算安親/課輔扣天。
 * v2 同星期路徑下未知星期（缺失或無法識別）一律 fail-closed 為 0，並回傳 unknownWeekdayCount 供告警。
 */
function deductSessions(
  sessions: Array<{ start: number; end: number; weekday?: string | null }>,
  ruleSetVersion: RuleSetVersion = 'erp-tag-v2'
): { anqin: number; tutoring: number; unknownWeekdayCount: number } {
  const isCompat = ruleSetVersion === 'excel-v260922-compat';
  const { sameWeekdayOnly } = ruleSetCapabilities(ruleSetVersion);
  const options = { sameWeekdayOnly };

  const unknownWeekdayCount = sameWeekdayOnly
    ? sessions.filter((s) => isUnknownWeekday(s.weekday)).length
    : 0;

  const anqinRes = isCompat
    ? calculateClassDeductionCompat(sessions, 'anqin')
    : calculateClassDeductionD24(sessions, 'anqin', options);
  const tutoringRes = isCompat
    ? calculateClassDeductionCompat(sessions, 'tutoring')
    : calculateClassDeductionD24(sessions, 'tutoring', options);
  return { anqin: anqinRes.rounded, tutoring: tutoringRes.rounded, unknownWeekdayCount };
}

/**
 * 依學生之報名、標籤、年級與排課種子，計算該學生之收費、天數、折扣與問題診斷 (T03)。
 */
export function calculateStudentBilling(
  student: StudentSnapshot,
  options: CalculationOptions = {}
): StudentBillingCalculation {
  const ruleSetVersion: RuleSetVersion = options.ruleSetVersion || 'erp-tag-v2';
  const isCompat = ruleSetVersion === 'excel-v260922-compat';
  const capabilities = ruleSetCapabilities(ruleSetVersion);

  // 1. 標籤 / 備註折扣來源解析 (02 §1 & §5: formal 讀標籤, compat 讀備註)
  const discountSourceText = isCompat ? student.notesRaw : student.tagsRaw;
  const tagDiscounts = parseTagDiscounts(discountSourceText);

  const isV3 = capabilities.categoryBasedBilling;
  const resolvedEnrollments = isV3
    ? student.enrollments.map((e) =>
        resolveClassEnrollment(e, options.aliasMap, options.classSettings)
      )
    : null;

  // 2. 科數 (R09 / v3 R03) 與基本折扣 (R10)
  const subjectCount = isV3
    ? calculateSubjectCountV3(resolvedEnrollments!.map((r) => r.category))
    : calculateSubjectCount(student.enrollments);
  const baseDiscountBps = calculateBaseDiscountBps(
    subjectCount,
    tagDiscounts.sibling,
    tagDiscounts.specialDiscount
  );

  // 3. 抽取數學與美語之衝堂扣天
  let mathAnqinDed = 0;
  let mathTutoringDed = 0;
  let mathScheduleStatus = 'no_enrollment';
  let englishAnqinDed = 0;
  let englishTutoringDed = 0;
  let englishScheduleStatus = 'no_enrollment';
  let unknownWeekdayCount = 0;
  const additionalIssues: Array<{ code: string; message: string }> = [];

  /**
   * D2d B（04 §8 UX71）：v3 選班的對外輸出。
   * 兩處選班區塊（數學／美語）共用這份結果，避免各自維護一份「哪一班被選中」的推論。
   */
  const selection: StudentSelection = {};

  if (capabilities.maxDeductionSelection) {
    // v3 依類別選扣天最多 (正量最多)
    const isAnqinSide = student.grade === 1 || student.grade === 2;
    const isTutoringSide = student.grade !== null && student.grade >= 3 && student.grade <= 6;

    // --- 數學類別 ---
    const mathCandidates = student.enrollments
      .map((enr, idx) => ({ enr, idx, res: resolvedEnrollments![idx] }))
      .filter((item) => item.res.category === 'math')
      .sort((a, b) => a.idx - b.idx);

    if (mathCandidates.length > 0) {
      const evals: CandidateEval[] = [];
      for (const cand of mathCandidates) {
        const ses = resolveClassSessions(cand.enr, options.aliasMap, options.scheduleOverride, classMapFor(options));
        if (ses.status === 'calculated') {
          const ded = deductSessions(ses.sessions, ruleSetVersion);
          const pos = isAnqinSide ? -ded.anqin : isTutoringSide ? -ded.tutoring : 0;
          evals.push({
            enr: cand.enr,
            idx: cand.idx,
            status: ses.status,
            anqinDed: ded.anqin,
            tutoringDed: ded.tutoring,
            positiveDeduction: pos,
            isCalculable: true,
          });
          unknownWeekdayCount += ded.unknownWeekdayCount;
        } else {
          evals.push({
            enr: cand.enr,
            idx: cand.idx,
            status: ses.status,
            anqinDed: 0,
            tutoringDed: 0,
            positiveDeduction: 0,
            isCalculable: false,
          });
          if (ses.status === 'schedule_not_found') {
            additionalIssues.push({
              code: 'SCHEDULE_NOT_FOUND',
              message: `學生報名之數學班級「${cand.enr.rawToken}」未於${
                options.scheduleOverride ? '現行已儲存排課設定' : '排課種子'
              }中找到，天數採 0 扣天 fallback，待確認排課或 alias 對應。`,
            });
          }
        }
      }

      const calculables = evals.filter((e) => e.isCalculable);
      let mathTieBreak: ClassSelection['tieBreak'];
      if (calculables.length > 0) {
        // 取正量最多者；平手時保留報名順序較前者（只替換「嚴格大於」，不動等值者）。
        let best = calculables[0];
        for (let i = 1; i < calculables.length; i++) {
          if (calculables[i].positiveDeduction > best.positiveDeduction) {
            best = calculables[i];
          }
        }
        mathTieBreak = best === calculables[0] && calculables.length > 1 && calculables[1].positiveDeduction === best.positiveDeduction
          ? 'first_enrollment'
          : 'max_positive_deduction';
        mathAnqinDed = best.anqinDed;
        mathTutoringDed = best.tutoringDed;
        mathScheduleStatus = best.status;
        selection.math = toClassSelection(best, evals.length, calculables.length, mathTieBreak);
      } else {
        const first = evals[0];
        mathAnqinDed = 0;
        mathTutoringDed = 0;
        mathScheduleStatus = first.status;
        // 全部不可計算：仍記錄 fallback 依據的那一班，但 isCalculable=false，
        // 呼叫端不得把它當成「有扣天」（04 §8 UX67／UX73）。
        selection.math = toClassSelection(first, evals.length, 0, 'no_calculable_candidate');
      }
    }

    // --- 美語類別 ---
    const englishCandidates = student.enrollments
      .map((enr, idx) => ({ enr, idx, res: resolvedEnrollments![idx] }))
      .filter((item) => item.res.category === 'english')
      .sort((a, b) => a.idx - b.idx);

    if (englishCandidates.length > 0) {
      const evals: CandidateEval[] = [];
      for (const cand of englishCandidates) {
        const ses = resolveClassSessions(cand.enr, options.aliasMap, options.scheduleOverride, classMapFor(options));
        if (ses.status === 'calculated') {
          const ded = deductSessions(ses.sessions, ruleSetVersion);
          const pos = isAnqinSide ? -ded.anqin : isTutoringSide ? -ded.tutoring : 0;
          evals.push({
            enr: cand.enr,
            idx: cand.idx,
            status: ses.status,
            anqinDed: ded.anqin,
            tutoringDed: ded.tutoring,
            positiveDeduction: pos,
            isCalculable: true,
          });
          unknownWeekdayCount += ded.unknownWeekdayCount;
        } else {
          evals.push({
            enr: cand.enr,
            idx: cand.idx,
            status: ses.status,
            anqinDed: 0,
            tutoringDed: 0,
            positiveDeduction: 0,
            isCalculable: false,
          });
          if (ses.status === 'schedule_not_found' && capabilities.missingEnglishScheduleWarning) {
            additionalIssues.push({
              code: 'SCHEDULE_NOT_FOUND',
              message: `學生報名之美語班級「${cand.enr.rawToken}」未於${
                options.scheduleOverride ? '現行已儲存排課設定' : '排課種子'
              }中找到，天數採 0 扣天 fallback，待確認排課或 alias 對應。`,
            });
          }
        }
      }

      const calculables = evals.filter((e) => e.isCalculable);
      let englishTieBreak: ClassSelection['tieBreak'];
      if (calculables.length > 0) {
        let best = calculables[0];
        for (let i = 1; i < calculables.length; i++) {
          if (calculables[i].positiveDeduction > best.positiveDeduction) {
            best = calculables[i];
          }
        }
        englishTieBreak = best === calculables[0] && calculables.length > 1 && calculables[1].positiveDeduction === best.positiveDeduction
          ? 'first_enrollment'
          : 'max_positive_deduction';
        englishAnqinDed = best.anqinDed;
        englishTutoringDed = best.tutoringDed;
        englishScheduleStatus = best.status;
        selection.english = toClassSelection(best, evals.length, calculables.length, englishTieBreak);
      } else {
        const first = evals[0];
        englishAnqinDed = 0;
        englishTutoringDed = 0;
        englishScheduleStatus = first.status;
        selection.english = toClassSelection(first, evals.length, 0, 'no_calculable_candidate');
      }
    }
  } else {
    // v1 / v2 / compat 首班邏輯
    const mathToken = student.enrollments.find((e) => e.baseName.includes('國小數學'));
    const mathSessions = resolveClassSessions(
      mathToken, options.aliasMap, options.scheduleOverride, classMapFor(options)
    );
    mathScheduleStatus = mathSessions.status;
    if (mathSessions.status === 'calculated') {
      const ded = deductSessions(mathSessions.sessions, ruleSetVersion);
      mathAnqinDed = ded.anqin;
      mathTutoringDed = ded.tutoring;
      unknownWeekdayCount += ded.unknownWeekdayCount;
    } else if (mathSessions.status === 'schedule_not_found') {
      additionalIssues.push({
        code: 'SCHEDULE_NOT_FOUND',
        message: `學生報名之數學班級「${mathToken?.rawToken}」未於${
          options.scheduleOverride ? '現行已儲存排課設定' : '排課種子'
        }中找到，天數採 0 扣天 fallback，待確認排課或 alias 對應。`,
      });
    }

    const englishToken = student.enrollments.find((e) => e.baseName.includes('兒童美語'));
    const englishSessions = resolveClassSessions(
      englishToken, options.aliasMap, options.scheduleOverride, classMapFor(options)
    );
    englishScheduleStatus = englishSessions.status;
    if (englishSessions.status === 'calculated') {
      const ded = deductSessions(englishSessions.sessions, ruleSetVersion);
      englishAnqinDed = ded.anqin;
      englishTutoringDed = ded.tutoring;
      unknownWeekdayCount += ded.unknownWeekdayCount;
    }
  }

  // 4. 計算安親與課輔每週收費天數 (R11, R12, v3 R17)
  const hasHomeworkOrMeian = isV3
    ? resolvedEnrollments!.some((r) => r.fixedFiveDays)
    : student.enrollments.some((e) => e.baseName.includes('寫功課') || e.baseName.includes('美安'));

  const isEnrolledAnqin = isV3
    ? (student.grade === 1 || student.grade === 2) && resolvedEnrollments!.some((r) => r.category === 'care')
    : (student.grade === 1 || student.grade === 2) && student.enrollments.some((e) => e.baseName.includes('國小輔導'));

  const isEnrolledTutoring = isV3
    ? student.grade !== null && student.grade >= 3 && student.grade <= 6 && resolvedEnrollments!.some((r) => r.category === 'care')
    : student.grade !== null && student.grade >= 3 && student.grade <= 6 && student.enrollments.some((e) => e.baseName.includes('國小輔導'));

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
    } else if (capabilities.scheduleIncompleteOnUnknownWeekday && unknownWeekdayCount > 0) {
      schStatus = 'schedule_incomplete';
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
    categoryEnrollments: isV3 ? resolvedEnrollments! : undefined,
  });

  issues.push(...additionalIssues);

  // Q4-b: CLASS_NOT_MAPPED 需確認警告 (限 care / math / english 的未對應班)
  if (capabilities.unmappedClassWarning && resolvedEnrollments) {
    const unmappedSeen = new Set<string>();
    for (const r of resolvedEnrollments) {
      if (!r.mapped && (r.category === 'care' || r.category === 'math' || r.category === 'english')) {
        if (!unmappedSeen.has(r.baseName)) {
          unmappedSeen.add(r.baseName);
          issues.push({
            code: 'CLASS_NOT_MAPPED',
            message: `學生報名之班級「${r.rawToken}」班名未對應課表，請確認米豆奶班名或系統班級名稱。`,
          });
        }
      }
    }
  }

  // F3/K2: v2 同星期路徑下未知星期（缺失或無法識別）一律 fail-closed 為 0，並出告警＋needs_review，不靜默
  if (capabilities.unknownWeekdayWarning && unknownWeekdayCount > 0) {
    issues.push({
      code: 'UNKNOWN_WEEKDAY',
      message: `排課時段含 ${unknownWeekdayCount} 筆未知星期（缺失或無法識別），v2 同星期規則下該時段衝堂一律計為 0，請核對排課星期欄。`,
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
    // D2d B：只有 v3 有「選班」這件事，v1／v2／compat 維持首班語意、不輸出 selection。
    ...(isV3 ? { selection } : {}),
  };
}

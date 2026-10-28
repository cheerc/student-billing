import { StudentSnapshot, ParsedToken } from '../students/types';
import {
  StudentBillingCalculation,
  TierComparison,
  ClassSelection,
  StudentSelection,
} from './types';
import {
  parseTagDiscounts,
  calculateSubjectCountByCategory,
  calculateBaseDiscountBps,
  calculateApplicableRate,
} from './discount-rules';
import { calculateCareDays } from './care-days';
import { detectStudentIssues, compareTier } from './issues-detector';
import {
  calculateClassDeductionD24,
  isUnknownWeekday,
} from '../schedules/overlap-calculator';
import seedData from '../schedules/schedule-seed.json';
import { SEED_CLASS_TYPES } from '../schedules/seed-manifest';
import { resolveClassEnrollment, ClassSettingLookup } from '../classification/class-category';
import { projectTierForApplicability } from '../students/token-parser';

/**
 * 已解析的單一時段：分鐘制起迄、星期，以及 #113 follow-up 的**逐時段**不計扣天旗標。
 * 這裡就地定義形狀（structural typing），不 import adapters 型別——domain 不依賴 adapter。
 */
export interface ResolvedClassSession {
  start: number;
  end: number;
  weekday?: string | null;
  /** 此時段勾選「不計扣天」→ 不列入扣天。缺值＝未勾選＝false。 */
  skipDeduction?: boolean;
}

export type RuleSetVersion = 'erp-tag-v4';

export interface CalculationOptions {
  /** Runtime accepts string for boundary validation, but only v4 is calculable. */
  ruleSetVersion?: string;
  /** T05: alias 覆寫（rawToken baseName → seed baseName），不自動批准時為空 */
  aliasMap?: Map<string, string>;
  /** T05: schedule 覆寫（seed baseName → 時段 sessions），供設定維護自訂時段。
   *  #113 follow-up：每個時段自帶 `skipDeduction`（逐時段不計扣天）。 */
  scheduleOverride?: Map<string, ResolvedClassSession[]>;
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
 * 回傳 { sessions, status, resolvedBaseName }；每個時段自帶 skipDeduction（#113 follow-up 逐時段）。
 */
export function resolveClassSessions(
  token: ParsedToken | undefined,
  aliasMap: Map<string, string> | undefined,
  scheduleOverride: Map<string, ResolvedClassSession[]> | undefined,
  classMap: Map<string, any> = seedClassMap
): {
  sessions: ResolvedClassSession[];
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
  const defaultSeedSkip = SEED_CLASS_TYPES.get(resolvedBaseName) === 'other';
  return {
    sessions: valid.map((s: any) => ({
      start: s.startMinutes,
      end: s.endMinutes,
      weekday: s.weekday ?? null,
      // D61：seed 其他班預設 skipDeduction=true，其餘未指定為 false（與 buildSeedGridRows 同源）
      skipDeduction: s.skipDeduction !== undefined ? s.skipDeduction === true : defaultSeedSkip,
    })),
    status: 'calculated',
    resolvedBaseName,
  };
}

/**
 * T05: 以已解析時段計算安親/課輔扣天。
 * v2 同星期路徑下未知星期（缺失或無法識別）一律 fail-closed 為 0，並回傳 unknownWeekdayCount 供告警。
 *
 * #113 follow-up（逐時段）：只有**未勾選**的時段才納入扣天。勾選「不計扣天」的時段
 * 重疊分鐘仍由上游如實顯示（政策 vs 計算事實分開，D17），但天數一律不算它的。
 * 整班都勾選 → 扣天 0、未知星期也不計（該時段既不扣天，就不該因星期無法識別而擾動警示），
 * 而且時段仍存在、status 仍是 calculated，因此不會產生 SCHEDULE_EMPTY。
 */
function deductSessions(sessions: ResolvedClassSession[]): { anqin: number; tutoring: number; unknownWeekdayCount: number } {
  const options = { sameWeekdayOnly: true };

  const deductibleSessions = sessions.filter((s) => s.skipDeduction !== true);
  if (deductibleSessions.length === 0) {
    return { anqin: 0, tutoring: 0, unknownWeekdayCount: 0 };
  }

  const unknownWeekdayCount = deductibleSessions.filter((s) => isUnknownWeekday(s.weekday)).length;

  const anqinRes = calculateClassDeductionD24(deductibleSessions, 'anqin', options);
  const tutoringRes = calculateClassDeductionD24(deductibleSessions, 'tutoring', options);
  return { anqin: anqinRes.rounded, tutoring: tutoringRes.rounded, unknownWeekdayCount };
}

/**
 * 依學生之報名、標籤、年級與排課種子，計算該學生之收費、天數、折扣與問題診斷 (T03)。
 */
export function calculateStudentBilling(
  student: StudentSnapshot,
  options: CalculationOptions = {}
): StudentBillingCalculation {
  const requestedRuleSetVersion = options.ruleSetVersion ?? 'erp-tag-v4';
  if (requestedRuleSetVersion !== 'erp-tag-v4') {
    throw new Error(`歷史規則版本 ${requestedRuleSetVersion} 不提供新計算；請以 v4 明確升級。`);
  }

  // 新計算一律走 v4 正式規則，只讀標籤欄。
  const tagDiscounts = parseTagDiscounts(student.tagsRaw);

  const resolvedPairs = student.enrollments.map((enrollment) => {
    const resolved = resolveClassEnrollment(enrollment, options.aliasMap, options.classSettings);
    return {
      enrollment: projectTierForApplicability(enrollment, resolved.erpTierApplicability),
      resolved,
    };
  });
  const effectiveStudent: StudentSnapshot = {
    ...student,
    enrollments: resolvedPairs.map((item) => item.enrollment),
  };
  const resolvedEnrollments = resolvedPairs.map((item) => item.resolved);

  // 2. 科數 (v4 R03) 與基本折扣 (R10)
  const subjectCount = calculateSubjectCountByCategory(resolvedEnrollments.map((r) => r.category));
  const baseDiscountBps = calculateBaseDiscountBps(
    subjectCount,
    tagDiscounts.sibling,
    tagDiscounts.specialDiscount
  );

  // 3. 抽取數學、美語與其他班之衝堂扣天（D61：與是否有多科折扣 2×2 解耦）
  let mathAnqinDed = 0;
  let mathTutoringDed = 0;
  let mathScheduleStatus = 'no_enrollment';
  let englishAnqinDed = 0;
  let englishTutoringDed = 0;
  let otherAnqinDed = 0;
  let otherTutoringDed = 0;
  let unknownWeekdayCount = 0;
  const additionalIssues: Array<{ code: string; message: string }> = [];

  /**
   * D2d B（04 §8 UX71）& D61：選班的對外輸出。
   * 數學／美語／其他班共用這份結果，避免各自維護一份「哪一班被選中」的推論。
   */
  const selection: StudentSelection = {};

  /**
   * D2d D（04 §8 UX73）：逐報名課的**自身**課表解析狀態。
   */
  const statusByRawToken = new Map<string, string>();

  {
    // 依課程類型選扣天最多 (正量最多)
    const isAnqinSide = student.grade === 1 || student.grade === 2;
    const isTutoringSide = student.grade !== null && student.grade >= 3 && student.grade <= 6;

    const evaluateCandidates = (
      candidates: Array<{ enr: ParsedToken; idx: number }>,
      label: '數學' | '美語' | '其他'
    ): { anqinDed: number; tutoringDed: number; status: string; chosen?: ClassSelection } => {
      if (candidates.length === 0) {
        return { anqinDed: 0, tutoringDed: 0, status: 'no_enrollment' };
      }
      const evals: CandidateEval[] = [];
      for (const cand of candidates) {
        const ses = resolveClassSessions(
          cand.enr,
          options.aliasMap,
          options.scheduleOverride,
          classMapFor(options)
        );
        statusByRawToken.set(cand.enr.rawToken, ses.status);
        if (ses.status === 'calculated') {
          const ded = deductSessions(ses.sessions);
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
          if (ses.status === 'schedule_not_found' || ses.status === 'schedule_empty') {
            additionalIssues.push(
              ses.status === 'schedule_not_found'
                ? {
                    code: 'SCHEDULE_NOT_FOUND',
                    message: `學生報名之${label}班級「${cand.enr.rawToken}」未於${
                      options.scheduleOverride ? '現行已儲存排課設定' : '排課種子'
                    }中找到，天數採 0 扣天 fallback，待確認排課或 alias 對應。`,
                  }
                : {
                    code: 'SCHEDULE_EMPTY',
                    message: `學生報名之${label}班級「${cand.enr.rawToken}」已對應到${
                      options.scheduleOverride ? '現行已儲存排課設定' : '排課種子'
                    }但時段為空，無法計算衝堂扣天；扣天採 0 fallback，待確認該班時段。`,
                  }
            );
          }
        }
      }

      const calculables = evals.filter((e) => e.isCalculable);
      if (calculables.length > 0) {
        // 取正量最多者；平手時保留報名順序較前者（只替換「嚴格大於」，不動等值者）。
        let best = calculables[0];
        for (let i = 1; i < calculables.length; i++) {
          if (calculables[i].positiveDeduction > best.positiveDeduction) {
            best = calculables[i];
          }
        }
        const tieBreak: ClassSelection['tieBreak'] =
          best === calculables[0] &&
          calculables.length > 1 &&
          calculables[1].positiveDeduction === best.positiveDeduction
            ? 'first_enrollment'
            : 'max_positive_deduction';
        return {
          anqinDed: best.anqinDed,
          tutoringDed: best.tutoringDed,
          status: best.status,
          chosen: toClassSelection(best, evals.length, calculables.length, tieBreak),
        };
      }

      const first = evals[0];
      return {
        anqinDed: 0,
        tutoringDed: 0,
        status: first.status,
        chosen: toClassSelection(first, evals.length, 0, 'no_calculable_candidate'),
      };
    };

    const indexedEnrollments = effectiveStudent.enrollments.map((enr, idx) => ({
      enr,
      idx,
      res: resolvedEnrollments![idx],
    }));

    // --- 數學班（classType === 'math'）---
    const mathRes = evaluateCandidates(
      indexedEnrollments.filter((item) => item.res.classType === 'math').sort((a, b) => a.idx - b.idx),
      '數學'
    );
    mathAnqinDed = mathRes.anqinDed;
    mathTutoringDed = mathRes.tutoringDed;
    mathScheduleStatus = mathRes.status;
    if (mathRes.chosen) selection.math = mathRes.chosen;

    // --- 美語班（classType === 'english'）---
    const englishRes = evaluateCandidates(
      indexedEnrollments.filter((item) => item.res.classType === 'english').sort((a, b) => a.idx - b.idx),
      '美語'
    );
    englishAnqinDed = englishRes.anqinDed;
    englishTutoringDed = englishRes.tutoringDed;
    if (englishRes.chosen) selection.english = englishRes.chosen;

    // --- 其他班（classType === 'other'，Option A 所見即所得扣天）---
    const otherRes = evaluateCandidates(
      indexedEnrollments.filter((item) => item.res.classType === 'other').sort((a, b) => a.idx - b.idx),
      '其他'
    );
    otherAnqinDed = otherRes.anqinDed;
    otherTutoringDed = otherRes.tutoringDed;
    if (otherRes.chosen) selection.other = otherRes.chosen;
  }

  // 4. 計算安親與課輔每週收費天數 (R11, R12)
  const hasHomeworkOrMeian = resolvedEnrollments.some((r) => r.fixedFiveDays);

  const isEnrolledAnqin =
    (student.grade === 1 || student.grade === 2) && resolvedEnrollments.some((r) => r.category === 'care');

  const isEnrolledTutoring =
    student.grade !== null && student.grade >= 3 && student.grade <= 6 && resolvedEnrollments.some((r) => r.category === 'care');

  const careDays = calculateCareDays({
    grade: student.grade,
    mathDeductionAnqin: mathAnqinDed,
    mathDeductionTutoring: mathTutoringDed,
    englishDeductionAnqin: englishAnqinDed,
    englishDeductionTutoring: englishTutoringDed,
    otherDeductionAnqin: otherAnqinDed,
    otherDeductionTutoring: otherTutoringDed,
    extraDeduction: tagDiscounts.extraDeduction,
    hasHomeworkOrMeian,
    isEnrolledAnqin,
    isEnrolledTutoring,
  });

  // 5. 計算各課程適用折扣 (R13–R15)
  // 無報名學生（subjectCount === null）各課程適用率為 null（U39；適用率「—」維持）
  const applicableRates =
    subjectCount === null
      ? {
          anqin: null,
          tutoring: null,
          english: null,
          math: null,
          enrichment: null,
          chinese: null,
        }
      : {
          anqin: calculateApplicableRate('anqin', baseDiscountBps, tagDiscounts.internalStudent),
          tutoring: calculateApplicableRate('tutoring', baseDiscountBps, tagDiscounts.internalStudent),
          english: calculateApplicableRate('english', baseDiscountBps, tagDiscounts.internalStudent),
          math: calculateApplicableRate('math', baseDiscountBps, tagDiscounts.internalStudent),
          enrichment: calculateApplicableRate('enrichment', baseDiscountBps, tagDiscounts.internalStudent),
          chinese: calculateApplicableRate('chinese', baseDiscountBps, tagDiscounts.internalStudent),
        };

  // 6. 級距比較 (Tier Comparisons, U43, U47)
  const tierComparisons: TierComparison[] = [];
  for (const enr of effectiveStudent.enrollments) {
    let computedTierForEnr: number | null = null;
    if (student.grade === 1 || student.grade === 2) {
      computedTierForEnr = careDays.anqin.days;
    } else if (student.grade !== null && student.grade >= 3 && student.grade <= 6) {
      computedTierForEnr = careDays.tutoring.days;
    }

    // D2d D（04 §8 UX73）：優先用**這一列自己**的課表狀態；沒有逐列資訊
    // （或非數學／美語候選）時才退回原本的全班共用值。
    let schStatus = 'calculated';
    const ownStatus = statusByRawToken.get(enr.rawToken);
    if (ownStatus && ownStatus !== 'calculated' && ownStatus !== 'no_enrollment') {
      schStatus = ownStatus;
    } else if (mathScheduleStatus !== 'calculated' && mathScheduleStatus !== 'no_enrollment') {
      schStatus = mathScheduleStatus;
    } else if (unknownWeekdayCount > 0) {
      schStatus = 'schedule_incomplete';
    }

    const comp = compareTier({
      enrollmentId: `${student.personCode}_${enr.rawToken}`,
      rawToken: enr.rawToken,
      baseName: enr.baseName,
      computedTier: computedTierForEnr,
      erpDeclaredTier: enr.erpBillingTier,
      tierParseStatus: enr.tierParseStatus,
      scheduleStatus: schStatus,
    });
    tierComparisons.push(comp);
  }

  // 7. 問題診斷 (Issues Detection, R17, R18, U41)
  const issues = detectStudentIssues({
    personCode: student.personCode,
    tagsRaw: student.tagsRaw,
    notesRaw: student.notesRaw,
    enrollments: effectiveStudent.enrollments,
    sibling: tagDiscounts.sibling,
    internalStudent: tagDiscounts.internalStudent,
    specialDiscount: tagDiscounts.specialDiscount,
    isStaffFamily: tagDiscounts.isStaffFamily,
    categoryEnrollments: resolvedEnrollments,
  });

  issues.push(...additionalIssues);

  // Q4-b: CLASS_NOT_MAPPED 需確認警告。
  // #157 Ruling 3：範圍改為「所有未對應班」，不再限 care/math/english。舊制下被自動偵測成
  // none 的班名（交通車、正音班…）靜默不計入折扣，使用者無法從結果反推「這班根本沒被收錄」；
  // 現在未對應一律警告，且快照的類別一律是 unset（不是使用者指定的 none）。
  if (resolvedEnrollments) {
    const unmappedSeen = new Set<string>();
    for (const r of resolvedEnrollments) {
      if (!r.mapped) {
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
  if (unknownWeekdayCount > 0) {
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
    // v4 對外輸出選班結果，供八欄摘要與逐班扣天共用。
    selection,
  };
}

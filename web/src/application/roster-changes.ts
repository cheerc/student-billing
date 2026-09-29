import { calculateStudentBilling, resolveClassSessions, CalculationOptions } from '@/domain/billing/billing-calculator';
import { calculateClassDeductionD24 } from '@/domain/schedules/overlap-calculator';
import { StudentSnapshot } from '@/domain/students';

/**
 * 名單異動判定（operator 裁決 d-20260929111803466480-4 / d-20260929111814541876-5）。
 *
 * 「異動」是**與收費計算直接相關的最終結果變化**，以真實 before/after 計算結果判定，
 * 不是 person_code ＋ 報名 token 的指紋代理。指紋代理有兩類誤判，本模組以計算結果消除：
 *   - 報名有變但計費不變（多報一門課但兩者都滿 2 科的下限）
 *   - 報名沒變但計費變（升年級切換安親／課輔分支、標籤變動影響折扣與園內生）
 *
 * 兩類為主（operator 定義）：
 *   a. 折扣異動：basicRate（baseDiscountBps）before & after，附科數／標籤原因
 *   b. 安親／課輔扣除天數異動：before & after，附逐班衝堂明細（哪些課程時段造成）
 *
 * 沿用 settings-preview.ts:218-256 既有的 before/after 比較模式（同一個 calculateStudentBilling），
 * 不新推導計費規則、不改 domain 公式。
 */

export interface RosterChangeContext {
  aliasMap?: Map<string, string>;
  scheduleOverride?: Map<string, Array<{ start: number; end: number; weekday?: string | null }>>;
  ruleSetVersion?: CalculationOptions['ruleSetVersion'];
}

/** 單一課程（報名 token）在 before/after 的逐班衝堂結果。 */
export interface ClassBreakdown {
  baseName: string;
  rawToken: string;
  beforeAnqinDays: number | null;
  beforeTutoringDays: number | null;
  afterAnqinDays: number | null;
  afterTutoringDays: number | null;
  statusBefore: string;
  statusAfter: string;
}

export interface DayChange {
  beforeAnqinDays: number | null;
  afterAnqinDays: number | null;
  beforeTutoringDays: number | null;
  afterTutoringDays: number | null;
  /** 逐班衝堂明細：哪些課程時段造成天數變化（輔助原因，before & after 對照）。 */
  classBreakdown: ClassBreakdown[];
}

export interface DiscountChange {
  beforeBps: number | null;
  afterBps: number | null;
  beforeLabel: string;
  afterLabel: string;
  reason: string;
}

export interface RosterChangeSide {
  subjectCount: number | null;
  baseDiscountBps: number | null;
  applicableAnqinBps: number | null;
  applicableTutoringBps: number | null;
  anqinDays: number | null;
  tutoringDays: number | null;
  isEnrolledAnqin: boolean;
  isEnrolledTutoring: boolean;
}

export interface RosterChange {
  personCode: string;
  name: string;
  isNew: boolean;
  isRemoved: boolean;
  before: RosterChangeSide | null;
  after: RosterChangeSide | null;
  discountChange: DiscountChange | null;
  dayChange: DayChange | null;
  /** 輔助原因短標（可查原因，不只列數值）。 */
  reasons: string[];
}

export interface RosterChangesResult {
  changes: RosterChange[];
  stats: {
    newCount: number;
    removedCount: number;
    dayChangedCount: number;
    discountChangedCount: number;
    unchangedCount: number;
    totalStudents: number;
  };
}

/**
 * bps → 收取比例短標（UI 顯示用）。
 * 未配置（null）與「非適用」是不同於 0／100% 的狀態，不得當成 100%（09 §5.1）。
 */
export function formatDiscountBps(bps: number | null): string {
  if (bps === null) return '未設定';
  if (bps === 10000) return '無折扣';
  // bps 是「收取率」。中文短標依 operator 裁決用語「95 折 → 變 9 折」：
  // 整十收取率用一位小數（9000 → 9折、8000 → 8折），非整十用百分比（9500 → 95折、8500 → 85折）。
  const tenths = bps / 1000; // 9500 → 9.5、9000 → 9、8500 → 8.5
  return Number.isInteger(tenths) ? `${tenths}折` : `${bps / 100}折`;
}

const sideOf = (calc: ReturnType<typeof calculateStudentBilling>): RosterChangeSide => ({
  subjectCount: calc.subjectCount,
  baseDiscountBps: calc.baseDiscountBps,
  applicableAnqinBps: calc.applicableRates.anqin,
  applicableTutoringBps: calc.applicableRates.tutoring,
  anqinDays: calc.careDays.anqin.days,
  tutoringDays: calc.careDays.tutoring.days,
  isEnrolledAnqin: calc.careDays.anqin.isEnrolled,
  isEnrolledTutoring: calc.careDays.tutoring.isEnrolled,
});

/** 單一報名 token 的 before/after 逐班衝堂天數（用 resolveClassSessions + D24 規則，與 billing 同源）。 */
function breakdownFor(
  token: StudentSnapshot['enrollments'][number],
  beforeCtx: RosterChangeContext,
  afterCtx: RosterChangeContext
): ClassBreakdown {
  const single = (ctx: RosterChangeContext) => {
    const resolved = resolveClassSessions(token, ctx.aliasMap, ctx.scheduleOverride);
    const ruleSetVersion = ctx.ruleSetVersion ?? 'erp-tag-v2';
    if (resolved.status !== 'calculated') {
      return { status: resolved.status, anqin: null, tutoring: null };
    }
    // 以 domain 的 D24 單班扣除取逐堂天數，不另推公式（與 billing-calculator 同一套規則）
    const options = { sameWeekdayOnly: ruleSetVersion !== 'excel-v260922-compat' };
    return {
      status: resolved.status,
      anqin: Math.abs(calculateClassDeductionD24(resolved.sessions, 'anqin', options).rounded),
      tutoring: Math.abs(calculateClassDeductionD24(resolved.sessions, 'tutoring', options).rounded),
    };
  };
  const b = single(beforeCtx);
  const a = single(afterCtx);
  return {
    baseName: token.baseName,
    rawToken: token.rawToken,
    beforeAnqinDays: b.anqin,
    beforeTutoringDays: b.tutoring,
    afterAnqinDays: a.anqin,
    afterTutoringDays: a.tutoring,
    statusBefore: b.status,
    statusAfter: a.status,
  };
}

/**
 * 比較兩份名單（before：已儲存／上一批；after：本次上傳）並以計算結果判定異動。
 * afterStudents 為單筆或 null（測試用；正式呼叫端傳整批）。
 */
export function computeRosterChanges(
  beforeStudents: StudentSnapshot[],
  afterStudents: StudentSnapshot | null,
  beforeCtx: RosterChangeContext,
  afterCtx: RosterChangeContext,
  opts: { isFirstImport?: boolean } = {}
): RosterChangesResult {
  const changes: RosterChange[] = [];
  let newCount = 0, removedCount = 0, dayChangedCount = 0, discountChangedCount = 0, unchangedCount = 0;

  const beforeByCode = new Map(beforeStudents.map((s) => [s.personCode, s]));
  const afterList = afterStudents ? [afterStudents] : [];

  for (const after of afterList) {
    const before = opts.isFirstImport ? undefined : beforeByCode.get(after.personCode);

    if (!before) {
      newCount += 1;
      changes.push({
        personCode: after.personCode,
        name: after.name,
        isNew: true,
        isRemoved: false,
        before: null,
        after: sideOf(calculateStudentBilling(after, { ...afterCtx, ruleSetVersion: afterCtx.ruleSetVersion ?? 'erp-tag-v2' })),
        discountChange: null,
        dayChange: null,
        reasons: ['新增學生'],
      });
      continue;
    }

    const bCalc = calculateStudentBilling(before, { ...beforeCtx, ruleSetVersion: beforeCtx.ruleSetVersion ?? 'erp-tag-v2' });
    const aCalc = calculateStudentBilling(after, { ...afterCtx, ruleSetVersion: afterCtx.ruleSetVersion ?? 'erp-tag-v2' });

    const bSide = sideOf(bCalc);
    const aSide = sideOf(aCalc);

    const discountChanged = bSide.baseDiscountBps !== aSide.baseDiscountBps;
    const anqinChanged = bSide.anqinDays !== aSide.anqinDays;
    const tutoringChanged = bSide.tutoringDays !== aSide.tutoringDays;
    const rateChanged = bSide.applicableAnqinBps !== aSide.applicableAnqinBps || bSide.applicableTutoringBps !== aSide.applicableTutoringBps;
    const dayChanged = anqinChanged || tutoringChanged;

    if (!discountChanged && !dayChanged && !rateChanged) {
      unchangedCount += 1;
      continue;
    }

    const reasons: string[] = [];
    if (discountChanged) discountChangedCount += 1;
    if (dayChanged) dayChangedCount += 1;
    if (discountChanged) {
      reasons.push(bSide.subjectCount !== aSide.subjectCount ? '已補科數變動' : '標籤變動');
    }
    if (dayChanged) reasons.push('安親／課輔扣除天數變動');
    if (rateChanged && !discountChanged) reasons.push('適用率變動');

    const classBreakdown = after.enrollments.map((tok) => breakdownFor(tok, beforeCtx, afterCtx));

    changes.push({
      personCode: after.personCode,
      name: after.name,
      isNew: false,
      isRemoved: false,
      before: bSide,
      after: aSide,
      discountChange: discountChanged
        ? {
            beforeBps: bSide.baseDiscountBps,
            afterBps: aSide.baseDiscountBps,
            beforeLabel: formatDiscountBps(bSide.baseDiscountBps),
            afterLabel: formatDiscountBps(aSide.baseDiscountBps),
            reason: reasons[0] ?? '折扣變動',
          }
        : null,
      dayChange: dayChanged
        ? {
            beforeAnqinDays: bSide.anqinDays,
            afterAnqinDays: aSide.anqinDays,
            beforeTutoringDays: bSide.tutoringDays,
            afterTutoringDays: aSide.tutoringDays,
            classBreakdown,
          }
        : null,
      reasons,
    });
  }

  // 退出名單（before 有、after 無）
  if (afterStudents === null && !opts.isFirstImport) {
    for (const before of beforeStudents) {
      if (!afterList.some((a) => a.personCode === before.personCode)) {
        removedCount += 1;
        changes.push({
          personCode: before.personCode,
          name: before.name,
          isNew: false,
          isRemoved: true,
          before: sideOf(calculateStudentBilling(before, { ...beforeCtx, ruleSetVersion: beforeCtx.ruleSetVersion ?? 'erp-tag-v2' })),
          after: null,
          discountChange: null,
          dayChange: null,
          reasons: ['本次名單未出現'],
        });
      }
    }
  }

  return {
    changes,
    stats: {
      newCount,
      removedCount,
      dayChangedCount,
      discountChangedCount,
      unchangedCount,
      totalStudents: afterList.length || beforeStudents.length,
    },
  };
}

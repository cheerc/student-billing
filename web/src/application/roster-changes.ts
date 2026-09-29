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
 *
 * 呼叫端（application/import-roster-diff.ts → POST /api/v1/imports/preview）一律傳**整批**名單：
 * before 名單 vs after 名單，新增／異動／退出三類在同一次呼叫內判定（Reviewer B1，PR #32）。
 */

export interface RosterChangeContext {
  aliasMap?: Map<string, string>;
  scheduleOverride?: Map<string, Array<{ start: number; end: number; weekday?: string | null }>>;
  ruleSetVersion?: CalculationOptions['ruleSetVersion'];
}

/**
 * 單一課程（報名 token）在 before/after 的逐班衝堂結果。
 *
 * 明細是 before 名單與 after 名單各自**實際參與計費**的課的聯集（Reviewer B2，PR #32）：
 * domain 只取每位學生「第一個國小數學」與「第一個兒童美語」計算扣天（billing-calculator.ts），
 * 其餘課程（第二門數學、國小輔導等）不影響天數，列進來只會誤導，所以不列。
 *   - presence（以**報名**判定）：removed＝只在 before（退掉）、added＝只在 after（新報）、kept＝兩側都有
 *   - `*Deduction`：該側該班被照顧窗扣掉的天數（正值，D24 取整後）。**null＝該側沒有此課，或有報但不計入**
 *     （不是「扣 0 天」）；statusBefore/After 說明原因：'no_enrollment' 未報名、'not_counted' 已報名但不計費
 * `*Deduction` 是單班扣除量，不是學生的計費天數；學生層天數在 DayChange.before/afterAnqinDays 等欄位。
 */
export interface ClassBreakdown {
  baseName: string;
  rawToken: string;
  presence: 'removed' | 'added' | 'kept';
  beforeAnqinDeduction: number | null;
  beforeTutoringDeduction: number | null;
  afterAnqinDeduction: number | null;
  afterTutoringDeduction: number | null;
  /** 該側課表解析狀態：'calculated'、'schedule_empty'…；'no_enrollment'＝未報名；'not_counted'＝已報名但不計入扣天。 */
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
    /** 前後都在名單、且折扣／適用率／天數任一有變的人數（不含新增與退出）。 */
    changedCount: number;
    dayChangedCount: number;
    discountChangedCount: number;
    unchangedCount: number;
    /** 本次名單（after，依人員代碼去重）的人數。 */
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

type Token = StudentSnapshot['enrollments'][number];

/** 單一報名 token 在某一側（名單＋課表 context）的逐班扣天數；token 不在該側名單時 status='no_enrollment'。 */
function classSide(token: Token | undefined, ctx: RosterChangeContext) {
  const resolved = resolveClassSessions(token, ctx.aliasMap, ctx.scheduleOverride);
  if (!token || resolved.status !== 'calculated') {
    return { status: resolved.status, anqin: null as number | null, tutoring: null as number | null };
  }
  const ruleSetVersion = ctx.ruleSetVersion ?? 'erp-tag-v2';
  // 以 domain 的 D24 單班扣除取逐堂天數，不另推公式（與 billing-calculator 同一套規則）
  const options = { sameWeekdayOnly: ruleSetVersion !== 'excel-v260922-compat' };
  return {
    status: resolved.status,
    anqin: Math.abs(calculateClassDeductionD24(resolved.sessions, 'anqin', options).rounded),
    tutoring: Math.abs(calculateClassDeductionD24(resolved.sessions, 'tutoring', options).rounded),
  };
}

/**
 * 學生名單中實際參與扣天計算的 token（rawToken 集合）。
 * 鏡像 billing-calculator.ts 的取法：第一個 baseName 含「國小數學」者、第一個含「兒童美語」者。
 * （不改 domain；一致性由 roster-changes.test.ts 的「第二門數學不計入」與逐班加總對照測試釘住。）
 */
function countedRawTokens(student: StudentSnapshot): Set<string> {
  const out = new Set<string>();
  const math = student.enrollments.find((e) => e.baseName.includes('國小數學'));
  const english = student.enrollments.find((e) => e.baseName.includes('兒童美語'));
  if (math) out.add(math.rawToken);
  if (english) out.add(english.rawToken);
  return out;
}

/**
 * 逐班衝堂明細：before 與 after 兩側**計入扣天**的課的聯集，以 rawToken 為同一門課的身分。
 * 順序＝先 before 側，再接 after 側新出現的課。
 */
function buildClassBreakdown(
  before: StudentSnapshot,
  after: StudentSnapshot,
  beforeCtx: RosterChangeContext,
  afterCtx: RosterChangeContext
): ClassBreakdown[] {
  const tokenOf = (s: StudentSnapshot) => {
    const m = new Map<string, Token>();
    for (const t of s.enrollments) if (!m.has(t.rawToken)) m.set(t.rawToken, t);
    return m;
  };
  const beforeTokens = tokenOf(before);
  const afterTokens = tokenOf(after);
  const beforeCounted = countedRawTokens(before);
  const afterCounted = countedRawTokens(after);

  const side = (tok: Token | undefined, counted: boolean, ctx: RosterChangeContext) =>
    counted ? classSide(tok, ctx) : { status: tok ? 'not_counted' : 'no_enrollment', anqin: null, tutoring: null };

  const rows: ClassBreakdown[] = [];
  const keys = [...beforeCounted, ...[...afterCounted].filter((k) => !beforeCounted.has(k))];
  for (const key of keys) {
    const b = beforeTokens.get(key);
    const a = afterTokens.get(key);
    const bSide = side(b, beforeCounted.has(key), beforeCtx);
    const aSide = side(a, afterCounted.has(key), afterCtx);
    rows.push({
      baseName: (b ?? a)!.baseName,
      rawToken: key,
      presence: b && a ? 'kept' : b ? 'removed' : 'added',
      beforeAnqinDeduction: bSide.anqin,
      beforeTutoringDeduction: bSide.tutoring,
      afterAnqinDeduction: aSide.anqin,
      afterTutoringDeduction: aSide.tutoring,
      statusBefore: bSide.status,
      statusAfter: aSide.status,
    });
  }
  return rows;
}

/** 依人員代碼去重，同代碼取第一列（與匯入預覽「去重人數」一致）。 */
function uniqueByPersonCode(list: StudentSnapshot[]): Map<string, StudentSnapshot> {
  const map = new Map<string, StudentSnapshot>();
  for (const s of list) if (!map.has(s.personCode)) map.set(s.personCode, s);
  return map;
}

/**
 * 比較兩份**整批**名單（before：現行名單；after：本次上傳）並以計算結果判定異動。
 *
 * 三類在同一次呼叫內判定：
 *   - 新增：after 有、before 無
 *   - 退出（本次未出現）：before 有、after 無
 *   - 異動：兩邊都有，且折扣、適用率或安親／課輔天數任一在 before/after 計算結果不同
 * 兩邊都有但計算結果全部相同者不列入 changes，只計入 stats.unchangedCount。
 * before 為空陣列時，after 全部是新增。
 */
export function computeRosterChanges(
  beforeStudents: StudentSnapshot[],
  afterStudents: StudentSnapshot[],
  beforeCtx: RosterChangeContext,
  afterCtx: RosterChangeContext
): RosterChangesResult {
  const changes: RosterChange[] = [];
  let newCount = 0, removedCount = 0, changedCount = 0, dayChangedCount = 0, discountChangedCount = 0, unchangedCount = 0;

  const beforeByCode = uniqueByPersonCode(beforeStudents);
  const afterByCode = uniqueByPersonCode(afterStudents);
  const calcBefore = (s: StudentSnapshot) =>
    calculateStudentBilling(s, { ...beforeCtx, ruleSetVersion: beforeCtx.ruleSetVersion ?? 'erp-tag-v2' });
  const calcAfter = (s: StudentSnapshot) =>
    calculateStudentBilling(s, { ...afterCtx, ruleSetVersion: afterCtx.ruleSetVersion ?? 'erp-tag-v2' });

  for (const after of afterByCode.values()) {
    const before = beforeByCode.get(after.personCode);

    if (!before) {
      newCount += 1;
      changes.push({
        personCode: after.personCode,
        name: after.name,
        isNew: true,
        isRemoved: false,
        before: null,
        after: sideOf(calcAfter(after)),
        discountChange: null,
        dayChange: null,
        reasons: ['新增學生'],
      });
      continue;
    }

    const bSide = sideOf(calcBefore(before));
    const aSide = sideOf(calcAfter(after));

    const discountChanged = bSide.baseDiscountBps !== aSide.baseDiscountBps;
    const anqinChanged = bSide.anqinDays !== aSide.anqinDays;
    const tutoringChanged = bSide.tutoringDays !== aSide.tutoringDays;
    const rateChanged = bSide.applicableAnqinBps !== aSide.applicableAnqinBps || bSide.applicableTutoringBps !== aSide.applicableTutoringBps;
    const dayChanged = anqinChanged || tutoringChanged;

    if (!discountChanged && !dayChanged && !rateChanged) {
      unchangedCount += 1;
      continue;
    }

    changedCount += 1;
    const reasons: string[] = [];
    if (discountChanged) discountChangedCount += 1;
    if (dayChanged) dayChangedCount += 1;
    if (discountChanged) {
      reasons.push(bSide.subjectCount !== aSide.subjectCount ? '已補科數變動' : '標籤變動');
    }
    if (dayChanged) reasons.push('安親／課輔扣除天數變動');
    if (rateChanged && !discountChanged) reasons.push('適用率變動');

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
            classBreakdown: buildClassBreakdown(before, after, beforeCtx, afterCtx),
          }
        : null,
      reasons,
    });
  }

  // 退出（本次名單未出現）：before 有、after 無
  for (const before of beforeByCode.values()) {
    if (afterByCode.has(before.personCode)) continue;
    removedCount += 1;
    changes.push({
      personCode: before.personCode,
      name: before.name,
      isNew: false,
      isRemoved: true,
      before: sideOf(calcBefore(before)),
      after: null,
      discountChange: null,
      dayChange: null,
      reasons: ['本次名單未出現'],
    });
  }

  return {
    changes,
    stats: {
      newCount,
      removedCount,
      changedCount,
      dayChangedCount,
      discountChangedCount,
      unchangedCount,
      totalStudents: afterByCode.size,
    },
  };
}

import { calculateStudentBilling, classMapFor, resolveClassSessions, CalculationOptions } from '@/domain/billing/billing-calculator';
import { calculateClassDeductionD24 } from '@/domain/schedules/overlap-calculator';
import { StudentSnapshot } from '@/domain/students';
import type { StudentBillingCalculation } from '@/domain/billing/types';
import { applicableRateForClass } from '@/application/applicable-rate';
import { resolveClassEnrollment, type ClassCategory, type ClassSettingLookup } from '@/domain/classification/class-category';
import { calculateSubjectCount, calculateSubjectCountV3 } from '@/domain/billing/discount-rules';
import { ruleSetCapabilities } from '@/domain/billing/rule-set';

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
  /**
   * D2a：班級設定（手動／自動類別與固定 5 天）。**與 run 端同源**（calculate-run 的
   * `buildClassSettingMap(resolveLatestSavedSettings(db).draft)`，specs/11 §3 B1-D 同源要求）：
   * 異動明細的 before 側必須與「按下之後系統實際會用的狀態」一致（D17），不可退回自動偵測。
   */
  classSettings?: Map<string, ClassSettingLookup>;
}

/** 有折扣語意的班級類別（'none'＝不列入折扣，例如寫功課／交通車）。 */
export type DiscountClassCategory = Exclude<ClassCategory, 'none'>;

/**
 * 實際報名班級的集合變化（Round3 PR-1；decisions -68／-75；specs/06 D43）。
 *
 * 以 **rawToken** 為同一門課的身分，比對 before／after 兩側的**全部**報名班——
 * 包含 care、數學、美語，也包含不列入折扣的班（寫功課、交通車）：-75 要求
 * 「新增／退出／換班即使折扣未變也要獨立列出」，所以這裡不能用「計入扣天的班」當集合。
 * 班名用**名冊原文** `baseName`（spike §A5），不是 alias 後的系統班名。
 *
 * `switched` 僅在能可靠配對（同類別、一對一）時給出；否則由 added ＋ removed 表達（-68）。
 */
export interface EnrollmentChange {
  /** 名冊原文班名 */
  baseName: string;
  rawToken: string;
  presence: 'added' | 'removed' | 'kept' | 'switched';
  /** switched 時：配對到的另一個 rawToken（同類別一對一配對） */
  switchedWith?: string;
}

/** 逐班折扣變動的結構化原因（資料，不是文案；文案由 PR-2 定稿渲染）。 */
export type ClassDiscountReason =
  | { kind: 'enrollment_added' | 'enrollment_removed'; className: string; /** additive：名冊原文 rawToken（decision d-20261003090015932342-4）；舊 payload／測試缺此欄位時 UI 回退 className。 */ rawToken?: string }
  | { kind: 'tag_added' | 'tag_removed'; tag: string };

/**
 * 單一**實際報名班**的 before → after 適用折扣（spike §A2：不新增計算，搬既有值）。
 *
 * 取值規則（decisions -75）：
 *  - 只在「該生實際報名此班」的一側取值；未報名一側為 null，且**不因此產生折扣變動項**
 *    （不得顯示「無折扣 → X」的假異動）。
 *  - `not_configured`（該班沒有折扣類別）不產生任何變動項（-68）。
 *  - 同類多班各自一項，不合併（D17 照實呈現；Lead 裁定）。
 */
export interface ClassDiscountChange {
  baseName: string;
  rawToken: string;
  /** 折扣語意類別（care／math／english） */
  sideOf: DiscountClassCategory;
  beforeBps: number | null;
  afterBps: number | null;
  reasons: ClassDiscountReason[];
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
  /** 數學／美語適用率（spike §A2a：既有計算值，純搬資料，不新增計算）。 */
  applicableMathBps: number | null;
  applicableEnglishBps: number | null;
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
  /**
   * 輔助原因短標（學生層；PR-2 畫面不再呈現，保留供 API consumer 與診斷使用）。
   * 逐班的折扣變動原因在 `classDiscountChanges[].reasons`（-76 的呈現來源）。
   */
  reasons: string[];
  /**
   * 實際報名班級集合的前後變化（Round3 PR-1，decisions -68／-75）。additive：不影響既有 reasons 與計數。
   * 新增／退出／換班即使折扣與天數皆未變，這裡仍會列出，且該生也算「異動」（-75）。
   */
  enrollmentChanges: EnrollmentChange[];
  /** 逐班適用折扣的前後變化（decisions -68；未報名一側不取值、not_configured 不列）。additive。 */
  classDiscountChanges: ClassDiscountChange[];
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

/** student 的年級（適用率取值需要：1–2 年級安親側、3–6 年級課輔側）。只讀不判定。 */
const gradeOf = (student: StudentSnapshot | undefined): number | null => student?.grade ?? null;

/** 該側學生層的適用率欄位（applicableRateForClass 的輸入）。 */
const rateFieldsOf = (
  calc: ReturnType<typeof calculateStudentBilling>,
  grade: number | null
) => ({
  grade,
  applicableAnqinBps: calc.applicableRates.anqin,
  applicableTutoringBps: calc.applicableRates.tutoring,
  applicableMathBps: calc.applicableRates.math,
  applicableEnglishBps: calc.applicableRates.english,
});

const sideOf = (calc: ReturnType<typeof calculateStudentBilling>): RosterChangeSide => ({
  subjectCount: calc.subjectCount,
  baseDiscountBps: calc.baseDiscountBps,
  applicableAnqinBps: calc.applicableRates.anqin,
  applicableTutoringBps: calc.applicableRates.tutoring,
  applicableMathBps: calc.applicableRates.math,
  applicableEnglishBps: calc.applicableRates.english,
  anqinDays: calc.careDays.anqin.days,
  tutoringDays: calc.careDays.tutoring.days,
  isEnrolledAnqin: calc.careDays.anqin.isEnrolled,
  isEnrolledTutoring: calc.careDays.tutoring.isEnrolled,
});

type Token = StudentSnapshot['enrollments'][number];

/** 單一報名 token 在某一側（名單＋課表 context）的逐班扣天數；token 不在該側名單時 status='no_enrollment'。 */
function classSide(token: Token | undefined, ctx: RosterChangeContext) {
  // 班級來源與 calculator 一致（D1 F-7）：帶 scheduleOverride＝已有儲存設定，其全量 draft 是唯一來源、不退回 seed；
  // 否則用 seed。之前這裡沒帶 classMap（預設 seed），會與 calculator 對同一位學生的判斷互相矛盾。
  const resolved = resolveClassSessions(token, ctx.aliasMap, ctx.scheduleOverride, classMapFor(ctx));
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
 *
 * D2d B（04 §8 UX71；D40 Q10-A）：**鏡像 calculator 的選班結果，不再各自取首班**。
 *  - v3：讀 `calc.selection` 的選中班（取正量最多、平手取報名順序在前者）——
 *    否則明細會顯示 Gino 的扣天、而學生天數其實是按 Chevady 算出來的，屬鏡像不一致。
 *  - v1／v2／compat：無 `selection`，維持首班語意。
 * `selection` 沒有對應類別（學生沒報該類）時不列入，與 calculator 的候選集合一致。
 */
function countedRawTokens(student: StudentSnapshot, calc: StudentBillingCalculation): Set<string> {
  const out = new Set<string>();
  const sel = calc.selection;
  if (sel) {
    if (sel.math) out.add(sel.math.selectedRawToken);
    if (sel.english) out.add(sel.english.selectedRawToken);
    return out;
  }
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
  afterCtx: RosterChangeContext,
  beforeCalc: StudentBillingCalculation,
  afterCalc: StudentBillingCalculation
): ClassBreakdown[] {
  const tokenOf = (s: StudentSnapshot) => {
    const m = new Map<string, Token>();
    for (const t of s.enrollments) if (!m.has(t.rawToken)) m.set(t.rawToken, t);
    return m;
  };
  const beforeTokens = tokenOf(before);
  const afterTokens = tokenOf(after);
  const beforeCounted = countedRawTokens(before, beforeCalc);
  const afterCounted = countedRawTokens(after, afterCalc);

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

/**
 * 折扣語意類別：以**課表設定**（手動優先）解析，與 run 端同一條路徑（resolveClassEnrollment）。
 * 'none'（寫功課、交通車等不列入折扣的班）回 null——-68：未設定折扣類別的班不列。
 */
function discountCategoryOf(
  token: Token,
  ctx: RosterChangeContext
): DiscountClassCategory | null {
  const resolved = resolveClassEnrollment(token, ctx.aliasMap, ctx.classSettings);
  return resolved.category === 'none' ? null : resolved.category;
}

/**
 * 讓 `hasHomeworkOrMeian` 改變的班（寫功課／美安），與 billing-calculator 同源判定。
 * v3：該生任一報名班 fixedFiveDays 為真（billing-calculator:433-435）；v1／v2：名稱含寫功課或美安。
 * **不另寫一套字串規則**：此處只用來判斷「這個 none 類別班是否值得作為原因」，
 * 實際數值仍由 calculator 的 hasHomeworkOrMeian 決定。
 */
function affectsHomeworkOrMeian(token: Token, ctx: RosterChangeContext): boolean {
  const resolved = resolveClassEnrollment(token, ctx.aliasMap, ctx.classSettings);
  return resolved.fixedFiveDays || token.baseName.includes('寫功課') || token.baseName.includes('美安');
}

/**
 * 某人某側的「計入科數」值——**與 calculator 同一條規則**：
 * v3 走類別式（R03 calculateSubjectCountV3），v1／v2／compat 走名稱式（R09 calculateSubjectCount）。
 * 這裡不重寫規則，只挑對應的函式。
 */
function countedSubjectCount(
  student: StudentSnapshot | undefined,
  ctx: RosterChangeContext
): number | null {
  const tokens = student?.enrollments ?? [];
  const version = ctx.ruleSetVersion ?? 'erp-tag-v2';
  return ruleSetCapabilities(version).categoryBasedBilling
    ? calculateSubjectCountV3(tokens.map((t) => resolveClassEnrollment(t, ctx.aliasMap, ctx.classSettings).category))
    : calculateSubjectCount(tokens);
}

/**
 * 某個報名班「是否決定了計入科數」：把它的**類別**從兩側合併的報名集合中拿掉後，計入科數是否下降。
 *
 * 計入是存在性（R09 名稱式／R03 類別式：同類只算 1 科），且要看**兩側合併**：
 *  - 同類換班（三A → 三B）：拿掉三A，數學仍由三B 代表 → 計入不變 → 不是決定者（Lead r1 裁定）。
 *  - 唯一一個數學班的新增／退出：拿掉後數學類別消失 → 計入下降 → 是決定者。
 *  - 同時加入兩個數學班：拿掉任一個，另一個仍在 → 兩個都不是決定者（誠實呈現，reasons 可能為空）。
 *
 * 實作直接呼叫 calculator 用的同一組規則函式（v3 類別式／v1、v2 名稱式含寫功課減 1），不另推規則。
 */
function decidesSubjectCount(
  allTokens: Token[],
  ctx: RosterChangeContext,
  token: Token
): boolean {
  const countOf = (list: Token[]) =>
    countedSubjectCount({ enrollments: list } as unknown as StudentSnapshot, ctx);
  const withToken = countOf(allTokens);
  const withoutToken = countOf(allTokens.filter((t) => t.rawToken !== token.rawToken));
  return withToken !== withoutToken;
}

/** 以 rawToken 為身分建立 token 索引（同一門課在 before／after 的身分）。 */
function tokenIndex(student: StudentSnapshot | undefined): Map<string, Token> {
  const map = new Map<string, Token>();
  for (const t of student?.enrollments ?? []) if (!map.has(t.rawToken)) map.set(t.rawToken, t);
  return map;
}

/**
 * 實際報名班級集合的前後變化（decisions -68／-75）。
 *
 * 集合是「該生全部報名班」，不是「計入扣天的班」（spike §B3：care／寫功課班現行完全不出現）。
 * 順序：先 before 側（依名冊順序），再接 after 側新出現的班。
 *
 * `switched` 只在**同類別、一對一**可靠配對時給出：removed 與 added 各只有一個且類別相同。
 * 其他情形（例如三個數學班換成兩個）由 added ＋ removed 表達，不猜（-68）。
 */
function buildEnrollmentChanges(
  before: StudentSnapshot | undefined,
  after: StudentSnapshot | undefined,
  beforeCtx: RosterChangeContext,
  afterCtx: RosterChangeContext
): EnrollmentChange[] {
  const beforeTokens = tokenIndex(before);
  const afterTokens = tokenIndex(after);
  const keys = [...beforeTokens.keys(), ...[...afterTokens.keys()].filter((k) => !beforeTokens.has(k))];

  const rows: EnrollmentChange[] = keys.map((key) => {
    const b = beforeTokens.get(key);
    const a = afterTokens.get(key);
    return {
      baseName: (b ?? a)!.baseName,
      rawToken: key,
      presence: b && a ? ('kept' as const) : b ? ('removed' as const) : ('added' as const),
    };
  });

  // 同類別一對一配對 → switched（可靠才配對，否則維持 added／removed）
  const removed = rows.filter((r) => r.presence === 'removed');
  const added = rows.filter((r) => r.presence === 'added');
  if (removed.length === 1 && added.length === 1) {
    const removedCategory = discountCategoryOf(
      beforeTokens.get(removed[0].rawToken)!,
      beforeCtx
    );
    const addedCategory = discountCategoryOf(afterTokens.get(added[0].rawToken)!, afterCtx);
    // 'both none' 代表兩班都不列入折扣（寫功課換班）——那也屬同類換班
    const sameCategory =
      removedCategory === addedCategory || (removedCategory === null && addedCategory === null);
    if (sameCategory) {
      removed[0].presence = 'switched';
      removed[0].switchedWith = added[0].rawToken;
      added[0].presence = 'switched';
      added[0].switchedWith = removed[0].rawToken;
    }
  }
  return rows;
}

/** 逐標籤字串集合（parseTagDiscounts 不回命中 tag，需自行以逐字串比對；specs/02:167 正式軌不從備註 fallback）。 */
function tagListOf(student: StudentSnapshot | undefined): Set<string> {
  return new Set((student?.tags ?? []).filter(Boolean));
}

/**
 * 影響合計折扣的標籤變化（spike §A3(c)）：兄弟姊妹、特殊折扣、園內生。
 * 兩側都有同一標籤 → 不是原因（值未因它改變）。
 */
function tagReasonsOf(
  before: StudentSnapshot | undefined,
  after: StudentSnapshot | undefined
): ClassDiscountReason[] {
  const beforeTags = tagListOf(before);
  const afterTags = tagListOf(after);
  const out: ClassDiscountReason[] = [];
  for (const tag of afterTags) {
    if (!beforeTags.has(tag)) out.push({ kind: 'tag_added', tag });
  }
  for (const tag of beforeTags) {
    if (!afterTags.has(tag)) out.push({ kind: 'tag_removed', tag });
  }
  return out;
}

/**
 * 逐班適用折扣的前後變化（decisions -68；spike §A2：不新增計算）。
 *
 * 對 before／after 皆有報名的班，以 `applicableRateForClass` 取兩側值：
 *  - not_configured → 不列（-68）
 *  - 只有實際報名的一側取值；未報名一側為 null 且**不產生變動項**（-75，不造「無折扣 → X」假異動）
 *  - 只收 beforeBps !== afterBps 的班（沒變的不列）
 */
function buildClassDiscountChanges(
  before: StudentSnapshot | undefined,
  after: StudentSnapshot | undefined,
  beforeCtx: RosterChangeContext,
  afterCtx: RosterChangeContext,
  beforeCalc: StudentBillingCalculation | null,
  afterCalc: StudentBillingCalculation | null,
  enrollmentChanges: EnrollmentChange[]
): ClassDiscountChange[] {
  if (!before || !after || !beforeCalc || !afterCalc) return [];
  const beforeTokens = tokenIndex(before);
  const afterTokens = tokenIndex(after);
  const tagReasons = tagReasonsOf(before, after);

  // 報名原因：歸因到**實際報名增減的那個班名**（decisions -68「逐班列班級名稱：前 → 後」）。
  // 注意方向：真正變動的項目一定是「兩側都報名」的班，而增減的那個班本身因為未報名一側無值而不列。
  // Lead r1 裁定：報名原因只列「真的會影響該班適用率輸入」者。
  //   - 計入科數的類別集合（R10）＋兄弟姊妹＋特殊折扣 → 影響所有類別；
  //   - 園內生 → 只影響安親（care）；寫功課／美安（hasHomeworkOrMeian）→ 只影響安親／課輔（care）。
  // 因此逐班決定它能接受哪些報名原因：
  //   - 對 everyChange：在 before/after 任一側**新出現**的計入類別（集合因此改變）→ 可掛所有計入類別的增減。
  //   - 對 this class：該生報名增減中，會改變 hasHomeworkOrMeian 且該班為 care → 可掛寫功課／美安的增減。
  //   - 其餘 none 類別班（交通車、國語文、加強班…）永不列為原因。
  const addedTokens = enrollmentChanges.filter((e) => e.presence === 'added' || e.presence === 'switched');
  const removedTokens = enrollmentChanges.filter((e) => e.presence === 'removed' || e.presence === 'switched');

  const rows: ClassDiscountChange[] = [];
  for (const key of beforeTokens.keys()) {
    if (!afterTokens.has(key)) continue; // 只處理兩側皆有報名的班
    const token = beforeTokens.get(key)!;
    const category = discountCategoryOf(token, beforeCtx) ?? discountCategoryOf(token, afterCtx);
    if (category === null) continue; // not_configured：-68 不列

    const rateOf = (calc: StudentBillingCalculation, grade: number | null) =>
      applicableRateForClass(token.baseName, rateFieldsOf(calc, grade));
    const beforeRate = rateOf(beforeCalc, gradeOf(before));
    const afterRate = rateOf(afterCalc, gradeOf(after));
    if (beforeRate.status !== 'configured' || afterRate.status !== 'configured') continue;
    if (beforeRate.bps === afterRate.bps) continue; // 沒變不列

    const reasons: ClassDiscountReason[] = [];
    const isCare = category === 'care';
    // 報名原因：只列「真的會影響該班適用率輸入」的增減。對計入科數的類別（care／math／english）而言，
    // 該類別在 before／after 任一側**新出現或消失**才是原因（集合因此改變）；同類換班、同類多一班不列。
    // 其餘 none 類別班只有「會改變 hasHomeworkOrMeian」且只掛 care（寫功課／美安）。
    for (const change of addedTokens) {
      const token = afterTokens.get(change.rawToken)!;
      // 決定了計入科數 → 原因；或改變 hasHomeworkOrMeian 且本班是 care（安親／課輔會回到 10000）
      if (
        decidesSubjectCount([...before.enrollments, ...after.enrollments], beforeCtx, token) ||
        (isCare && affectsHomeworkOrMeian(token, afterCtx))
      ) {
        reasons.push({ kind: 'enrollment_added', className: change.baseName, rawToken: change.rawToken });
      }
    }
    for (const change of removedTokens) {
      const token = beforeTokens.get(change.rawToken)!;
      if (
        decidesSubjectCount([...before.enrollments, ...after.enrollments], beforeCtx, token) ||
        (isCare && affectsHomeworkOrMeian(token, beforeCtx))
      ) {
        reasons.push({ kind: 'enrollment_removed', className: change.baseName, rawToken: change.rawToken });
      }
    }
    // 標籤原因：兄弟姊妹／特殊折扣 → 所有類別；園內生 → 只掛 care（增減皆然，R13 只改安親適用率）
    if (isCare) reasons.push(...tagReasons);
    else reasons.push(...tagReasons.filter((r) => !(r.kind === 'tag_added' || r.kind === 'tag_removed') || r.tag !== '園內生'));

    rows.push({
      baseName: token.baseName,
      rawToken: key,
      sideOf: category,
      beforeBps: beforeRate.bps,
      afterBps: afterRate.bps,
      reasons,
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
      const newEnrollmentChanges = buildEnrollmentChanges(undefined, after, beforeCtx, afterCtx);
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
        enrollmentChanges: newEnrollmentChanges,
        // 新增學生沒有「前後折扣」可比：不產生假異動（-75）
        classDiscountChanges: [],
      });
      continue;
    }

    const bCalc = calcBefore(before);
            const aCalc = calcAfter(after);
            const bSide = sideOf(bCalc);
            const aSide = sideOf(aCalc);

    const discountChanged = bSide.baseDiscountBps !== aSide.baseDiscountBps;
    const anqinChanged = bSide.anqinDays !== aSide.anqinDays;
    const tutoringChanged = bSide.tutoringDays !== aSide.tutoringDays;
    const rateChanged = bSide.applicableAnqinBps !== aSide.applicableAnqinBps || bSide.applicableTutoringBps !== aSide.applicableTutoringBps;
    const dayChanged = anqinChanged || tutoringChanged;

    // PR-1：報名班級集合有變也算異動（decisions -75：新增／退出／換班即使折扣未變也要出現）。
    // 修 spike §B1 RC04（只有寫功課 → 加報數學，現行判為未異動）與 §B3 CB（同類換班）。
    const enrollmentChanges = buildEnrollmentChanges(before, after, beforeCtx, afterCtx);
    const enrollmentChanged = enrollmentChanges.some((e) => e.presence !== 'kept');

    if (!discountChanged && !dayChanged && !rateChanged && !enrollmentChanged) {
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
            classBreakdown: buildClassBreakdown(before, after, beforeCtx, afterCtx, bCalc, aCalc),
          }
        : null,
      reasons,
      enrollmentChanges,
      classDiscountChanges: buildClassDiscountChanges(
        before,
        after,
        beforeCtx,
        afterCtx,
        bCalc,
        aCalc,
        enrollmentChanges
      ),
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
      enrollmentChanges: buildEnrollmentChanges(before, undefined, beforeCtx, afterCtx),
      // 本次未出現：沒有 after 側可比：不產生假異動（-75）
      classDiscountChanges: [],
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

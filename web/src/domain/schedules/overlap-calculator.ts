export interface WindowRange {
  start: number; // 分鐘 (0–1440)
  end: number;
  weekdays?: readonly string[] | string[];
}

export const CARE_WINDOW_WEEKDAYS = ['一', '二', '三', '四', '五'] as const;

export const CARE_WINDOWS = {
  anqin: { start: 780, end: 960, weekdays: CARE_WINDOW_WEEKDAYS }, // 13:00–16:00
  tutoring: { start: 990, end: 1170, weekdays: CARE_WINDOW_WEEKDAYS }, // 16:30–19:30
} as const;

export interface SessionTime {
  start: number; // 分鐘 (從 00:00 起算)
  end: number;
  weekday?: string | null;
}

export interface SessionDeductionResult {
  overlapMinutes: number;
  rawDeduction: number;
  isSpecialTutoringRule: boolean;
}

export interface ClassDeductionResult {
  totalOverlapMinutes: number;
  raw: number;
  rounded: number;
}

export interface RuleSetOptions {
  minutesPerBillingDay?: number;
  zeroBelow?: number;
  fullAtOrAbove?: number;
  anqinWindow?: WindowRange;
  tutoringWindow?: WindowRange;
  sameWeekdayOnly?: boolean; // D30: 同星期才計入衝堂
}

/**
 * 正規化星期輸入文字為標準單字（'一'～'日'），無法識別則回傳 null。
 */
export function normalizeWeekday(w: string | null | undefined): string | null {
  if (!w) return null;
  const trimmed = w.trim();
  if (/^(一|週一|星期一|1)$/.test(trimmed)) return '一';
  if (/^(二|週二|星期二|2)$/.test(trimmed)) return '二';
  if (/^(三|週三|星期三|3)$/.test(trimmed)) return '三';
  if (/^(四|週四|星期四|4)$/.test(trimmed)) return '四';
  if (/^(五|週五|星期五|5)$/.test(trimmed)) return '五';
  if (/^(六|週六|星期六|6)$/.test(trimmed)) return '六';
  if (/^(日|天|週日|星期日|7|0)$/.test(trimmed)) return '日';
  return null;
}

/**
 * 計算兩個時間區間之重疊分鐘數 (R01)。
 * 若提供 windowWeekdays（v2 同星期路徑），則強制星期檢查 (D30/K2 fail-closed)：
 * session 星期缺失（null/undefined）或無法識別皆視為未知，一律重疊為 0。
 * 未提供 windowWeekdays 時（v1/compat 舊呼叫）保持純時刻比對。
 */
export function calculateOverlapMinutes(
  start: number,
  end: number,
  windowStart: number,
  windowEnd: number,
  sessionWeekday?: string | null,
  windowWeekdays?: readonly string[] | string[]
): number {
  if (windowWeekdays !== undefined && windowWeekdays !== null) {
    const normSession = normalizeWeekday(sessionWeekday);
    const normWindows = windowWeekdays.map((w) => normalizeWeekday(w)).filter(Boolean);
    if (!normSession || !normWindows.includes(normSession)) {
      return 0;
    }
  }
  const overlap = Math.min(end, windowEnd) - Math.max(start, windowStart);
  return Math.max(0, overlap);
}

/**
 * 判斷單一星期值是否為未知（缺失或無法識別）。v2 同星期路徑下未知一律 fail-closed 為 0。
 */
export function isUnknownWeekday(w: string | null | undefined): boolean {
  return normalizeWeekday(w) === null;
}

/**
 * 計算單堂課之重疊與負扣天數 (R02)。
 * - 安親: raw = -overlap / 180
 * - 課輔: overlap >= 120 且 end > 18:30 (1110分) 且 end < 19:30 (1170分) 時 raw = -1；否則 -overlap / 180
 */
export function calculateSessionDeduction(
  start: number,
  end: number,
  careType: 'anqin' | 'tutoring',
  options: RuleSetOptions = {},
  weekday?: string | null
): SessionDeductionResult {
  const divisor = options.minutesPerBillingDay ?? 180;
  const window =
    careType === 'anqin'
      ? options.anqinWindow ?? CARE_WINDOWS.anqin
      : options.tutoringWindow ?? CARE_WINDOWS.tutoring;

  const windowWeekdays = window.weekdays ?? CARE_WINDOW_WEEKDAYS;
  const overlapMinutes = options.sameWeekdayOnly
    ? calculateOverlapMinutes(start, end, window.start, window.end, weekday, windowWeekdays)
    : calculateOverlapMinutes(start, end, window.start, window.end);

  if (careType === 'tutoring') {
    // 課輔特例：重疊 >= 120 分鐘且 18:30 < end < 19:30
    const isSpecialTutoringRule = overlapMinutes >= 120 && end > 1110 && end < 1170;
    if (isSpecialTutoringRule) {
      return {
        overlapMinutes,
        rawDeduction: -1,
        isSpecialTutoringRule: true,
      };
    }
  }

  const rawDeduction = -overlapMinutes / divisor;
  return {
    overlapMinutes,
    rawDeduction,
    isSpecialTutoringRule: false,
  };
}

/**
 * 正式軌 erp-tag-v1 取整 (D24):
 * 同班各堂扣天先累加為 d = -raw >= 0。
 * n = floor(d)
 * f = d - n
 * f < 0.3 -> 0
 * 0.3 <= f < 0.8 -> 0.5
 * f >= 0.8 -> 1.0
 * rounded = -deduction
 */
export function calculateClassDeductionD24(
  sessions: SessionTime[],
  careType: 'anqin' | 'tutoring',
  options: RuleSetOptions = {}
): ClassDeductionResult {
  const zeroBelow = options.zeroBelow ?? 0.3;
  const fullAtOrAbove = options.fullAtOrAbove ?? 0.8;

  let totalOverlapMinutes = 0;
  let totalRaw = 0;

  for (const s of sessions) {
    const ded = calculateSessionDeduction(s.start, s.end, careType, options, s.weekday);
    totalOverlapMinutes += ded.overlapMinutes;
    totalRaw += ded.rawDeduction;
  }

  // 扣天量 d = -totalRaw >= 0
  const d = Math.abs(totalRaw);
  const n = Math.floor(d);
  const f = d - n;

  const epsilon = 1e-9;
  let fracDeduction = 0;
  if (f < zeroBelow - epsilon) {
    fracDeduction = 0;
  } else if (f < fullAtOrAbove - epsilon) {
    fracDeduction = 0.5;
  } else {
    fracDeduction = 1.0;
  }

  const roundedDeduction = n + fracDeduction;
  const rounded = roundedDeduction === 0 ? 0 : -roundedDeduction;

  return {
    totalOverlapMinutes,
    raw: totalRaw,
    rounded,
  };
}

/**
 * 輔助函式：取 Excel 15 位有效數字 (04 §3 DIFF-01 模型)
 */
function roundTo15Digits(num: number): number {
  return parseFloat(num.toPrecision(15));
}

/**
 * 診斷軌 excel-v260922-compat 取整:
 * 保留 Excel 日分數與原負數 INT/MOD 公式，以及 15 位有效數字比較模型。
 */
export function calculateClassDeductionCompat(
  sessions: SessionTime[],
  careType: 'anqin' | 'tutoring',
  options: RuleSetOptions = {}
): ClassDeductionResult {
  let totalOverlapMinutes = 0;
  let totalRaw = 0;

  const window =
    careType === 'anqin'
      ? options.anqinWindow ?? CARE_WINDOWS.anqin
      : options.tutoringWindow ?? CARE_WINDOWS.tutoring;

  const dayWindowStart = window.start / 1440;
  const dayWindowEnd = window.end / 1440;

  for (const s of sessions) {
    const dayStart = s.start / 1440;
    const dayEnd = s.end / 1440;
    const dayOverlap = Math.max(0, Math.min(dayEnd, dayWindowEnd) - Math.max(dayStart, dayWindowStart));
    const overlapMinutes = dayOverlap * 24 * 60; // 原生浮點運算

    totalOverlapMinutes += Math.round(overlapMinutes);

    // 特殊課輔在 Excel 實測 17:00-19:00 (119.99999999999989 >= 120 成立)
    // 依據 04 §3 15 位有效數字模型：roundTo15Digits(overlapMinutes) >= 120
    const overlap15 = roundTo15Digits(overlapMinutes);
    if (careType === 'tutoring' && overlap15 >= 120 && s.end > 1110 && s.end < 1170) {
      totalRaw += -1;
    } else {
      const sessionRaw = -overlapMinutes / 60 / 3;
      totalRaw += sessionRaw;
    }
  }

  // 套用 Excel INT/MOD 模型 (04 §3)
  const x = totalRaw;
  if (Math.abs(x) < 1e-12) {
    return { totalOverlapMinutes, raw: 0, rounded: 0 };
  }

  const n = Math.floor(x);
  const f = x - n;

  // 比較時套用 15 位有效數字模型 (04 §3)
  const f15 = roundTo15Digits(f);

  let frac = 0;
  if (f15 < 0.3) {
    frac = 0;
  } else if (f15 < 0.8) {
    frac = 0.5;
  } else {
    frac = 1.0;
  }

  const rawRounded = n + frac;
  const rounded = Math.abs(rawRounded) < 1e-12 ? 0 : rawRounded;

  return {
    totalOverlapMinutes,
    raw: totalRaw,
    rounded,
  };
}

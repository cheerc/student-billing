import { TagDiscounts } from './types';
import { ClassCategory } from '../classification/class-category';

const SPECIAL_DISCOUNT_RULES: [string, number][] = [
  ['特殊折扣95折', 0.95],
  ['特殊折扣85折', 0.85],
  ['特殊折扣7折', 0.70],
  ['特殊折扣8折', 0.80],
  ['特殊折扣9折', 0.90],
];

const EXTRA_DEDUCTION_RULES: [string, number][] = [
  ['安課額外扣0.5天', 0.5],
  ['安課額外扣1天', 1.0],
  ['安課額外扣2天', 2.0],
  ['安課額外扣1.5天', 1.5],
];

export interface TagDiscountEvidence {
  discounts: TagDiscounts;
  /** 命中的原始固定短語；不包含或曝光其他原始標籤文字。 */
  siblingToken: string | null;
  specialDiscountTokens: string[];
  internalStudentToken: string | null;
}

/**
 * 解析學生標籤並保留命中的固定短語供唯讀說明使用。
 * 正式計算與呈現共用同一組規則及優先序；空標籤不向備註 fallback。
 */
export function parseTagDiscountEvidence(tagsRaw: string | null | undefined): TagDiscountEvidence {
  if (!tagsRaw) {
    return {
      discounts: {
        extraDeduction: null,
        sibling: false,
        specialDiscount: null,
        internalStudent: false,
        isStaffFamily: false,
        hasMultipleSpecialDiscounts: false,
        hasMultipleExtraDeductions: false,
      },
      siblingToken: null,
      specialDiscountTokens: [],
      internalStudentToken: null,
    };
  }

  // 1. 額外扣除天數 (R05)
  let extraDeduction: number | null = null;
  let extraMatchCount = 0;
  for (const [pattern, val] of EXTRA_DEDUCTION_RULES) {
    if (tagsRaw.includes(pattern)) {
      extraMatchCount++;
      if (extraDeduction === null) {
        extraDeduction = val;
      }
    }
  }

  // 2. 兄弟姊妹折扣 (R06)
  const sibling = tagsRaw.includes('有兄弟姊妹折扣');

  // 3. 特殊折扣 (R07)
  const specialMatches = SPECIAL_DISCOUNT_RULES.filter(([pattern]) => tagsRaw.includes(pattern));
  const specialDiscount = specialMatches[0]?.[1] ?? null;

  // 4. 園內生 (R08)
  const internalStudent = tagsRaw.includes('園內生');

  // 5. 員工家屬 (R18 提示用)
  const isStaffFamily = tagsRaw.includes('員工家屬');

  return {
    discounts: {
      extraDeduction,
      sibling,
      specialDiscount,
      internalStudent,
      isStaffFamily,
      hasMultipleSpecialDiscounts: specialMatches.length > 1,
      hasMultipleExtraDeductions: extraMatchCount > 1,
    },
    siblingToken: sibling ? '有兄弟姊妹折扣' : null,
    specialDiscountTokens: specialMatches.map(([pattern]) => pattern),
    internalStudentToken: internalStudent ? '園內生' : null,
  };
}

/** 計算端維持原本 TagDiscounts 契約；呈現端如需來源片段可呼叫 parseTagDiscountEvidence。 */
export function parseTagDiscounts(tagsRaw: string | null | undefined): TagDiscounts {
  return parseTagDiscountEvidence(tagsRaw).discounts;
}

/**
 * 類別式科數計算 (R03, D37 ①; current v4 behavior).
 * 學生所報班級涵蓋的類別種數 (care, math, english)，同類只算 1 科。
 * `none`（使用者明確指定不列入）與 `unset`（#157 Ruling 2：使用者尚未指定）皆不計入——
 * 兩者計算結果相同，差異只在呈現與提示。
 * 取代 R09 名稱判斷與寫功課減 1。
 */
export function calculateSubjectCountByCategory(categories: ClassCategory[]): number | null {
  if (categories.length === 0) {
    return null;
  }
  const discountCategories = new Set(
    categories.filter((c): c is 'care' | 'math' | 'english' => c === 'care' || c === 'math' || c === 'english')
  );
  return discountCategories.size;
}

/**
 * 計算基本折扣 (R10)。
 * 特殊折扣優先；否則 effectiveCount = subjectCount + (sibling ? 1 : 0)。
 * 回傳整數 basis points (10000 = 100%, 9500 = 95%, 9000 = 90%)。
 */
export function calculateBaseDiscountBps(
  subjectCount: number | null,
  sibling: boolean,
  specialDiscount: number | null
): number | null {
  // 特殊折扣直接覆蓋
  if (specialDiscount !== null) {
    return Math.round(specialDiscount * 10000);
  }

  // Operator 裁決 d-20261002160111112854-66：無報名（科數 null）合計折扣預設 10000（無折扣）
  if (subjectCount === null) {
    return 10000;
  }

  const effectiveCount = subjectCount + (sibling ? 1 : 0);
  if (effectiveCount > 2) {
    return 9000;
  }
  if (effectiveCount === 2) {
    return 9500;
  }
  return 10000;
}

/**
 * 課程情境的最終適用折扣 (R13, R14, R15)。
 * - 安親 (R13): 寫功課/美安為 10000；園內生 max(9000, basic - 500)；其他 basic。
 * - 課輔 (R14): 寫功課為 10000；其他 basic (無園內生額外優惠)。
 * - 美語/數學 (R15): basicRate。
 * - 加強班/國語文 (R15): not_configured (null)。
 *
 * #124（operator 裁示）：寫功課班也可能帶「特殊折扣 NN折」，因此
 * **特殊折扣優先於「寫功課固定 100%」**。`hasSpecialDiscount` 為真時，
 * 寫功課/美安的 10000 覆蓋不套用，改依各課程型態的一般規則處理 basicRate。
 *
 * 優先序依據（specs/02）：
 * - §5 R07（特殊折扣標籤解析）與 §6 R10（特殊折扣直接覆蓋一般規則）**早於**
 *   §8 R13／R14（寫功課適用率 1）。
 * - §9.4 Q7-A 的「適用率皆為 100%」指該**班級自身**不適用一般折扣規則
 *   （不列入比較、固定 5 天下限），與學生基本折扣是否被覆蓋是兩件事；
 *   學生自帶的特殊折扣不在此覆蓋範圍內。
 *
 * 現行 v4 的固定 5 天設定不覆寫課程學費折扣；特殊折扣已由 baseDiscountBps 決定。
 */
export function calculateApplicableRate(
  courseType: 'anqin' | 'tutoring' | 'english' | 'math' | 'enrichment' | 'chinese',
  baseDiscountBps: number | null,
  isInternalStudent: boolean
): number | null {
  if (baseDiscountBps === null) {
    return null;
  }

  if (courseType === 'anqin') {
    if (isInternalStudent) {
      return Math.max(9000, baseDiscountBps - 500);
    }
    return baseDiscountBps;
  }

  if (courseType === 'tutoring') {
    return baseDiscountBps;
  }

  if (courseType === 'english' || courseType === 'math') {
    return baseDiscountBps;
  }

  // 加強班、國語文班 P1 標示 not_configured (null)
  return null;
}

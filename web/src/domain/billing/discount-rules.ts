import { ParsedToken } from '../students/types';
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

/**
 * 解析學生標籤欄位 (R05–R08)。
 * 正式軌 (erp-tag-v1) 僅讀取標籤欄位，空標籤不向備註 fallback。
 */
export function parseTagDiscounts(tagsRaw: string | null | undefined): TagDiscounts {
  if (!tagsRaw) {
    return {
      extraDeduction: null,
      sibling: false,
      specialDiscount: null,
      internalStudent: false,
      isStaffFamily: false,
      hasMultipleSpecialDiscounts: false,
      hasMultipleExtraDeductions: false,
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
  const sibling = tagsRaw.includes('有兄弟姊妹折扣') || tagsRaw.includes('有兄弟姊妹');

  // 3. 特殊折扣 (R07)
  let specialDiscount: number | null = null;
  let specialMatchCount = 0;
  for (const [pattern, val] of SPECIAL_DISCOUNT_RULES) {
    if (tagsRaw.includes(pattern)) {
      specialMatchCount++;
      if (specialDiscount === null) {
        specialDiscount = val;
      }
    }
  }

  // 4. 園內生 (R08)
  const internalStudent = tagsRaw.includes('園內生');

  // 5. 員工家屬 (R18 提示用)
  const isStaffFamily = tagsRaw.includes('員工家屬');

  return {
    extraDeduction,
    sibling,
    specialDiscount,
    internalStudent,
    isStaffFamily,
    hasMultipleSpecialDiscounts: specialMatchCount > 1,
    hasMultipleExtraDeductions: extraMatchCount > 1,
  };
}

/**
 * 計算已補科數 (R09, v2 行為)。
 * 統計三類科別存在性：國小輔導、國小數學、兒童美語。
 * 若含寫功課則減 1 (寫功課不列入多科折扣)。
 */
export function calculateSubjectCount(tokens: ParsedToken[]): number | null {
  if (tokens.length === 0) {
    return null;
  }

  const hasCare = tokens.some(
    (t) => t.baseName.includes('國小輔導') || t.baseName.includes('安親') || t.baseName.includes('課輔')
  );
  const hasMath = tokens.some((t) => t.baseName.includes('國小數學'));
  const hasEnglish = tokens.some((t) => t.baseName.includes('兒童美語'));

  const k = (hasCare ? 1 : 0) + (hasMath ? 1 : 0) + (hasEnglish ? 1 : 0);

  if (k > 0) {
    const hasHomework = tokens.some((t) => t.baseName.includes('寫功課'));
    return Math.max(0, k - (hasHomework ? 1 : 0));
  }

  return 0;
}

/**
 * D2a: 類別式科數計算 (R03, D37 ①, v3 行為)。
 * 學生所報班級涵蓋的類別種數 (care, math, english)，同類只算 1 科，none 不列入。
 * 取代 R09 名稱判斷與寫功課減 1。
 */
export function calculateSubjectCountV3(categories: ClassCategory[]): number | null {
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

  if (subjectCount === null) {
    return null;
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
 */
export function calculateApplicableRate(
  courseType: 'anqin' | 'tutoring' | 'english' | 'math' | 'enrichment' | 'chinese',
  baseDiscountBps: number | null,
  isInternalStudent: boolean,
  hasHomeworkOrMeian: boolean
): number | null {
  if (baseDiscountBps === null) {
    return null;
  }

  if (courseType === 'anqin') {
    if (hasHomeworkOrMeian) {
      return 10000;
    }
    if (isInternalStudent) {
      return Math.max(9000, baseDiscountBps - 500);
    }
    return baseDiscountBps;
  }

  if (courseType === 'tutoring') {
    if (hasHomeworkOrMeian) {
      return 10000;
    }
    return baseDiscountBps;
  }

  if (courseType === 'english' || courseType === 'math') {
    return baseDiscountBps;
  }

  // 加強班、國語文班 P1 標示 not_configured (null)
  return null;
}

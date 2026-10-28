/**
 * 班級類別值域與「報名班名 → 班級屬性」解析（純函式）。
 *
 * #157 Ruling 1（`specs/06` D53）：**班名不再參與類別判定**。使用者沒有指定類別時，
 * 類別是「未設定」（`unset`），不是由班名猜出來的 `care`／`math`／`english`／`none`。
 * 舊版 `detectClassCategory`／`detectClassAttributes` 已整組移除——保留任何形式的
 * 班名推導，就等於讓系統替使用者陳述他沒做過的決定。
 *
 * 三個互斥狀態（#157 Ruling 2）：
 *  - `care`／`math`／`english`：使用者明確指定，計入多科折扣科數。
 *  - `none`：使用者明確指定「不列入折扣」，不計科數。
 *  - `unset`：使用者尚未指定。計算上與 `none` 同效，差異只在呈現與提示。
 *
 * 來源狀態（#157 Ruling 4）：`categorySource` 有三種——
 *  - `'manual'`：使用者明確指定。
 *  - `'seed'`：**seed 基準**（機構既有的班級設定；不是使用者的決定）。
 *  - `'unset'`：未指定——可能是使用者明確撤回（選回「（未設定）」），也可能從未被指定。
 *  `'auto'`（舊的班名推導）僅作為舊資料的讀取值存在，其值一律不採用（Ruling 5）。
 *
 * 不依賴 DB／UI／規則版本。
 */

import { SEED_CLASS_CATEGORIES, SEED_CLASS_TYPES } from '@/domain/schedules/seed-manifest';

export type FiveClassType = 'care' | 'english' | 'math' | 'other' | 'unscheduled';

export type EffectiveMappedCategory = 'care' | 'english' | 'math' | 'none' | 'unset';

export type ClassCategory = 'care' | 'math' | 'english' | 'none' | 'unset';

export function isFiveClassType(value: unknown): value is FiveClassType {
  return (
    value === 'care' ||
    value === 'english' ||
    value === 'math' ||
    value === 'other' ||
    value === 'unscheduled'
  );
}

/**
 * D61 Ruling 1：由 (classType, hasMultiSubjectDiscount) 確定性投影回有效折扣類別。
 * `care | english | math` 且 `hasMultiSubjectDiscount === true` 回傳該類型，否則回傳 `'none'`。
 */
export function deriveEffectiveCategory(
  classType: FiveClassType,
  hasMultiSubjectDiscount: boolean
): 'care' | 'english' | 'math' | 'none' {
  if (
    (classType === 'care' || classType === 'english' || classType === 'math') &&
    hasMultiSubjectDiscount === true
  ) {
    return classType;
  }
  return 'none';
}

export interface ClassAttributes {
  category: ClassCategory;
}

/**
 * 類別的來源狀態。
 *
 * - `'manual'`：使用者明確指定。
 * - `'seed'`：seed 基準值（機構既有的班級設定；**不是**使用者的決定，故不記為 manual）。
 * - `'unset'`：未指定。使用者明確撤回時會存成這個值，以區分「從未指定」與「已撤回」——
 *   撤回必須真的撤回，不能在下一次讀取時被 seed 基準還原（Ruling C 的精神）。
 * - `'auto'`：只作為**舊資料的讀取值**存在（`specs/06` D53 Ruling 5：其值一律不採用，
 *   不把系統推導值升格為使用者的決定）。新寫入的路徑不會產生這個值。
 */
/** 舊設定可讀取的來源；新設定與 run 不得寫入此值。 */
export type LegacyCategorySource = 'auto';

/** 可寫入設定的來源：使用者指定或明確撤回。 */
export type WritableCategorySource = 'manual' | 'unset';

/** 有效類別的來源（讀取後的結果；不包含舊資料 `auto`）。 */
export type EffectiveCategorySource = WritableCategorySource | 'seed';

/** 設定讀取值＝有效來源＋僅供相容解析的舊來源。 */
export type CategorySource = EffectiveCategorySource | LegacyCategorySource;

export interface ResolvedClassEnrollment {
  rawToken: string;
  baseName: string;
  resolvedBaseName: string;
  mapped: boolean;
  category: ClassCategory;
  categorySource: EffectiveCategorySource;
  fixedFiveDays: boolean;
  classType: FiveClassType | null;
  hasMultiSubjectDiscount: boolean;
  classTypeId: string | null;
  subject: string;
  subjectSource: 'manual' | 'seed' | 'legacy_migration' | 'unset';
  summaryDayRoleConditions: Array<{ role: 'saturdayTutoringDays'; condition: 'raw_token_contains_six' }>;
  erpTierApplicability: 'applicable' | 'not_applicable' | 'unset';
  erpTierApplicabilitySource: 'manual' | 'seed' | 'legacy_migration' | 'unset';
}

export interface ClassSettingLookup {
  classType?: FiveClassType | 'non_care' | null;
  hasMultiSubjectDiscount?: boolean;
  classTypeId?: string;
  classTypeDefinition?: {
    id: string;
    label: string;
    scheduleMode: 'care_window' | 'timetable';
    summaryRoleOptions: Array<'anqinDays' | 'tutoringDays' | 'englishDays' | 'mathDays' | 'chineseDays' | 'homeworkDays' | 'intensiveEnglishDays' | 'saturdayTutoringDays'>;
  };
  subject?: string;
  subjectSource?: 'manual' | 'seed' | 'legacy_migration' | 'unset';
  summaryDayRoleConditions?: Array<{ role: 'saturdayTutoringDays'; condition: 'raw_token_contains_six' }>;
  erpTierApplicability?: 'applicable' | 'not_applicable' | 'unset';
  erpTierApplicabilitySource?: 'manual' | 'seed' | 'legacy_migration' | 'unset';
  category?: ClassCategory;
  categorySource?: CategorySource;
  fixedFiveDays?: boolean;
}

export interface RawLegacyClassLike {
  classType?: string | null;
  classTypeId?: string | null;
  hasMultiSubjectDiscount?: boolean;
  category?: ClassCategory;
  categorySource?: CategorySource;
  fixedFiveDays?: boolean;
}

export interface NormalizedClassSetting {
  classType: FiveClassType;
  hasMultiSubjectDiscount: boolean;
  fixedFiveDays: boolean;
  category: EffectiveMappedCategory;
  categorySource: EffectiveCategorySource;
  /** 舊版 'non_care' 轉入 'other' 且未帶新制標記時為 true（供 readStoredDraft 正規化 skipDeduction，見 D61 Ruling 2）。 */
  migratedLegacyNonCareToOther: boolean;
}

/**
 * D61：相容正規化舊版設定與五類型設定（供 readStoredDraft、resolveClassAttributes、resolveClassEnrollment 共用）。
 */
export function normalizeLegacyClassSetting(
  baseName: string,
  saved?: RawLegacyClassLike
): NormalizedClassSetting {
  const rawType = saved?.classType ?? saved?.classTypeId ?? undefined;
  const fixedFiveDays = saved?.fixedFiveDays ?? false;
  const rawSource: EffectiveCategorySource | undefined =
    saved?.categorySource === 'auto' ? undefined : saved?.categorySource;
  const seedType = SEED_CLASS_TYPES.get(baseName);

  if (isFiveClassType(rawType)) {
    let classType: FiveClassType = rawType;
    let hasMultiSubjectDiscount: boolean;
    let categorySource: EffectiveCategorySource;

    if (
      saved?.category !== undefined &&
      (rawSource === 'manual' || rawSource === 'unset')
    ) {
      if (rawSource === 'unset' || saved.category === 'unset' || saved.category === 'none') {
        hasMultiSubjectDiscount = false;
        categorySource = rawSource === 'unset' || saved.category === 'unset' ? 'unset' : 'manual';
      } else {
        // Phase 1 UI 橋接或舊測試直接指定 category='care'|'english'|'math'
        if (!(fixedFiveDays && rawType === 'care')) {
          classType = saved.category;
        }
        hasMultiSubjectDiscount = true;
        categorySource = 'manual';
      }
    } else {
      if (classType === 'other' || classType === 'unscheduled') {
        hasMultiSubjectDiscount = false;
      } else {
        hasMultiSubjectDiscount =
          saved?.hasMultiSubjectDiscount ??
          (saved?.category === 'none' || saved?.category === 'unset' ? false : true);
      }
      const defaultSeedMulti = seedType !== undefined && seedType !== 'other';
      categorySource =
        seedType !== undefined &&
        classType === seedType &&
        hasMultiSubjectDiscount === defaultSeedMulti &&
        rawSource !== 'manual'
          ? 'seed'
          : 'manual';
    }

    const category: EffectiveMappedCategory =
      saved?.category === 'unset' || rawSource === 'unset'
        ? 'unset'
        : deriveEffectiveCategory(classType, hasMultiSubjectDiscount);

    return {
      classType,
      hasMultiSubjectDiscount,
      fixedFiveDays,
      category,
      categorySource,
      migratedLegacyNonCareToOther: false,
    };
  }

  let classType: FiveClassType;
  let hasMultiSubjectDiscount: boolean;
  let categorySource: EffectiveCategorySource;
  let migratedLegacyNonCareToOther = false;
  let category: EffectiveMappedCategory;

  if (rawType === undefined && fixedFiveDays) {
    classType = 'care';
    hasMultiSubjectDiscount =
      saved?.hasMultiSubjectDiscount ??
      (saved?.category === 'none' || saved?.category === 'unset' ? false : true);
    categorySource = saved?.categorySource === 'auto' ? 'unset' : (saved?.categorySource ?? 'unset');
    category = saved?.category ?? 'unset';
  } else if (rawSource === 'manual' && saved?.category !== undefined) {
    if (saved.category === 'care' || saved.category === 'english' || saved.category === 'math') {
      classType = saved.category;
      hasMultiSubjectDiscount = true;
      categorySource = 'manual';
      category = classType;
    } else if (rawType === undefined && seedType === 'care') {
      classType = 'care';
      hasMultiSubjectDiscount = false;
      categorySource = saved.category === 'unset' ? 'unset' : 'manual';
      category = saved.category === 'unset' ? 'unset' : 'none';
    } else {
      classType = 'other';
      hasMultiSubjectDiscount = false;
      categorySource = saved.category === 'unset' ? 'unset' : 'manual';
      category = saved.category === 'unset' ? 'unset' : 'none';
      migratedLegacyNonCareToOther = saved.hasMultiSubjectDiscount === undefined;
    }
  } else if (rawSource === 'unset' || saved?.category === 'unset') {
    if (rawType === undefined && seedType === 'care') {
      classType = 'care';
      hasMultiSubjectDiscount = false;
      categorySource = 'unset';
      category = 'unset';
    } else {
      classType = 'other';
      hasMultiSubjectDiscount = false;
      categorySource = 'unset';
      category = 'unset';
      migratedLegacyNonCareToOther = saved?.hasMultiSubjectDiscount === undefined;
    }
  } else if (seedType !== undefined) {
    classType = seedType;
    hasMultiSubjectDiscount =
      saved?.hasMultiSubjectDiscount ??
      (saved?.category === 'none' ? false : seedType !== 'other');
    categorySource = 'seed';
    category = deriveEffectiveCategory(classType, hasMultiSubjectDiscount);
    migratedLegacyNonCareToOther =
      seedType === 'other' && saved?.hasMultiSubjectDiscount === undefined;
  } else {
    classType = 'other';
    hasMultiSubjectDiscount = saved?.hasMultiSubjectDiscount ?? false;
    categorySource = 'unset';
    category = 'unset';
    migratedLegacyNonCareToOther = saved?.hasMultiSubjectDiscount === undefined;
  }

  return {
    classType,
    hasMultiSubjectDiscount,
    fixedFiveDays,
    category,
    categorySource,
    migratedLegacyNonCareToOther,
  };
}

/**
 * 已儲存設定 → 有效類別與來源。
 *
 * 判斷順序（每一層都不可互換）：
 *  1. `'manual'` 且有值 → **使用者的決定**，原樣採用（任何基準都不得覆寫它）。
 *  2. `'unset'` → 使用者明確撤回（或本來就未指定）→ 未設定。
 *     **不得**被 seed 基準還原：撤回必須真的撤回。
 *  3. `'seed'` 且有值 → 已持久化的 seed 基準，原樣採用。
 *  4. 其餘（缺值，或舊資料的 `'auto'`）→ 舊的班名推導值一律不採用（Ruling 5）；
 *     若該班屬 **seed 49 班**，改套用 **seed 基準**（機構既有的班級設定）；
 *     非 seed 班則為未設定。
 *
 * 第 4 點是「既有 DB 與全新 DB 結果一致」的關鍵：seed 基準對兩條路徑同樣生效，
 * 否則同一份設定會因資料庫是新是舊而算出不同結果。
 *
 * @param baseName 解析後的班名（經 alias）；seed 基準以它為 key。
 */
export function effectiveCategoryOf(
  baseName: string,
  saved?: {
    category?: ClassCategory;
    categorySource?: CategorySource;
  }
): { category: ClassCategory; categorySource: EffectiveCategorySource } {
  if (saved?.categorySource === 'manual' && saved.category !== undefined) {
    return { category: saved.category, categorySource: 'manual' };
  }
  if (saved?.categorySource === 'unset') {
    return { category: 'unset', categorySource: 'unset' };
  }
  if (saved?.categorySource === 'seed' && saved.category !== undefined) {
    return { category: saved.category, categorySource: 'seed' };
  }
  const seed = SEED_CLASS_CATEGORIES.get(baseName);
  if (seed) return { category: seed, categorySource: 'seed' };
  return { category: 'unset', categorySource: 'unset' };
}

/**
 * 自動推導 ERP 級距適用性 (D60-1)。
 * 僅「已對應且課程類型為安親課輔班且非固定 5 天」之班級適用米豆奶週級距比對。
 */
export function deriveErpTierApplicability(params: {
  mapped: boolean;
  classType: FiveClassType | 'non_care' | string | null;
  fixedFiveDays: boolean;
}): 'applicable' | 'not_applicable' {
  return params.mapped && params.classType === 'care' && !params.fixedFiveDays
    ? 'applicable'
    : 'not_applicable';
}

/**
 * 解析學生報名班級的五類型、多科折扣旗標、投影類別與固定 5 天屬性（D61）。
 *
 * - 名冊班名（經 alias）對應到課表設定的班 → 正規化為五類型並投影 `category`（`'care' | 'english' | 'math' | 'none'`）。
 * - 未對應（`mapped: false`）→ 維持 `classType: null`、`hasMultiSubjectDiscount: false`、`category: 'unset'`、`CLASS_NOT_MAPPED`。
 */
export function resolveClassEnrollment(
  token: { rawToken: string; baseName: string },
  aliasMap?: Map<string, string>,
  classSettingMap?: Map<string, ClassSettingLookup>
): ResolvedClassEnrollment {
  const resolvedBaseName = aliasMap?.get(token.baseName) ?? token.baseName;
  const cls = classSettingMap?.get(resolvedBaseName);

  if (cls) {
    const norm = normalizeLegacyClassSetting(resolvedBaseName, cls);
    const mapped = true;
    const fixedFiveDays = norm.fixedFiveDays;
    const classType = norm.classType;
    const erpTierApplicability = deriveErpTierApplicability({
      mapped,
      classType,
      fixedFiveDays,
    });

    return {
      rawToken: token.rawToken,
      baseName: token.baseName,
      resolvedBaseName,
      mapped,
      category: norm.category,
      categorySource: norm.categorySource,
      fixedFiveDays,
      classType,
      hasMultiSubjectDiscount: norm.hasMultiSubjectDiscount,
      classTypeId: cls.classTypeId ?? classType,
      subject: cls.subject ?? '',
      subjectSource: cls.subjectSource ?? 'unset',
      summaryDayRoleConditions: cls.summaryDayRoleConditions ?? [],
      erpTierApplicability,
      erpTierApplicabilitySource: cls.erpTierApplicabilitySource ?? 'unset',
    };
  }

  return {
    rawToken: token.rawToken,
    baseName: token.baseName,
    resolvedBaseName,
    mapped: false,
    category: 'unset',
    categorySource: 'unset',
    fixedFiveDays: false,
    classType: null,
    hasMultiSubjectDiscount: false,
    classTypeId: null,
    subject: '',
    subjectSource: 'unset',
    summaryDayRoleConditions: [],
    erpTierApplicability: 'not_applicable',
    erpTierApplicabilitySource: 'unset',
  };
}

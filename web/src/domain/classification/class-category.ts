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

import { SEED_CLASS_CATEGORIES } from '@/domain/schedules/seed-manifest';

export type ClassCategory = 'care' | 'math' | 'english' | 'none' | 'unset';

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
}

export interface ClassSettingLookup {
  classType?: 'care' | 'non_care';
  category?: ClassCategory;
  categorySource?: CategorySource;
  fixedFiveDays?: boolean;
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
 * 解析學生報名班級的類別與固定 5 天屬性。
 *
 * - 名冊班名（經 alias）對應到課表設定的班 → 用該班設定；未指定類別即 `unset`。
 * - 未對應 → `unset`、`mapped: false`、`fixedFiveDays: false`
 *   （Ruling 3：該班對學生之折扣與天數影響為零，且不論班名為何都需 warn）。
 * - 固定 5 天為純布林（specs/14 §3.3），未設定者預設 `false`。
 */
export function resolveClassEnrollment(
  token: { rawToken: string; baseName: string },
  aliasMap?: Map<string, string>,
  classSettingMap?: Map<string, ClassSettingLookup>
): ResolvedClassEnrollment {
  const resolvedBaseName = aliasMap?.get(token.baseName) ?? token.baseName;
  const cls = classSettingMap?.get(resolvedBaseName);

  if (cls) {
    const { category, categorySource } = effectiveCategoryOf(resolvedBaseName, cls);
    return {
      rawToken: token.rawToken,
      baseName: token.baseName,
      resolvedBaseName,
      mapped: true,
      category,
      categorySource,
      fixedFiveDays: cls.fixedFiveDays ?? false,
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
  };
}

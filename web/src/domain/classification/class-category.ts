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
 * 來源狀態（#157 Ruling 4）：`categorySource` 只有 `'manual'`（使用者決定）與
 * `'unset'`（未決定）兩種；`'auto'` 及其「恢復自動」路徑已整條拆除。
 *
 * 不依賴 DB／UI／規則版本。
 */

export type ClassCategory = 'care' | 'math' | 'english' | 'none' | 'unset';

export interface ClassAttributes {
  category: ClassCategory;
}

/**
 * 類別的來源狀態。
 *
 * `'auto'` 只作為**舊資料的讀取值**出現在型別上：`specs/06` D53 Ruling 5 明定
 * 舊設定中 `category` 有值但來源為 `auto` 者視為 `unset`（不把系統推導值升格為
 * 使用者的決定）。新寫入的路徑只會產生 `'manual'`／`'unset'`。
 */
export type CategorySource = 'manual' | 'unset' | 'auto';

export interface ResolvedClassEnrollment {
  rawToken: string;
  baseName: string;
  resolvedBaseName: string;
  mapped: boolean;
  category: ClassCategory;
  categorySource: 'manual' | 'unset';
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
 * Ruling 5 的相容處理集中在此：只有 `categorySource === 'manual'` 且 `category` 有值時，
 * 該類別才是使用者的決定；舊資料的 `'auto'` 來源、缺來源、缺類別一律是 `unset`。
 */
export function effectiveCategoryOf(saved?: {
  category?: ClassCategory;
  categorySource?: CategorySource;
}): { category: ClassCategory; categorySource: 'manual' | 'unset' } {
  if (saved?.categorySource === 'manual' && saved.category !== undefined) {
    return { category: saved.category, categorySource: 'manual' };
  }
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
    const { category, categorySource } = effectiveCategoryOf(cls);
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

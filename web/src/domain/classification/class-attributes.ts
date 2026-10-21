/**
 * 班級類別與「天數固定 5 天」的有效值解析（D2b；06 D37 1、S manifest §7.3／§7.7）。
 *
 * #157 Ruling 1／4 之後，兩項屬性的來源狀態都只剩「使用者決定」與「未決定」：
 *  - 類別（`care`／`math`／`english`／`none`／`unset`）與固定 5 天不互相推導（D37）。
 *  - 來源為 `manual` 時，改班名不再重新判定；未指定時就是 `unset`，**不再有班名自動偵測**，
 *    因此也沒有「恢復自動」這種回退路徑（`specs/06` D53）。
 *  - 手動值恰等於舊自動偵測值時仍為 `manual`（來源是使用者意圖，不因值相同而降級）。
 *
 * 本模組是 domain 純函式，不依賴 DB／UI／規則版本。
 */

import { type ClassCategory, type EffectiveCategorySource, effectiveCategoryOf } from './class-category';
import {
  type ClassType,
  DEFAULT_CARE_CLASS_NAMES,
  type ClassSetting,
  type ScheduleGridRow,
} from '@/contracts/settings';

export { DEFAULT_CARE_CLASS_NAMES };

/** 類別於畫面上的白話名稱（`unset` 必須與 `none` 分開：未設定不是「不列入折扣」）。 */
export const CATEGORY_LABELS: Record<ClassCategory, string> = {
  care: '安親課輔班',
  math: '數學班',
  english: '美語班',
  none: '不列入折扣',
  unset: '（未設定）',
};

/**
 * 屬性來源狀態。
 *
 * - `'manual'`：使用者明確指定。
 * - `'seed'`：seed 基準值（機構既有的班級設定；**不是**使用者的決定）。
 * - `'unset'`：未指定（含使用者明確撤回）。
 */
export type AttributeSource = EffectiveCategorySource;

/** 已儲存於設定草稿的類別欄位（皆可缺；缺＝未設定，讀取時即 unset）。 */
export interface SavedClassAttributes {
  classType?: ClassType;
  category?: ClassCategory;
  categorySource?: AttributeSource | 'auto';
  fixedFiveDays?: boolean;
}

/** 一個班級的「有效屬性」：值與來源一併輸出，供 draft、快照與讀模型共用。 */
export interface EffectiveClassAttributes {
  classType: ClassType;
  category: ClassCategory;
  categorySource: AttributeSource;
  fixedFiveDays: boolean;
}

/** 單一來源（已儲存 or 草稿）的屬性檢視；不帶 `_source` 後綴以便與 draft 欄位同名比對。 */
export interface ClassAttributesView {
  classType: ClassType;
  category: ClassCategory;
  categorySource: AttributeSource;
  fixedFiveDays: boolean;
}

/**
 * 有效值：已儲存欄位優先；類別缺值即 `unset`（**不再依班名偵測**，#157 Ruling 1）。
 * specs/14 §3.1, §3.3, §3.9, §3.10：
 * - classType：優先取 saved.classType；若無，seed 8 班或歷史 fixedFiveDays===true 為 care，其餘為 non_care
 * - category：只有 `categorySource === 'manual'` 的已存值是使用者的決定，其餘一律 `unset`
 * - fixedFiveDays：無自動偵測，預設恆為 false
 */
export function resolveClassAttributes(
  baseName: string,
  saved?: SavedClassAttributes
): EffectiveClassAttributes {
  const classType: ClassType =
    saved?.classType ??
    (DEFAULT_CARE_CLASS_NAMES.has(baseName) || saved?.fixedFiveDays === true
      ? 'care'
      : 'non_care');
  const { category, categorySource } = effectiveCategoryOf(baseName, saved);
  const fixedFiveDays = saved?.fixedFiveDays ?? false;
  return {
    classType,
    category,
    categorySource,
    fixedFiveDays,
  };
}

/** 有效值 → draft 的欄位（值與來源一併寫出，讓 hash／快照涵蓋來源）。 */
export function toSavedClassAttributes(effective: EffectiveClassAttributes): SavedClassAttributes {
  return {
    classType: effective.classType,
    category: effective.category,
    categorySource: effective.categorySource,
    fixedFiveDays: effective.fixedFiveDays,
  };
}

/** 兩個屬性檢視是否逐欄相同（合併衝突判斷用；不用 JSON 以免欄位順序影響）。 */
export function sameClassAttributes(a: ClassAttributesView, b: ClassAttributesView): boolean {
  return (
    a.classType === b.classType &&
    a.category === b.category &&
    a.categorySource === b.categorySource &&
    a.fixedFiveDays === b.fixedFiveDays
  );
}

/** draft 的一個班級 → 屬性檢視（缺欄位＝未設定，不是任何推導值）。 */
function classToAttributes(c: Pick<ClassSetting, 'baseName'> & SavedClassAttributes): ClassAttributesView {
  return resolveClassAttributes(c.baseName, c);
}

/** 草稿 classes → 班名 → 屬性檢視。 */
export function attributesFromDraftClasses(
  classes: Array<Pick<ClassSetting, 'baseName'> & SavedClassAttributes>
): Map<string, ClassAttributesView> {
  const map = new Map<string, ClassAttributesView>();
  for (const c of classes) {
    map.set(c.baseName, classToAttributes(c));
  }
  return map;
}

/** 已儲存（baseline）的 classes → 班名 → 屬性檢視。與 draft 用同一函式，確保逐欄可比較。 */
export function attributesFromBaselineClasses(
  classes: Array<Pick<ClassSetting, 'baseName'> & SavedClassAttributes>
): Map<string, ClassAttributesView> {
  return attributesFromDraftClasses(classes);
}

// ---------------------------------------------------------------------------
// 班級生命週期（Q9；S manifest §7.7）：班級名稱＝分組 key
// ---------------------------------------------------------------------------

export interface ClassRename { from: string; to: string }
export interface ClassSplit { originalName: string; splitNames: string[] }
export interface ClassMerge { mergedName: string; sources: string[] }
export interface ClassNew { baseName: string }

export interface ClassLifecycle {
  renames: ClassRename[];
  splits: ClassSplit[];
  merges: ClassMerge[];
  news: ClassNew[];
}

/**
 * 以 rowId 對 baseline 追蹤班級名稱變化，判斷整班改名／拆班／同名合併／新班。
 * 僅依名稱分組結果判定，不猜測使用者意圖；同名列多於一個名稱即為拆班。
 */
export function detectClassLifecycle(
  baselineRows: ScheduleGridRow[],
  currentRows: ScheduleGridRow[]
): ClassLifecycle {
  const baseByRow = new Map(baselineRows.map((r) => [r.rowId, r.className.trim()]));
  const baseNames = new Set([...baseByRow.values()].filter(Boolean));

  // 每個原班名，其所有列在草稿中的新名集合
  const byOriginal = new Map<string, Set<string>>();
  for (const r of currentRows) {
    const from = baseByRow.get(r.rowId);
    if (!from) continue;
    const to = r.className.trim();
    if (!to) continue;
    const set = byOriginal.get(from) ?? new Set<string>();
    set.add(to);
    byOriginal.set(from, set);
  }

  const splits: ClassSplit[] = [];
  const renames: ClassRename[] = [];
  for (const [original, targets] of byOriginal.entries()) {
    if (targets.size > 1) {
      splits.push({ originalName: original, splitNames: [...targets].sort() });
    } else if (targets.size === 1) {
      const [target] = [...targets];
      if (target !== original) renames.push({ from: original, to: target });
    }
  }
  splits.sort((a, b) => a.originalName.localeCompare(b.originalName));
  renames.sort((a, b) => a.from.localeCompare(b.from));

  // 同名合併：兩個以上的原班名，其所有列都改成同一個新名，且該新名不在 baseline
  const targetsOf = new Map<string, string[]>();
  for (const [original, targets] of byOriginal.entries()) {
    if (targets.size !== 1) continue;
    const [target] = [...targets];
    const list = targetsOf.get(target) ?? [];
    list.push(original);
    targetsOf.set(target, list);
  }
  const merges: ClassMerge[] = [];
  for (const [mergedName, sources] of targetsOf.entries()) {
    if (sources.length < 2) continue;
    // 目標名在 baseline 存在 → 不是「合併到新名」，是併入既有班（既有班自己的設定保留，不衝突）
    if (baseNames.has(mergedName)) continue;
    merges.push({ mergedName, sources: sources.sort() });
  }
  merges.sort((a, b) => a.mergedName.localeCompare(b.mergedName));

  // 新班：baseline 沒有、且不屬於 rename 目標或合併目標的名稱
  const lifecycleNames = new Set([
    ...renames.map((r) => r.to),
    ...splits.flatMap((s) => s.splitNames),
    ...merges.map((m) => m.mergedName),
  ]);
  const currentNames = new Set(currentRows.map((r) => r.className.trim()).filter(Boolean));
  const news: ClassNew[] = [...currentNames]
    .filter((n) => !baseNames.has(n) && !lifecycleNames.has(n))
    .sort()
    .map((baseName) => ({ baseName }));

  return { renames, splits, merges, news };
}

/**
 * 整班改名帶走設定（D37：改名不再重新判定，因此原值必須跟著走）。
 *
 * #157 Ruling 4 之後「未指定」也是一種需要被保留的狀態：`unset` 隨班帶走仍是 `unset`，
 * **不得**因為新班名含「國小輔導」之類的字樣就變成 `care`。
 */
export function carryAttributesOnRename(
  renames: ClassRename[],
  currentAttrs: Map<string, ClassAttributesView>,
  baselineAttrs: Map<string, ClassAttributesView>,
  /** baseline 中已存在的班名集合，用來辨認「併入既有班」。 */
  baselineNames?: ReadonlySet<string>
): Map<string, ClassAttributesView> {
  const out = new Map<string, ClassAttributesView>(currentAttrs);
  for (const { from, to } of renames) {
    const before = currentAttrs.get(from) ?? baselineAttrs.get(from);
    if (!before) continue;

    // D2d C（04 §8 UX72；decision `d-20261001043317183960-21`）：併入既有班 Z 時**以 Z 為準**。
    // X 的設定不帶入、不覆寫 Z——即使 Z 當下是未指定（unset），X 的 manual 也不覆蓋。
    // 理由是 operator 的產品原則：課程設定＝核對者認知的「現在」班級狀態，系統不記錄、
    // 不管理狀態轉換，有差異由使用者看比對結果自行修正。
    if (baselineNames?.has(to) === true) {
      const existing = currentAttrs.get(to) ?? baselineAttrs.get(to);
      out.set(to, existing ?? resolveClassAttributes(to));
      continue;
    }

    // specs/14 §3.10：整班改名時 classType、category 與 fixedFiveDays 原值直接隨班帶到新班名。
    // category 不論 manual 或 unset 都原樣帶走（#157 Ruling 4：unset 不得依新名重新判定）。
    out.set(to, {
      classType: before.classType,
      category: before.category,
      categorySource: before.categorySource,
      fixedFiveDays: before.fixedFiveDays,
    });
  }
  return out;
}

export interface MergeConflict {
  mergedName: string;
  sources: string[];
  /** 各來源的有效屬性，供畫面顯示差異並讓使用者選擇 */
  sourceAttributes: ClassAttributesView[];
}

/**
 * 同名合併且各來源設定不同時，產生衝突並阻擋儲存（Q9：合併不得靜默取其一）。
 * 設定相同則沿用任一份（回傳空陣列＝可儲存）。
 */
export function detectMergeConflicts(
  merges: ClassMerge[],
  sourceAttrs: Map<string, ClassAttributesView>
): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  for (const merge of merges) {
    const attrs = merge.sources
      .map((s) => sourceAttrs.get(s))
      .filter((a): a is ClassAttributesView => Boolean(a));
    if (attrs.length < 2) continue;
    const first = attrs[0];
    if (attrs.every((a) => sameClassAttributes(a, first))) continue;
    conflicts.push({ mergedName: merge.mergedName, sources: merge.sources, sourceAttributes: attrs });
  }
  return conflicts;
}

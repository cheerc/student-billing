/**
 * 共用層：差異分類的單一真相來源。
 *
 * 過去新增一個分類要同時改**六處**：`NEEDS_HUMAN_CATEGORIES`、`BADGE_BY_CATEGORY`、
 * `statusLabel`、分頁按鈕、`renderInsightGroups` 的 filter、以及 `main()` 的主控台統計。
 * 只改其中幾處是 review 中實際發生過的錯誤——漏了 BADGE 就渲染出 undefined class，
 * 漏了分頁就會出現點不掉的頁籤，漏了主控台統計則會少報數字，而**分類計數本身不變**，
 * 因此任何以計數為基礎的檢查都抓不到。
 *
 * `defineCategories` 把「分類是什麼」收斂成一份宣告，其餘全部推導：
 * badge map、分頁按鈕、需人工判讀清單與計數、主控台統計，全部由 specs 產生。
 * 新增分類只需在 specs 加一筆，其餘五處自動跟上。
 */

/**
 * 分類的宣告式描述。
 *
 * - `id`：分類代碼，同時是統計對外輸出的 key。
 * - `label`：報表上顯示的中文名稱。
 * - `badge`：對應的 CSS class（沿用系統既有配色語意）。
 * - `needsHuman`：是否屬於「需人工判讀、非兩邊直接比大小」。這組必須在
 *   所有 UI 介面一致處理（統計卡、分頁、JS 過濾），否則新增類別只改到一處就會漏。
 * - `tab`：分頁按鈕。`true` 直接用 id，`false` 不產出按鈕。
 * - `insightGroup`：此分類歸入哪一個差異歸納群組；`'none'` 表示不歸入任何群組。
 */
export interface CategorySpec {
  id: string;
  label: string;
  badge: string;
  needsHuman: boolean;
  /**
   * 分頁按鈕用的過濾值；省略時不產出按鈕。
   *
   * 分頁的**顯示順序**由 tabOrder 決定，不用 specs 的陣列順序：specs 的順序另有
   * 用途（注入頁面腳本的 all 清單、以及主控台統計的欄位順序），而分頁的順序是
   * 閱讀優先序（先看差異、最後才看一致）。兩者混用同一個順序會互相牽制。
   * 未指定 tabOrder 者排在已指定者之後，並以 id 排序以確保結果穩定。
   */
  tab?: string;
  /** 分頁顯示順序，越小越前面。 */
  tabOrder?: number;
  /** 差異歸納群組 key；`'none'` 表示不歸納（必須顯式宣告，不可省略）。 */
  insightGroup: string;
}

/** 分類群組的樣式變體：琥珀=需人工確認、灰=單純資訊。 */
export type GroupVariant = 'alert-warning' | 'alert-neutral';

export interface InsightGroup {
  key: string;
  title: string;
  hint: string;
  variant: GroupVariant;
}

/** 一個分頁按鈕。`value` 會直接送進頁面腳本的 `filterTable`。 */
export interface CategoryTab {
  value: string;
  label: string;
  /** 顯示順序；未指定者視為最大。 */
  order: number;
}

export interface CategoryRegistry {
  readonly ids: readonly string[];
  /** id → CSS class。 */
  readonly badges: Readonly<Record<string, string>>;
  /** id → 中文顯示名稱。 */
  readonly labels: Readonly<Record<string, string>>;
  /** 需人工判讀的分類 id（順序即宣告順序）。 */
  readonly needsHuman: readonly string[];
  /** 分頁按鈕，依 tabOrder 排序。 */
  readonly tabs: readonly CategoryTab[];
  /** 分類 id → 歸納群組 key（`'none'` 代表不歸納）。 */
  readonly groupOf: Readonly<Record<string, string>>;
  /**
   * 給頁面腳本使用的分類清單，避免 HTML 與腳本各寫一份而不同步。
   */
  readonly categoryJs: string;
}

export class CategorySpecError extends Error {}

/**
 * 依 specs 產生所有衍生資料，並驗證不變式。
 *
 * 不變式（缺一即拋錯，因為每一條都對應一個真實發生過或可預期的缺陷）：
 *   1. id 不得重複——重複會讓後一個靜默覆蓋前一個的 badge／label。
 *   2. 每個 spec 都要有非空 label 與 badge——缺 badge 就會渲染 undefined class。
 *   3. 每個 spec 都必須宣告 insightGroup（含顯式的 `'none'`）。
 *      未宣告者若靜默視為 none，等於新增分類時忘記歸納群組也沒人發現；
 *      顯式宣告則逼撰寫者當下決定。
 *   4. 分頁按鈕的 value 不得與另一個按鈕重複。
 */
export function defineCategories(specs: readonly CategorySpec[]): CategoryRegistry {
  if (specs.length === 0) {
    throw new CategorySpecError('defineCategories：至少需要一個分類宣告。');
  }

  const badges: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const groupOf: Record<string, string> = {};
  const needsHuman: string[] = [];
  const tabs: CategoryTab[] = [];
  const seenIds = new Set<string>();
  const seenTabValues = new Set<string>();

  for (const spec of specs) {
    const where = `分類「${spec.id}」`;
    if (seenIds.has(spec.id)) {
      throw new CategorySpecError(`defineCategories：${where} 的 id 重複，後者會靜默覆蓋前者的 badge／label。`);
    }
    seenIds.add(spec.id);

    if (!spec.label) {
      throw new CategorySpecError(`defineCategories：${where} 缺少 label，報告會顯示空白。`);
    }
    if (!spec.badge) {
      // 對應 review F-NEW-3：分類加了但沒接進 BADGES，第一次出現就渲染 undefined
      throw new CategorySpecError(`defineCategories：${where} 缺少 badge，會渲染出 undefined class。`);
    }
    if (spec.insightGroup === undefined || spec.insightGroup === '') {
      throw new CategorySpecError(
        `defineCategories：${where} 未宣告 insightGroup。` +
        `請填上要歸入的群組 key，若確實不歸入任何群組請顯式填 'none'。`,
      );
    }

    badges[spec.id] = spec.badge;
    labels[spec.id] = spec.label;
    groupOf[spec.id] = spec.insightGroup;
    if (spec.needsHuman) needsHuman.push(spec.id);

    if (spec.tab) {
      if (seenTabValues.has(spec.tab)) {
        throw new CategorySpecError(`defineCategories：${where} 的分頁值「${spec.tab}」與另一個按鈕重複。`);
      }
      seenTabValues.add(spec.tab);
      tabs.push({ value: spec.tab, label: spec.label, order: spec.tabOrder ?? Number.MAX_SAFE_INTEGER });
    }
  }

  tabs.sort((a, b) => a.order - b.order || a.value.localeCompare(b.value));
  for (const tab of tabs) delete (tab as { order?: number }).order;

  const ids = Object.keys(badges);
  const categoryJs = JSON.stringify({ needsHuman, all: ids });

  return {
    ids,
    badges,
    labels,
    needsHuman,
    tabs,
    groupOf,
    categoryJs,
  };
}

/**
 * 主控台統計的 key 與顯示順序。
 *
 * 這裡刻意**不**讓 stats 鍵名去猜分類 id：id 是業務用語（DAY_DIFF），
 * 日誌裡長期用的是較短的別名（day）。若要從 id 推導，就得引入一張對照表，
 * 那正是本模組想消滅的第二份真相。工具端自己宣告要印哪些欄位。
 */
export function formatCategorySummary(
  registry: CategoryRegistry,
  countByCategory: (id: string) => number,
): Record<string, number> {
  const summary: Record<string, number> = { total: countByCategory('__total__') };
  for (const id of registry.ids) {
    summary[id.toLowerCase()] = countByCategory(id);
  }
  return summary;
}

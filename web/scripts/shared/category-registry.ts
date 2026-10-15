/**
 * 共用層：差異分類的宣告與推導。
 *
 * 過去新增一個分類要同時改**六處**：`NEEDS_HUMAN_CATEGORIES`、`BADGE_BY_CATEGORY`、
 * `statusLabel`、分頁按鈕、`renderInsightGroups` 的 filter、以及 `main()` 的主控台統計。
 * 只改其中幾處是 review 中實際發生過的錯誤——漏了 BADGE 就渲染出 undefined class，
 * 漏了分頁就會出現點不掉的頁籤，漏了主控台統計則會少報數字，而**分類計數本身不變**，
 * 因此任何以計數為基礎的檢查都抓不到。
 *
 * ## 目前由 specs 推導的（新增分類時自動跟上）
 *
 *   1. `badges`    —— id → CSS class
 *   2. `labels`    —— id → 中文顯示名稱（工具端的 statusLabel 取自此）
 *   3. `tabs`      —— 分頁按鈕的集合與順序
 *   4. `needsHuman`—— 需人工判讀的清單；統計卡的需人工判讀計數取自此
 *   5. `summaryKeys`／主控台統計 —— 欄位集合、順序與鍵名
 *   6. `groupOf`   —— id → 歸納群組 key（值已備妥，但尚未接線，見下）
 *
 * ## 仍需在工具端手寫、尚未接上推導的
 *
 *   - `renderHtml` 統計卡：九個 `count('CATEGORY')` 字面值；
 *   - `INSIGHT_GROUPS` 的 filter：各自直接比 `statusCategory` 字面值；
 *   - `buildNotes` 的各分類分支：逐一比對 `statusCategory`。
 *
 * 前兩者的資料其實都已在 specs 裡（`summaryKey` 與 `insightGroup`），只是尚未
 * 被讀取，因此**同一個分類資訊在本檔被寫了兩份，兩份不同步時不會報錯**。
 * 這是刻意留下的接線，歸下一個工具（按堂計價）時才做：目前只有一個真實使用者，
 * 在沒有第二個案例時先設計推導介面容易猜錯形狀。
 *
 * 因此本模組的定位是「**兩個工具要共用宣告與推導**」，
 * 而非「一個工具內部已不再重複」。
 */

/**
 * 分類的宣告式描述。
 *
 * - `id`：分類代碼。**不是**主控台統計的欄位名——那由 `summaryKey` 另行宣告。
 * - `label`：報表上顯示的中文名稱。
 * - `badge`：對應的 CSS class（沿用系統既有配色語意）。
 * - `needsHuman`：是否屬於「需人工判讀、非兩邊直接比大小」。這組必須在
 *   所有 UI 介面一致處理（統計卡、分頁、JS 過濾），否則新增類別只改到一處就會漏。
 * - `tab`：分頁按鈕的過濾值（省略則不產出按鈕）；`tabOrder` 決定顯示順序。
 * - `insightGroup`：此分類歸入哪一個差異歸納群組；`'none'` 表示不歸入任何群組。
 */
export interface CategorySpec {
  id: string;
  label: string;
  badge: string;
  needsHuman: boolean;
  /**
   * 主控台統計的欄位名（**必填**，省略即拋錯）。
   *
   * 必填而非「省略時以 id 為鍵」：退回用 id 會讓統計鍵名從 'day' 變成
   * 'DAY_DIFF'，數值與順序都不變、HTML 也不受影響，而分類計數在別處仍然正確——
   * 沒有任何既有檢查會發現這個對外契約被改掉。
   *
   * 分類 id 是業務用語（DAY_DIFF），而日誌裡長期使用的是較短的別名（day）。
   * 兩者不同名不是筆誤：日誌的鍵名是**對外契約**，改它會讓習慣 grep 舊日誌的人
   * 找不到東西。因此別名必須在 specs 裡顯式宣告，不可從 id 推導
   * （toLowerCase 會得到 'day_diff'，與既有的 'day' 不同）。
   */
  summaryKey: string;
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
  /** id → 主控台統計的欄位名（summaryKey 必填，故無預設值）。 */
  readonly summaryKeys: Readonly<Record<string, string>>;
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
 * 建一個沒有原型鏈的字典。
 *
 * 以 `{}` 建立的字典在賦值 `__proto__` 時不會產生自���屬性，而是改寫該物件的
 * 原型——於是該分類的 badge／label／統計鍵名會整個消失，且不產生任何錯誤。
 * 分類 id 目前來自程式內固定字面值，碰不到 `__proto__`，因此這是潛在而非現存缺陷；
 * 但 PR C 的第二個工具會帶自己的分類集合，那時 id 的來源就不只一份程式碼了。
 *
 * `Object.create(null)` 讓每個鍵都是自���屬性，包括 `__proto__`。代價是 console
 * 輸出多出 `[Object: null prototype]` 前綴，屬可接受。
 *
 * 也因此不可對這些字典使用 `in`（會命中繼承而來的鍵）——formatCategorySummary
 * 以 Set 記錄已用鍵名正是為此。
 */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

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
 *   5. 每個 spec 都必須宣告 summaryKey——退回用 id 會靜默改掉對外契約。
 */
export function defineCategories(specs: readonly CategorySpec[]): CategoryRegistry {
  if (specs.length === 0) {
    throw new CategorySpecError('defineCategories：至少需要一個分類宣告。');
  }

  const badges = emptyRecord<string>();
  const labels = emptyRecord<string>();
  const summaryKeys = emptyRecord<string>();
  const groupOf = emptyRecord<string>();
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
    if (!spec.summaryKey) {
      throw new CategorySpecError(
        `defineCategories：${where} 未宣告 summaryKey（主控台統計的欄位名）。` +
        `此欄位必須顯式宣告——若默默退回用 id，統計鍵名會從 'day' 變成 'DAY_DIFF'，` +
        `而這是對外契約：分類計數在別處仍然正確，因此沒有任何既有檢查會發現。`,
      );
    }
    summaryKeys[spec.id] = spec.summaryKey;
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
    summaryKeys,
    needsHuman,
    tabs,
    groupOf,
    categoryJs,
  };
}

/**
 * 主控台統計的欄位集合。
 *
 * 鍵名取自各 spec 的 `summaryKey`（必填），順序即 specs 的宣告順序，
 * `total` 置於第一。
 *
 * 這裡刻意**不**從 id 推導鍵名：日誌的鍵名是對外契約，`DAY_DIFF.toLowerCase()`
 * 會得到 `day_diff`，與既有的 `day` 不同——改掉會讓習慣 grep 舊日誌的人找不到東西。
 * 別名因此必須在 specs 裡顯式宣告。
 *
 * 兩個鍵撞到同一名稱時拋錯：靜默覆蓋會讓某個分類的筆數從日誌裡消失，
 * 而分類計數在別的地方仍是對的——正是最難察覺的那種錯誤。
 */
export function formatCategorySummary(
  registry: CategoryRegistry,
  counts: { total: number; byCategory: (id: string) => number },
): Record<string, number> {
  const summary: Record<string, number> = { total: counts.total };
  // 以 Set 記錄已用鍵名，不使用 `in`——物件字面量的 `in` 也會命中繼承而來的
  // 'constructor'、'toString' 等鍵，讓名稱湊巧撞上的分類被誤判為重複。
  const used = new Set<string>(['total']);
  for (const id of registry.ids) {
    const key = registry.summaryKeys[id];
    if (used.has(key)) {
      throw new CategorySpecError(
        `defineCategories：主控台統計欄位「${key}」重複（分類 ${id}）。`,
      );
    }
    used.add(key);
    summary[key] = counts.byCategory(id);
  }
  return summary;
}

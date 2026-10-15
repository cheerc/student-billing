/**
 * 共用層：離線 HTML 報告的外殼與樣式。
 *
 * 抽出這一層的理由：兩個工具的報告外觀必須一致，而樣式是其中最容易無聲分歧的
 * 部分——同一段 CSS 複製兩份之後改了一邊忘了另一邊，不會有任何錯誤，
 * 只會讓兩份報告慢慢長得不一样。
 *
 * 本檔提供的是**外殼**：doctype、head、CSS、頁首、meta 面板、表格骨架、
 * 分頁列、搜尋列與頁面腳本。表格列、統計卡、差異歸納群組的**內容**仍由工具端
 * 提供——那些是業務內容，共用層不知道國小輔導或按堂計價的欄位意義。
 */
import type { CategoryRegistry } from './category-registry.ts';

/**
 * 報告樣式。
 *
 * **這是一份複製件，不是單一來源。** Token 與元件版型取自
 * `web/src/app/globals.css`（CLAUDE.md §9.4 要求報告沿用系統 design token，
 * 不另立調色盤）。讓兩處真正共用同一份 CSS 需要 build step 或在執行時讀取
 * 原始檔再嵌入，兩者都超出這個 side script 的維護範圍（§9.0：不追求與產品
 * 同級別的覆蓋，能用、能重跑即可）。
 *
 * 因此誠實標示為複製件：日後修改系統樣式時，**必須同步檢查本檔**。
 * 本檔不可獨立於 globals.css 演化。
 */
export const REPORT_CSS = `/* Token 與元件版型取自 web/src/app/globals.css，維持與系統一致的視覺語言。
   報告為單檔離線輸出，故在此沿用同一組變數與 class，不改動系統樣式。 */
  :root {
    --bg-primary: #f8fafc;
    --bg-card: #ffffff;
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #64748b;
    --border-color: #e2e8f0;
    --primary-color: #2563eb;
    --primary-hover: #1d4ed8;
    --badge-bg: #eff6ff;
    --badge-text: #1d4ed8;
    --code-bg: #f1f5f9;
    --success-bg: #ecfdf5;
    --success-text: #065f46;
    --warning-bg: #fffbeb;
    --warning-text: #92400e;
    --danger-bg: #fef2f2;
    --danger-text: #991b1b;
    --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background-color: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-family);
    line-height: 1.5;
    min-height: 100vh;
    /* 報告固定淺色，不隨系統深色模式翻轉（與系統一致） */
    color-scheme: light;
  }

  .main {
    padding: 24px;
    max-width: 1800px;
    margin: 0 auto;
    width: 100%;
  }

  /* Header：沿用 .header + .logo-badge */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 20px;
  }

  .header-title { display: flex; align-items: center; gap: 12px; }
  .header-title h1 { font-size: 1.25rem; font-weight: 700; }

  .logo-badge {
    background-color: var(--badge-bg);
    color: var(--badge-text);
    font-size: 0.75rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 9999px;
    border: 1px solid #bfdbfe;
  }

  .report-desc {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 16px;
    max-width: 900px;
  }

  /* Meta panel：沿用 .meta-panel / .meta-item */
  .meta-panel {
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
    font-size: 0.8125rem;
    display: flex;
    flex-wrap: wrap;
    gap: 16px 32px;
  }

  .meta-item { display: flex; flex-direction: column; }

  .meta-item-label {
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 2px;
  }

  .meta-item-val {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: var(--text-primary);
    font-weight: 600;
  }

  /* Stats：沿用 .stats-grid / .stat-card */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.04);
  }

  .stat-label {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 4px;
  }

  .stat-value { font-size: 1.75rem; font-weight: 700; color: var(--text-primary); }

  .stat-value.is-match { color: var(--success-text); }
  .stat-value.is-diff { color: var(--warning-text); }
  .stat-value.is-neutral { color: var(--text-muted); }

  .stat-sub { font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; }

  /* 差異歸納：沿用 .alert 語意（琥珀=需確認、灰=資訊） */
  .insight-group { margin-bottom: 8px; }
  .insight-group h2 { font-size: 1rem; font-weight: 600; margin-bottom: 10px; }

  .alert {
    padding: 12px 16px;
    border-radius: 6px;
    font-size: 0.875rem;
    margin-bottom: 12px;
  }

  .alert-warning {
    background-color: var(--warning-bg);
    color: var(--warning-text);
    border: 1px solid #fde68a;
  }

  .alert-neutral {
    background-color: var(--bg-card);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
  }

  .alert ul { margin: 8px 0 0; padding-left: 20px; }
  .alert li { margin-bottom: 4px; }
  .alert .hint { color: var(--text-muted); font-size: 0.75rem; margin-top: 8px; }

  /* Tabs：沿用系統底線式（非藥丸式） */
  .tabs {
    display: flex;
    gap: 20px;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .tabs button {
    padding: 10px 4px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text-muted);
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s ease;
  }

  .tabs button:hover { color: var(--text-primary); }

  .tabs button.selected {
    color: var(--primary-color);
    border-bottom: 2px solid var(--primary-color);
  }

  .filterbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin-bottom: 16px;
  }

  input.search {
    min-height: 32px;
    padding: 7px 10px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    font-size: 0.8125rem;
    width: 260px;
    outline: none;
    background-color: var(--bg-card);
    color: var(--text-primary);
  }

  input.search:focus { border-color: var(--primary-color); }

  .scope-hint { margin-left: auto; font-size: 12px; color: var(--text-muted); }

  /* Table：沿用 .table-container + .data-table（含黏性表頭與姓名欄） */
  .table-container {
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
  }

  .table-scroll { overflow: auto; max-height: 70vh; }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    font-size: 0.8125rem;
    min-width: 1560px;
  }

  .data-table th {
    background-color: #f8fafc;
    color: var(--text-muted);
    font-weight: 600;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .data-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-primary);
    vertical-align: top;
  }

  .data-table tbody tr:hover { background-color: #f8fafc; }
  .data-table tbody tr.row-diff td { background-color: var(--warning-bg); }
  .data-table tbody tr.row-diff:hover td { background-color: #fef9c3; }

  .data-table .number { text-align: right; font-variant-numeric: tabular-nums; }

  .data-table .sticky-name {
    position: sticky;
    left: 0;
    z-index: 1;
    background: #fff;
    min-width: 96px;
  }

  /* 凍結欄的表頭交會格：z-index 抬高到 sticky 姓名欄之上，並沿用表頭底色
     （.sticky-name 的 #fff 特異度高於 th 的 #f8fafc，此處補回以免單獨發白） */
  .data-table th.sticky-name {
    z-index: 3;
    background-color: #f8fafc;
  }

  .data-table tbody tr:hover .sticky-name { background: #fafcff; }
  .data-table tbody tr.row-diff .sticky-name { background-color: var(--warning-bg); }

  /* Badges：沿用系統既有配色語意（綠=ok、藍=tier、琥珀=warn、紅=withdrawal、灰=class） */
  .badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }

  .badge-ok { background-color: var(--success-bg); color: var(--success-text); }
  .badge-tier { background-color: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
  .badge-warn { background-color: var(--warning-bg); color: var(--warning-text); }
  .badge-withdrawal { background-color: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .badge-class { background-color: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }

  .diff-box {
    background-color: var(--danger-bg);
    color: var(--danger-text);
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 700;
    display: inline-block;
  }

  .match-box { color: var(--success-text); font-weight: 600; }

  .class-tag {
    font-size: 11px;
    background-color: var(--code-bg);
    color: var(--text-secondary);
    padding: 1px 6px;
    border-radius: 4px;
    display: inline-block;
    margin: 1px 2px 1px 0;
  }

  .note-text {
    font-size: 0.75rem;
    color: var(--text-secondary);
    min-width: 260px;
    line-height: 1.5;
  }

  .note-text.is-warn { color: var(--warning-text); }
  .muted { color: var(--text-muted); }

  @media (max-width: 800px) {
    .main { padding: 16px; }
  }`;

/** HTML 內容一律經此跳脫；報表欄位全部來自外部檔案，不可直接內插。 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

/** meta 面板的一格。順序由工具端決定，因為各工具要顯示的出處不同。 */
export interface MetaItem {
  label: string;
  value: string;
}

/** 統計卡的一張。tone 決定數字配色（沿用 .is-match／.is-diff／.is-neutral）。 */
export interface StatCard {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'match' | 'diff' | 'neutral' | 'plain';
}

/** 表格欄位定義；至少要有 scope 才能產生 <th>。 */
export interface ColumnSpec {
  key: string;
  heading: string;
  /** 凍結欄（姓名）：表頭與儲存格都要套 sticky 樣式。 */
  sticky?: boolean;
  /** 靠右對齊的數值欄。 */
  numeric?: boolean;
}

export interface RenderShellOptions {
  /** <title> 與頁面 h1。 */
  title: string;
  /** 頁首徽章文字，例如「帳務實質比對」。 */
  logoBadge: string;
  /** 標題下方的說明段落。 */
  description: string;
  meta: readonly MetaItem[];
  stats: readonly StatCard[];
  /** 差異成因歸納區塊的內容（通常是幾個 .alert）。 */
  insightHtml: string;
  /**
   * 歸納區塊內、緊接在分類群組之後的額外警示（例如「天數與折扣同時差異」）。
   *
   * 刻意是陣列而非單一字串：每個項目各佔一行，即使內容為空字串也保留該行。
   * 這是原樣板的既有輸出——空項目會留下一列只有縮排的行。抽成陣列讓「零個
   * 額外警示」與「警示存在但內容為空」在型別上可區分，且工具端不必自行
   * 湊換行來對齊位元組。
   */
  extraInsights: readonly string[];
  columns: readonly ColumnSpec[];
  /** <tbody> 的內容，由工具端 renderRow 產生。 */
  rowsHtml: string;
  /** 名單重名警告；空陣列時不渲染。 */
  duplicateNames: readonly string[];
  /** 工具端自算的計數，供固定按鈕標籤使用。 */
  total: number;
  diffCount: number;
  needsHumanCount: number;
  /**
   * 分頁按鈕（value = 分類 id，label = 含計數的顯示文字）。
   *
   * **順序由工具端決定**：共用層不猜閱讀優先序（先看差異、最後才看一致），
   * 但按鈕**清單本身**必須來自 registry.tabs——那才是「新增分類自動出現分頁」
   * 的保證。工具端只補上計數文字，不得另列一份按鈕。
   */
  tabs: readonly { value: string; label: string }[];
  /**
   * 分類單一真相來源。分頁按鈕清單來自它的 tabs，注入頁面腳本的分類清單
   * 來自它的 categoryJs——兩者因此不可能與 badge／統計不同步。
   */
  registry: CategoryRegistry;
}

function renderMetaItem(item: MetaItem): string {
  return `    <div class="meta-item">
      <span class="meta-item-label">${escapeHtml(item.label)}</span>
      <span class="meta-item-val">${escapeHtml(item.value)}</span>
    </div>`;
}

function renderStatCard(card: StatCard): string {
  const toneClass = card.tone && card.tone !== 'plain' ? ` is-${card.tone}` : '';
  return `    <div class="stat-card">
      <span class="stat-label">${escapeHtml(card.label)}</span>
      <span class="stat-value${toneClass}">${escapeHtml(card.value)}</span>
      ${card.sub ? `<span class="stat-sub">${escapeHtml(card.sub)}</span>` : ''}
    </div>`;
}

function renderTabButton(value: string, label: string, selected: boolean): string {
  return `<button${selected ? ' class="selected"' : ''} onclick="filterTable(this,'${escapeHtml(value)}')">${escapeHtml(label)}</button>`;
}

/**
 * 組出完整的單檔 HTML 報告。
 *
 * 分頁按鈕刻意**不**在此重複列出分類清單：按鈕的**集合**由 registry.tabs 推導，
 * 新增帶 tab 的分類時按鈕自動出現（見 category-registry.ts）。工具端只負責
 * 補上計數文字與排列順序，不得自己列一份分類清單——那正是本模組要消滅的
 * 第二份真相。
 */
export function renderShell(opts: RenderShellOptions): string {
  const { registry } = opts;


  const metaHtml = opts.meta.map(renderMetaItem).join('\n');
  const statsHtml = opts.stats.map(renderStatCard).join('\n');

  const headHtml = opts.columns.map(c => {
    // 數值欄的表頭在原報告中不帶 class（只有 `<td class="number">` 有），故 numeric 不影響表頭。
    const cls = c.sticky ? 'sticky-name' : '';
    return `<th${cls ? ` class="${cls}"` : ''}>${escapeHtml(c.heading)}</th>`;
  }).join('\n          ');

  const duplicateWarning = opts.duplicateNames.length
    ? `<div class="alert alert-neutral"><strong>比對警告：名單重名（${opts.duplicateNames.length} 筆）</strong>：${opts.duplicateNames
        .map(escapeHtml)
        .join('、')}，以姓名比對可能誤配，請改以人員代碼核對。</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>${escapeHtml(opts.title)}</title>
<style>
${REPORT_CSS}
</style>
</head>
<body>
<main class="main">
  <header class="header">
    <div class="header-title">
      <h1>${escapeHtml(opts.title)}</h1>
      <span class="logo-badge">${escapeHtml(opts.logoBadge)}</span>
    </div>
  </header>

  <p class="report-desc">
    ${opts.description}
  </p>

  <div class="meta-panel">
${metaHtml}
  </div>

  <div class="stats-grid">
${statsHtml}
  </div>

  <section class="insight-group">
    <h2>差異成因歸納（由資料推導）</h2>
    ${opts.insightHtml || '<p class="hint">無差異項目。</p>'}
${opts.extraInsights.map(a => `    ${a}`).join('\n')}
    ${duplicateWarning}
  </section>

  <div class="tabs">
    ${renderTabButton('all', `全部 (${opts.total})`, true)}
    ${renderTabButton('diff', `僅差異 (${opts.diffCount})`, false)}
    ${opts.tabs.map(t => renderTabButton(t.value, t.label, false)).join('\n    ')}
    ${renderTabButton('needsHuman', `需人工判讀 (${opts.needsHumanCount})`, false)}
  </div>

  <div class="filterbar">
    <input type="text" id="q" class="search" placeholder="搜尋姓名／代碼／班級／說明">
    <span class="scope-hint" id="rowHint">顯示 ${opts.total} 筆</span>
  </div>

  <div class="table-container">
    <div class="table-scroll">
      <table id="cmp" class="data-table">
        <thead><tr>
          <th class="number">#</th>
          ${headHtml}
        </tr></thead>
        <tbody>${opts.rowsHtml}</tbody>
      </table>
    </div>
  </div>
</main>
<script>
  // 分類清單由 Node 端注入，與 badge／統計／歸納群組同源，不在此另寫一份
  const CATEGORIES = ${registry.categoryJs};
  let filter = 'all';
  function filterTable(btn, value) {
    filter = value;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    applyFilters();
  }
  function applyFilters() {
    const q = document.getElementById('q').value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('#cmp tbody tr').forEach(row => {
      const cat = row.dataset.cat;
      const okType = filter === 'all' ? true
        : filter === 'diff' ? cat !== 'MATCH'
        : filter === 'needsHuman' ? CATEGORIES.needsHuman.includes(cat)
        : cat === filter;
      const ok = okType && (!q || row.innerText.toLowerCase().includes(q));
      row.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    document.getElementById('rowHint').textContent = '顯示 ' + shown + ' 筆';
  }
  document.getElementById('q').addEventListener('input', applyFilters);
</script>
</body>
</html>
`;
}

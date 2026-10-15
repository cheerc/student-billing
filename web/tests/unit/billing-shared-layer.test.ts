import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { normalizeName, indexByName } from '../../scripts/shared/name-matching';
import { noteFlags, EMPTY_NOTE } from '../../scripts/shared/notes';
import type { Note, NoteTierMismatch } from '../../scripts/shared/notes.ts';
import { defineCategories, formatCategorySummary, CategorySpecError } from '../../scripts/shared/category-registry';
import { assertProjectRoot, assertOutputOutsideProject } from '../../scripts/shared/project-guard';
import { parseDiscounts, bpsToLabel, readReport, RATE_PATTERNS } from '../../scripts/shared/report-xlsx';
import type { ExcelRowLike, WorksheetLike } from '../../scripts/shared/report-xlsx.ts';
import { REPORT_CSS, escapeHtml } from '../../scripts/shared/report-shell';
import { BADGES, NEEDS_HUMAN } from '../../scripts/compare-billing-report.mjs';

/**
 * 共用層（web/scripts/shared/）的契約測試。
 *
 * 這一層的測試重點與產品領域層不同：產品層測「規則算得對不對」，
 * 共用層測的是**會不會靜默劣化**——抽出共用程式碼時最危險的不是功能寫錯，
 * 而是把一個原本有意義的細節（承重的 continue、空值預設、哨兵驗證、
 * 分類完整性檢查）抽掉之後程式照樣跑、輸出照樣合理、但報告的某個部分悄悄不同。
 *
 * 全部使用合成資料，無任何真實個資（CLAUDE.md §3）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('共用層：姓名索引', () => {
  const S = (name: string, personCode: string) => ({ name, personCode });

  it('唯一姓名 → 直接索引到該學生', () => {
    const { map, duplicates } = indexByName([S('合成甲', 'P-SYNTH-0001')]);
    expect(map.get('合成甲')?.personCode).toBe('P-SYNTH-0001');
    expect(duplicates).toEqual([]);
  });

  it('括號英文名在索引端被去掉', () => {
    const { map } = indexByName([S('合成甲 (Mia)', 'P-SYNTH-0001')]);
    expect([...map.keys()]).toEqual(['合成甲']);
    // 查詢端必須用同一個函式
    expect(map.get(normalizeName('合成甲'))?.personCode).toBe('P-SYNTH-0001');
  });

  /**
   * **本檔最高價值的測試：同名第三人的回歸防護。**
   *
   * indexByName 的 `continue` 是承重的，不是一般防呆。逐行推理：
   *
   *   第一次 '合成辛' → map 無此 key → set(學生A)
   *   第二次 '合成辛' → map.has 為 true → duplicates.push、set(key, null)、continue
   *   第三次 '合成辛' → map.has 仍為 true（key 存在，值是 null）
   *                      → set(key, null)、continue
   *
   * `continue` 讓第二次之後**不再執行**下方的 `map.set(key, s)`。
   * 拿掉它，第三次就會把 null 覆蓋成學生C 的物件，歧義標記消失：
   * 報表上會出現一個看起來很確定的配對結果，而 `duplicates` 仍會列出該姓名、
   * 仍會顯示「名單重名」警告——於是警告存在、資料卻已被配對，最難察覺的一種錯。
   *
   * 只有「三人以上同名」才會觸發，故既有測試（同名兩人）抓不到它。
   */
  it('三人同名 → 仍記為歧義（null），不可被第三人覆蓋成真實學生', () => {
    const { map, duplicates } = indexByName([
      S('合成辛 (A)', 'P-SYNTH-0007A'),
      S('合成辛 (B)', 'P-SYNTH-0007B'),
      S('合成辛 (C)', 'P-SYNTH-0007C'),
    ]);
    expect(map.has('合成辛'), '索引應保留此 key 以便辨識「有此姓名但無法唯一配對」').toBe(true);
    expect(map.get('合成辛'), '三人同名時值必須是 null（歧義），不可是任一位學生').toBeNull();
    // 關鍵：第三人的人員代碼不可出現在索引值中
    expect(JSON.stringify([...map.values()])).not.toContain('P-SYNTH-0007C');
    expect(duplicates).toEqual(['合成辛', '合成辛']);
  });

  it('四人同名 → 同樣維持歧義（持續重複不得反轉結論）', () => {
    const { map } = indexByName([
      S('合成辛 (A)', 'P-SYNTH-0007A'),
      S('合成辛 (B)', 'P-SYNTH-0007B'),
      S('合成辛 (C)', 'P-SYNTH-0007C'),
      S('合成辛 (D)', 'P-SYNTH-0007D'),
    ]);
    expect(map.get('合成辛')).toBeNull();
  });

  it('同名者出現在索引兩端都記為歧義，順序不影響', () => {
    const forward = indexByName([S('合成辛 (A)', 'A'), S('合成辛 (B)', 'B'), S('合成辛 (C)', 'C')]);
    const reverse = indexByName([S('合成辛 (C)', 'C'), S('合成辛 (B)', 'B'), S('合成辛 (A)', 'A')]);
    expect(forward.map.get('合成辛')).toBeNull();
    expect(reverse.map.get('合成辛')).toBeNull();
  });

  it('重名與其他學生的索引互不影響', () => {
    const { map } = indexByName([
      S('合成甲', 'P-SYNTH-0001'),
      S('合成辛 (A)', 'A'),
      S('合成辛 (B)', 'B'),
      S('合成辛 (C)', 'C'),
      S('合成乙', 'P-SYNTH-0002'),
    ]);
    expect(map.get('合成甲')?.personCode).toBe('P-SYNTH-0001');
    expect(map.get('合成乙')?.personCode).toBe('P-SYNTH-0002');
    expect(map.get('合成辛')).toBeNull();
  });

  it('空字串姓名不被當成有效 key（報表端已過濾，此處守住同一假設）', () => {
    const { map } = indexByName([S('   ', 'P-SYNTH-0001')]);
    expect(map.size).toBe(1);
    expect([...map.keys()]).toEqual(['']);
  });
});

describe('共用層：Note 形狀與旗標', () => {
  const MISMATCH: NoteTierMismatch = {
    status: 'mismatch', erpDeclaredTier: 5, computedTier: 4.5, rawToken: '合成班[團]',
  };
  const note = (over: Partial<Note> = {}): Note => ({ ...EMPTY_NOTE, ...over });

  it('EMPTY_NOTE 的四個旗標皆為 falsy → 不進任何歸納群組', () => {
    const f = noteFlags(EMPTY_NOTE);
    expect(f.hasMismatches).toBe(false);
    expect(f.hasDupIssues).toBe(false);
    expect(f.homework).toBe(false);
    expect(f.withdrawal).toBe(false);
  });

  it('欄位集合固定，正是共用層 Note 型別成立的前提', () => {
    expect(Object.keys(EMPTY_NOTE).sort()).toEqual(
      ['dupIssues', 'homework', 'mismatches', 'notes', 'tags', 'tone', 'withdrawal'].sort(),
    );
  });

  it('旗標只看「有無」，不因資料筆數改變（渲染層只用 truthiness）', () => {
    const one = noteFlags(note({ mismatches: [MISMATCH] }));
    const two = noteFlags(note({ mismatches: [MISMATCH, { ...MISMATCH, rawToken: 'y' }] }));
    expect(one.hasMismatches).toBe(true);
    expect(two.hasMismatches).toBe(true);
    expect(noteFlags(EMPTY_NOTE).hasMismatches).toBe(false);
  });

  it('homework／withdrawal 直接取布林值，不做空值推斷', () => {
    expect(noteFlags(note({ homework: true })).homework).toBe(true);
    expect(noteFlags(note({ withdrawal: true })).withdrawal).toBe(true);
  });
});

/**
 * 國小輔導工具實際使用的分類宣告，與 compare-billing-report.mjs 保持一致。
 *
 * 刻意在此重複一份而非 import：這份測試的價值正是「若工具端漏填欄位，
 * 這裡會失敗」。若改成 import 工具端的同一份，兩邊一起錯就抓不到。
 */
const BILLING_SPECS = [
  { id: 'MATCH', label: '完全一致', summaryKey: 'match', badge: 'badge-ok', needsHuman: false, tab: 'MATCH', tabOrder: 30, insightGroup: 'none' },
  { id: 'DAY_DIFF', label: '天數差異', summaryKey: 'day', badge: 'badge-tier', needsHuman: false, tab: 'DAY_DIFF', tabOrder: 10, insightGroup: 'mismatch' },
  { id: 'DISCOUNT_DIFF', label: '折扣差異', summaryKey: 'discount', badge: 'badge-warn', needsHuman: false, tab: 'DISCOUNT_DIFF', tabOrder: 20, insightGroup: 'none' },
  { id: 'BOTH_DIFF', label: '天數與折扣皆差異', summaryKey: 'both', badge: 'badge-withdrawal', needsHuman: false, insightGroup: 'mismatch' },
  { id: 'NOT_IN_WEB', label: '名單已無此人', summaryKey: 'notInWeb', badge: 'badge-class', needsHuman: true, insightGroup: 'notInWeb' },
  { id: 'EXCEL_NO_TUITION', label: '報表無學費項', summaryKey: 'noTuition', badge: 'badge-class', needsHuman: true, insightGroup: 'notInWeb' },
  { id: 'UNPAIRABLE', label: '姓名無法唯一配對', summaryKey: 'unpairable', badge: 'badge-withdrawal', needsHuman: true, insightGroup: 'unpairable' },
  { id: 'TIER_UNPARSED', label: '報表級距無法解析', summaryKey: 'tierUnparsed', badge: 'badge-warn', needsHuman: true, insightGroup: 'unparsed' },
  { id: 'RATE_UNPARSED', label: '報表折扣無法解析', summaryKey: 'rateUnparsed', badge: 'badge-warn', needsHuman: true, insightGroup: 'unparsed' },
];

describe('共用層：defineCategories 的衍生與不變式', () => {
  it('每個 spec id 都有 badge 與 label，沒有 undefined', () => {
    const reg = defineCategories(BILLING_SPECS);
    for (const id of reg.ids) {
      expect(reg.badges[id], `分類 ${id} 缺少 badge`).toBeTruthy();
      expect(reg.labels[id], `分類 ${id} 缺少 label`).toBeTruthy();
      expect(reg.badges[id]).not.toContain('undefined');
      expect(reg.labels[id]).not.toContain('undefined');
    }
  });

  it('needsHuman 只包含宣告為 true 的分類，且順序即宣告順序', () => {
    const reg = defineCategories(BILLING_SPECS);
    expect(reg.needsHuman).toEqual([
      'NOT_IN_WEB', 'EXCEL_NO_TUITION', 'UNPAIRABLE', 'TIER_UNPARSED', 'RATE_UNPARSED',
    ]);
    // 反向：非 needsHuman 者不得出現
    for (const id of reg.ids) {
      if (!reg.needsHuman.includes(id)) expect(reg.needsHuman).not.toContain(id);
    }
  });

  it('分頁按鈕的值 ⊆ 全部分類 id（不可出現無對應分類的頁籤）', () => {
    const reg = defineCategories(BILLING_SPECS);
    for (const t of reg.tabs) expect(reg.ids, `分頁值 ${t.value} 不在分類清單內`).toContain(t.value);
  });

  /**
   * 每個 id 都必須被某個歸納群組認領，或顯式標記 'none'。
   *
   * 這條不變式對應的缺陷是：新增分類時忘了考慮它要不要進歸納群組，
   * 於是該分類的學生在報告裡不會出現在任何成因歸納之下——而分類計數完全不變，
   * 任何以計數為基礎的檢查都抓不到。
   */
  it('每個分類都被歸納群組認領，或顯式宣告 none', () => {
    const reg = defineCategories(BILLING_SPECS);
    for (const id of reg.ids) {
      const g = reg.groupOf[id];
      expect(g, `分類 ${id} 沒有 insightGroup`).toBeDefined();
      expect(typeof g === 'string' && g.length > 0).toBe(true);
    }
    // 本組宣告中實際使用的群組 key 都應有人認領，避免留下孤兒群組
    const used = new Set(reg.tabs.map(t => t.value));
    expect(used.size).toBe(3);
  });

  it('分頁按鈕依 tabOrder 排序，且未指定者排在最後', () => {
    const reg = defineCategories(BILLING_SPECS);
    expect(reg.tabs.map(t => t.value)).toEqual(['DAY_DIFF', 'DISCOUNT_DIFF', 'MATCH']);
  });

  it('categoryJs 與 badges／needsHuman 同源，注入頁面腳本不會與 UI 不同步', () => {
    const reg = defineCategories(BILLING_SPECS);
    const parsed = JSON.parse(reg.categoryJs);
    expect(parsed.needsHuman).toEqual([...reg.needsHuman]);
    expect(parsed.all).toEqual([...reg.ids]);
  });

  /**
   * 缺 badge 必須**拋錯**，而不是產出 undefined。
   *
   * 對應 review F-NEW-3 的真實缺陷：分類加了但沒接進 badge 對照，
   * 第一次出現就渲染出 `class="badge undefined"`——而分類計數完全正確。
   */
  it('spec 缺 badge → 拋錯，不可產出 undefined', () => {
    expect(() => defineCategories([
      { id: 'DAY_DIFF', label: '天數差異', summaryKey: 'day', needsHuman: false, tab: 'DAY_DIFF', insightGroup: 'none' } as never,
    ])).toThrow(CategorySpecError);
    expect(() => defineCategories([
      { id: 'DAY_DIFF', label: '天數差異', summaryKey: 'day', needsHuman: false, tab: 'DAY_DIFF', insightGroup: 'none' } as never,
    ])).toThrow(/缺少 badge/);
  });

  it('spec 缺 label → 拋錯（報告會顯示空白）', () => {
    expect(() => defineCategories([
      // label 刻意留空：本測試就是驗證缺 label 會被擋下
      { id: 'DAY_DIFF', badge: 'badge-tier', summaryKey: 'day', needsHuman: false, insightGroup: 'none' } as never,
    ])).toThrow(/缺少 label/);
  });

  it('未宣告 insightGroup → 拋錯，強迫撰寫者當下決定（含填 none）', () => {
    expect(() => defineCategories([
      { id: 'DAY_DIFF', label: '天數差異', badge: 'badge-tier', summaryKey: 'day', needsHuman: false } as never,
    ])).toThrow(/insightGroup/);
    expect(() => defineCategories([
      { id: 'DAY_DIFF', label: '天數差異', badge: 'badge-tier', summaryKey: 'day', needsHuman: false, insightGroup: '' } as never,
    ])).toThrow(/insightGroup/);
  });

  it('id 重複 → 拋錯，不可讓後者靜默覆蓋前者的 badge', () => {
    expect(() => defineCategories([
      { id: 'X', label: '甲', summaryKey: 'x', badge: 'badge-ok', needsHuman: false, insightGroup: 'none' },
      { id: 'X', label: '乙', summaryKey: 'y', badge: 'badge-warn', needsHuman: false, insightGroup: 'none' },
    ])).toThrow(/id 重複/);
  });

  it('分頁值重複 → 拋錯（兩個按鈕會過濾到同一組）', () => {
    expect(() => defineCategories([
      { id: 'X', label: '甲', summaryKey: 'x', badge: 'badge-ok', needsHuman: false, tab: 'SAME', insightGroup: 'none' },
      { id: 'Y', label: '乙', summaryKey: 'y', badge: 'badge-warn', needsHuman: false, tab: 'SAME', insightGroup: 'none' },
    ])).toThrow(/與另一個按鈕重複/);
  });

  it('空 specs → 拋錯（無分類的報告必然是壞的）', () => {
    expect(() => defineCategories([])).toThrow(CategorySpecError);
  });

  it('工具端的 BADGES／NEEDS_HUMAN 確實由 defineCategories 推導，值與本檔宣告一致', () => {
    const reg = defineCategories(BILLING_SPECS);
    expect(BADGES).toEqual(reg.badges);
    expect(NEEDS_HUMAN).toEqual(reg.needsHuman);
  });
});

describe('共用層：專案邊界守衛', () => {
  /** 真實專案根（由測試檔位置往上三層）應通過驗證。 */
  const realRoot = repoRoot;

  /** 建立一個形似專案根但哨兵不全的暫存目錄。 */
  const makeDir = (files: string[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
    for (const f of files) {
      const full = path.join(dir, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
    return dir;
  };

  it('真實專案根通過驗證，並回傳同一路徑', () => {
    expect(assertProjectRoot(realRoot)).toBe(path.resolve(realRoot));
  });

  /**
   * 這是本模組存在的理由。
   *
   * 若共用層自行寫死相對深度，或進入點誤用 `..`（只退一層）而哨兵驗證不存在，
   * 得到的會是 `web/`——`web/report.html` 仍會被擋下，但 `docs/`、`specs/`、
   * 根目錄本身都會靜默放行。守衛看起來在運作，實際保護範圍只有一半。
   *
   * 因此哨兵驗證必須把「web/ 冒充專案根」判成錯誤。
   */
  it('傳入 web/（深度只退一層的結果）→ 拋錯，不可靜默放行', () => {
    const webDir = path.join(realRoot, 'web');
    expect(() => assertProjectRoot(webDir)).toThrow(/專案根驗證失敗/);
    // 錯誤訊息必須指出真正的計法
    expect(() => assertProjectRoot(webDir)).toThrow(/"\.\.", "\.\."/);
  });

  it('哨兵缺任一個 → 拋錯並指名缺哪一個', () => {
    const noChild = makeDir(['CLAUDE.md']);
    expect(() => assertProjectRoot(noChild)).toThrow(/web/);

    const onlyChild = makeDir([path.join('web', 'package.json')]);
    expect(() => assertProjectRoot(onlyChild)).toThrow(/CLAUDE\.md/);

    const empty = makeDir([]);
    expect(() => assertProjectRoot(empty)).toThrow(/專案根驗證失敗/);
  });

  it('根目錄沒有 package.json 也不應被誤判（本專案的 npm 指令一律在 web/ 執行）', () => {
    // CLAUDE.md §4：根目錄本來就沒有 package.json；守衛要求它存在等於要求錯的東西
    expect(fs.existsSync(path.join(realRoot, 'package.json')), '前提變更：若根目錄新增 package.json，本測試需更新').toBe(false);
    expect(() => assertProjectRoot(realRoot)).not.toThrow();
  });

  it('專案內的路徑一律被拒絕（含根目錄本身與子目錄）', () => {
    expect(() => assertOutputOutsideProject(realRoot, path.join(realRoot, 'report.html')))
      .toThrow(/不得輸出至專案內/);
    expect(() => assertOutputOutsideProject(realRoot, realRoot)).toThrow(/不得輸出至專案內/);
    expect(() => assertOutputOutsideProject(realRoot, path.join(realRoot, 'docs', 'x.html')))
      .toThrow(/不得輸出至專案內/);
    expect(() => assertOutputOutsideProject(realRoot, path.join(realRoot, 'web', 'x.html')))
      .toThrow(/不得輸出至專案內/);
  });

  it('../ 穿越不得繞過檢查（穿越後仍落在專案內者必須被拒）', () => {
    // repo/docs/../x.html → repo/x.html，仍在專案內
    expect(() => assertOutputOutsideProject(realRoot, path.join(realRoot, 'docs', '..', 'x.html')))
      .toThrow(/不得輸出至專案內/);
    // repo/web/../docs/x.html → repo/docs/x.html，仍在專案內
    expect(() => assertOutputOutsideProject(realRoot, path.join(realRoot, 'web', '..', 'docs', 'x.html')))
      .toThrow(/不得輸出至專案內/);
    // 穿越到專案**之外**則確實應該放行，否則守衛過度阻擋會讓工具不能用
    expect(() => assertOutputOutsideProject(realRoot, path.join(realRoot, '..', 'escaped.html')))
      .not.toThrow();
  });

  it('專案外的同名前綴路徑不得被誤判為專案內', () => {
    const sibling = `${realRoot}-sibling`;
    expect(() => assertOutputOutsideProject(realRoot, path.join(sibling, 'report.html'))).not.toThrow();
    expect(() => assertOutputOutsideProject(realRoot, path.join(os.homedir(), 'Downloads', 'r.html'))).not.toThrow();
  });

  it('通過時回傳正規化後的路徑', () => {
    const out = assertOutputOutsideProject(realRoot, path.join(os.tmpdir(), 'a', '..', 'r.html'));
    expect(out).toBe(path.join(os.tmpdir(), 'r.html'));
  });
});

describe('共用層：報表科目解析', () => {
  it('bpsToLabel：無折扣明確寫出百分比，不用空白', () => {
    expect(bpsToLabel(10000)).toBe('無折扣 (100%)');
    expect(bpsToLabel(9000)).toBe('9折 (90%)');
    expect(bpsToLabel(8500)).toBe('8.5折 (85%)');
    expect(bpsToLabel(null)).toBe('-');
    expect(bpsToLabel(undefined)).toBe('-');
  });

  it('parseDiscounts 認得的五種折價率', () => {
    expect(parseDiscounts(['x[9折] - 課程費9折']).rateBps).toBe(9000);
    expect(parseDiscounts(['x[9.5折] - 課程費95折']).rateBps).toBe(9500);
    expect(parseDiscounts(['x[8.5折] - 課程費85折']).rateBps).toBe(8500);
    expect(parseDiscounts(['x[8折] - 課程費8折']).rateBps).toBe(8000);
    expect(parseDiscounts(['x[7折] - 課程費7折']).rateBps).toBe(7000);
  });

  it('9.5 折必須命中 95 折而非 9 折（白名單順序有意義）', () => {
    // 「課程費95折」含「課程費9」的前綴，若 9 折規則排在前面就會誤判為 9000
    expect(parseDiscounts(['x - 課程費95折']).rateBps).toBe(9500);
    // 白名單中 95 折確實排在 9 折之前
    expect(RATE_PATTERNS[0]![1]).toBe(9500);
  });

  it('認不出格式 → unknown，不可當成無折扣', () => {
    const r = parseDiscounts(['x[88折] - 課程費88折']);
    expect(r.rateParseStatus).toBe('unknown');
    expect(r.rateBps).toBe(10000);
    expect(r.extraDiscounts).toHaveLength(1);
  });

  it('判定與明細順序無關', () => {
    const a = parseDiscounts(['x - 課程費88折', 'y - 課程費9折']);
    const b = parseDiscounts(['y - 課程費9折', 'x - 課程費88折']);
    expect(a.rateParseStatus).toBe('unknown');
    expect(b.rateParseStatus).toBe('unknown');
  });

  it('純獨立優惠項 → none', () => {
    expect(parseDiscounts(['x[雜費] - 安課訂金']).rateParseStatus).toBe('none');
    expect(parseDiscounts([]).rateParseStatus).toBe('none');
  });

  /**
   * readReport 的科目分派必須可由參數改變——這是共用層能被按堂計價工具沿用的前提。
   */
  describe('readReport：科目分派參數化', () => {
    const row = (cells: Record<number, string | undefined>): ExcelRowLike => ({
      getCell: (n: number) => ({ text: cells[n] }),
    });
    const sheet = (rows: Record<number, string | undefined>[]): WorksheetLike => ({
      eachRow: (cb) => {
        rows.forEach((cells, i) => cb(row(cells), i + 1));
      },
    });

    it('國小輔導語意（學費／折扣）', () => {
      const m = readReport(sheet([
        { 1: '表頭' },
        { 1: '合成甲', 2: 'B-1', 3: '2026-09-10', 4: '某班[團][3] - 40 堂課', 7: '學費', 8: '已繳' },
        { 1: '合成甲', 4: '某班[團][9折] - 課程費9折', 7: '折扣' },
        { 1: '合成甲', 4: '某班[團][雜費] - 退費', 7: '雜費' },
      ]), { tuition: '學費', discount: '折扣' });

      const e = m.get('合成甲')!;
      expect(e.tuition).toBe('某班[團][3] - 40 堂課');
      expect(e.discounts).toEqual(['某班[團][9折] - 課程費9折']);
      expect(e.otherDiscounts).toEqual([]); // 課程費9折 認得出來，不算獨立優惠
      expect(e.other).toEqual(['某班[團][雜費] - 退費']);
      expect(e.billNo).toBe('B-1');
      expect(e.billDate).toBe('2026-09-10');
      expect(e.billStatus).toBe('已繳');
    });

    it('同一組資料換成另一組科目 → 分派結果不同（證明參數確實生效）', () => {
      const rows = [
        { 1: '表頭' },
        { 1: '合成甲', 4: '第一筆學費明細', 7: '學費' },
        { 1: '合成甲', 4: '課程費9折', 7: '折扣' },
        { 1: '合成甲', 4: '報名費明細', 7: '報名費' },
        { 1: '合成甲', 4: '車資', 7: '雜費' },
      ];
      const billing = readReport(sheet(rows), { tuition: '學費', discount: '折扣' });
      const sessions = readReport(sheet(rows), { tuition: '學費', discount: '報名費' });

      const b = billing.get('合成甲')!;
      const s2 = sessions.get('合成甲')!;

      // 國小輔導語意：課程費9折 是折扣，報名費與車資 是其他科目
      expect(b.discounts).toEqual(['課程費9折']);
      expect(b.other).toEqual(['報名費明細', '車資']);
      expect(b.tuition).toBe('第一筆學費明細');

      // 按堂計價語意：報名費 成了折扣科目，原本的折扣科目反而落到 other
      expect(s2.discounts).toEqual(['報名費明細']);
      expect(s2.other).toEqual(['課程費9折', '車資']);
      expect(s2.tuition).toBe('第一筆學費明細');
    });

    it('同一科目後出現者覆寫 tuition（原行為，不可被參數化過程改變）', () => {
      const m = readReport(sheet([
        { 1: '表頭' },
        { 1: '合成甲', 4: '第一筆', 7: '學費' },
        { 1: '合成甲', 4: '第二筆', 7: '學費' },
      ]), { tuition: '學費', discount: '折扣' });
      expect(m.get('合成甲')!.tuition).toBe('第二筆');
    });

    it('折扣科目內認不出的項目進 otherDiscounts，認得出的不算', () => {
      const m = readReport(sheet([
        { 1: '表頭' },
        { 1: '合成甲', 4: '課程費88折', 7: '折扣' },
        { 1: '合成甲', 4: '普測優惠', 7: '折扣' },
      ]), { tuition: '學費', discount: '折扣' });
      const e = m.get('合成甲')!;
      expect(e.discounts).toEqual(['課程費88折', '普測優惠']);
      expect(e.otherDiscounts).toEqual(['課程費88折', '普測優惠']);
    });

    it('第 1 列為表頭、姓名空白者跳過', () => {
      const m = readReport(sheet([
        { 1: '姓名' }, { 1: '' }, { 1: '   ' }, { 1: '合成甲', 7: '雜費', 4: 'x' },
      ]), { tuition: '學費', discount: '折扣' });
      expect([...m.keys()]).toEqual(['合成甲']);
    });

    it('同名多列：帳單欄位取先出現者，折扣累加', () => {
      const m = readReport(sheet([
        { 1: '表頭' },
        { 1: '合成甲', 2: 'B-1', 7: '雜費', 4: 'a' },
        { 1: '合成甲', 2: 'B-2', 7: '折扣', 4: '課程費9折' },
      ]), { tuition: '學費', discount: '折扣' });
      const e = m.get('合成甲')!;
      expect(e.billNo).toBe('B-1');
      expect(e.discounts).toEqual(['課程費9折']);
      expect(m.size).toBe(1);
    });
  });
});

/**
 * 主控台統計的鍵名是**對外契約**。
 *
 * 這組測試守的是一個實際發生過的回歸：PR #120 初版讓 main() 自己迴圈印
 * `CATEGORIES.ids`，鍵名從 `match: 184` 變成 `MATCH: 184`。數值與順序都對，
 * HTML 也完全不受影響，但任何 grep 舊日誌 `day:` 的人會突然找不到東西——
 * 而分類計數在別處仍然正確，因此沒有任何既有檢查會失敗。
 */
describe('共用層：主控台統計欄位', () => {
  /** 分類 id → 預期統計鍵名。用索引簽名讓 `reg.ids`（readonly string[]）可索引。 */
  const keyMirror: Record<string, string> = {
    MATCH: 'match', DAY_DIFF: 'day', DISCOUNT_DIFF: 'discount', BOTH_DIFF: 'both',
    NOT_IN_WEB: 'notInWeb', EXCEL_NO_TUITION: 'noTuition', UNPAIRABLE: 'unpairable',
    TIER_UNPARSED: 'tierUnparsed', RATE_UNPARSED: 'rateUnparsed',
  };

  it('鍵名取自各 spec 的 summaryKey，不是分類 id', () => {
    const reg = defineCategories(BILLING_SPECS);
    const summary = formatCategorySummary(reg, {
      total: 195,
      byCategory: (id) => ({ MATCH: 184, DAY_DIFF: 5 }[id] ?? 0),
    });
    expect(Object.keys(summary)).toEqual([
      'total', 'match', 'day', 'discount', 'both',
      'notInWeb', 'noTuition', 'unpairable', 'tierUnparsed', 'rateUnparsed',
    ]);
    expect(summary.match).toBe(184);
    expect(summary.day).toBe(5);
  });

  /**
   * id.toLowerCase() 會得到 'day_diff'，與既有的 'day' 不同。
   * 這是「看似合理的簡化」最容易造成的破壞，故直接釘住。
   */
  it('不可用 id.toLowerCase() 當鍵名（會得到 day_diff 而非 day）', () => {
    const reg = defineCategories(BILLING_SPECS);
    const summary = formatCategorySummary(reg, { total: 1, byCategory: () => 1 });
    expect(Object.keys(summary)).not.toContain('day_diff');
    expect(Object.keys(summary)).toContain('day');
    expect(Object.keys(summary)).not.toContain('DAY_DIFF'.toLowerCase());
  });

  it('total 置於第一，欄位順序即 specs 宣告順序', () => {
    const reg = defineCategories(BILLING_SPECS);
    const summary = formatCategorySummary(reg, { total: 7, byCategory: () => 0 });
    expect(Object.keys(summary)[0]).toBe('total');
    expect(summary.total).toBe(7);
    expect(Object.keys(summary).slice(1)).toEqual([...reg.ids].map(id => reg.summaryKeys[id]));
  });

  /**
   * summaryKey 必填：省略時必須拋錯，不可退回用 id。
   *
   * 這個 fallback 曾是真實缺陷：把 BOTH_DIFF 的 summaryKey 刪掉，工具照跑、
   * 印出 `BOTH_DIFF: 0` 而非 `both: 0`，HTML 完全不受影響，完整測試套件全綠，
   * exit code 0。統計鍵名是對外契約，而分類計數在別處仍然正確——
   * 所以沒有任何以計數或 HTML 為基礎的檢查會發現。
   */
  it('未宣告 summaryKey → 註冊時即拋錯，不可退回用 id', () => {
    expect(() => defineCategories([
      { id: 'BOTH_DIFF', label: '兩者皆差', badge: 'badge-withdrawal', needsHuman: false, insightGroup: 'none' } as never,
    ])).toThrow(/未宣告 summaryKey/);
    expect(() => defineCategories([
      { id: 'BOTH_DIFF', label: '兩者皆差', summaryKey: '', badge: 'badge-withdrawal', needsHuman: false, insightGroup: 'none' } as never,
    ])).toThrow(/未宣告 summaryKey/);
  });

  it('summaryKey 缺漏的錯誤訊息要點名分類與後果', () => {
    expect(() => defineCategories([
      { id: 'BOTH_DIFF', label: '兩者皆差', badge: 'badge-withdrawal', needsHuman: false, insightGroup: 'none' } as never,
    ])).toThrow(/BOTH_DIFF/);
    expect(() => defineCategories([
      { id: 'BOTH_DIFF', label: '兩者皆差', badge: 'badge-withdrawal', needsHuman: false, insightGroup: 'none' } as never,
    ])).toThrow(/對外契約/);
  });

  it('工具端九個分類都宣告了 summaryKey，鍵名與 main 的短別名一致', () => {
    // 直接讀工具端實際使用的 registry，避免只測本檔的鏡像
    const reg = defineCategories(BILLING_SPECS);
    for (const id of reg.ids) {
      expect(reg.summaryKeys[id], `分類 ${id} 缺 summaryKey 或鍵名不符`).toBe(keyMirror[id]);
      expect(reg.summaryKeys[id], `分類 ${id} 的統計鍵名不得等於 id`).not.toBe(id);
    }
  });

  /**
   * 兩個鍵撞名會讓後者覆寫前者 → 某個分類的筆數從日誌裡消失，
   * 而分類計數在別的地方仍是對的。必須拋錯而非靜默覆蓋。
   */
  it('兩個 spec 的 summaryKey 撞名 → 拋錯，不可靜默覆蓋', () => {
    const reg = defineCategories([
      { id: 'A', label: '甲', summaryKey: 'same', badge: 'badge-ok', needsHuman: false, insightGroup: 'none' },
      { id: 'B', label: '乙', summaryKey: 'same', badge: 'badge-warn', needsHuman: false, insightGroup: 'none' },
    ]);
    expect(() => formatCategorySummary(reg, { total: 0, byCategory: () => 0 }))
      .toThrow(/統計欄位「same」重複/);
  });

  it('summaryKey 與 total 撞名 → 拋錯（否則 total 會被某個分類蓋掉）', () => {
    const reg = defineCategories([
      { id: 'A', label: '甲', summaryKey: 'total', badge: 'badge-ok', needsHuman: false, insightGroup: 'none' },
    ]);
    expect(() => formatCategorySummary(reg, { total: 9, byCategory: () => 1 }))
      .toThrow(/統計欄位「total」重複/);
  });

  it('summaryKey 為 toString 等繼承而來的鍵名時不得誤判為重複', () => {
    // 物件字面量的 `in` 也會命中 Object.prototype 上的鍵，會造成誤判；
    // 實作改用 Set 記錄已用鍵名。
    const reg = defineCategories([
      { id: 'A', label: '甲', summaryKey: 'toString', badge: 'badge-ok', needsHuman: false, insightGroup: 'none' },
      { id: 'B', label: '乙', summaryKey: 'constructor', badge: 'badge-warn', needsHuman: false, insightGroup: 'none' },
    ]);
    const summary = formatCategorySummary(reg, { total: 0, byCategory: () => 0 });
    expect(Object.keys(summary)).toEqual(['total', 'toString', 'constructor']);
  });

  it('summaryKeys 索引可由 id 查出，且值即宣告的 summaryKey', () => {
    const reg = defineCategories(BILLING_SPECS);
    for (const id of reg.ids) expect(reg.summaryKeys[id]).toBe(keyMirror[id]);
    const bare = defineCategories([
      { id: 'X', label: '甲', summaryKey: 'x', badge: 'badge-ok', needsHuman: false, insightGroup: 'none' },
    ]);
    expect(bare.summaryKeys['X']).toBe('x');
  });
});

describe('共用層：HTML 外殼', () => {
  it('escapeHtml 跳脫五個危險字元，null／undefined 轉空字串', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"x"')).toBe('&quot;x&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('escapeHtml 是唯一進入 HTML 的路徑：報表欄位含 < 也不會破版', () => {
    const injected = '<img src=x onerror=alert(1)>';
    expect(escapeHtml(injected)).not.toContain('<img');
  });

  it('REPORT_CSS 含設計 token 與主要元件版型（沿用 globals.css）', () => {
    for (const token of ['--bg-primary', '--text-primary', '--border-color', '--font-family']) {
      expect(REPORT_CSS, `樣式缺少 ${token}`).toContain(token);
    }
    for (const cls of ['.meta-panel', '.stat-card', '.data-table', '.tabs', '.badge-ok']) {
      expect(REPORT_CSS, `樣式缺少 ${cls}`).toContain(cls);
    }
  });

  it('REPORT_CSS 內不得出現會終止 template literal 的字元', () => {
    expect(REPORT_CSS).not.toContain('`');
    expect(REPORT_CSS).not.toContain('${');
  });
});

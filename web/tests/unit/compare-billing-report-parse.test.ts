import { describe, it, expect } from 'vitest';
import { parseTuition, parseDiscounts, normalizeName, compare, BADGES, NEEDS_HUMAN } from '../../scripts/compare-billing-report.mjs';

/**
 * 帳務比對工具的解析契約。
 *
 * 這三個函式決定報告的每一個數字，因此 expected 一律依 specs/02 §7（R11／R12 週收費天數）
 * 與 §8（R13／R14 課程情境折扣）手算，不以工具輸出反推。
 *
 * 已知級距集合與產品端 web/src/domain/students/token-parser.ts 的 KNOWN_TIERS_MAP 同源；
 * 產品端對未知修飾回 erpBillingTier=null + needs_review，工具端不得默默回 5。
 */
describe('帳務比對工具：報表解析契約', () => {
  describe('normalizeName：索引端與查詢端必須同一套正規化', () => {
    it('去掉括號英文名，兩邊都經同一函式即可對上', () => {
      const rosterName = '王小明 (Alex)';
      const reportName = '王小明';

      const map = new Map([[normalizeName(rosterName), { name: rosterName }]]);
      expect([...map.keys()]).toEqual(['王小明']);

      // 這是 review F1 的缺陷：索引端正規化、查詢端用原文 → 配對失敗且被誤標成「名單已無此人」
      expect(map.get(normalizeName(reportName))).toEqual({ name: rosterName });
    });

    it('報表與名單都含括號英文名時也能對上', () => {
      const map = new Map([[normalizeName('王小明 (Alex)'), 'hit']]);
      expect(map.get(normalizeName('王小明 (Alex)'))).toBe('hit');
    });

    it('全形括號也算括號', () => {
      expect(normalizeName('王小明（Alex）')).toBe('王小明');
    });

    it('無括號時原樣保留，不誤刪內文', () => {
      expect(normalizeName('歐陽修')).toBe('歐陽修');
      expect(normalizeName('')).toBe('');
      expect(normalizeName(undefined)).toBe('');
    });
  });

  describe('parseTuition：週收費級距', () => {
    it('已知級距 [3] → 3 天', () => {
      const r = parseTuition('115國小輔導-三年級[團][3] - 40 堂課');
      expect(r.days).toBe(3);
      expect(r.tierStatus).toBe('parsed');
      expect(r.className).toBe('115國小輔導-三年級[團][3]');
      expect(r.sessions).toBe(40);
    });

    it('已知級距 [3_5] → 3.5 天（底線為小數點）', () => {
      const r = parseTuition('115國小輔導-六年級[團][3_5] - 40 堂課');
      expect(r.days).toBe(3.5);
      expect(r.tierStatus).toBe('parsed');
    });

    it('已知級距 [4] → 4 天', () => {
      expect(parseTuition('115國小輔導-五年級[團][4] - 40 堂課').days).toBe(4);
    });

    it('已知級距 [4_5] → 4.5 天', () => {
      expect(parseTuition('115國小輔導-一A[團][4_5] - 40 堂課').days).toBe(4.5);
    });

    it('已知級距 [5] → 5 天（specs/02 §3.2 明列 [5]；review F-NEW-2 指出此項曾遺漏）', () => {
      const r = parseTuition('115國小輔導-四年級A[團][5] - 40 堂課');
      expect(r.days).toBe(5);
      expect(r.tierStatus).toBe('parsed');
    });

    // tierStatus 沿用產品端 tierParseStatus 的用語（defaulted / parsed / unavailable），
    // 不可自創，否則等於又與產品脫鉤。
    it('無級距修飾 → 全週 5 天，tierStatus 為產品用語 defaulted', () => {
      const r = parseTuition('115國小輔導-四年級A[團] - 40 堂課');
      expect(r.days).toBe(5);
      expect(r.tierStatus).toBe('defaulted');
    });

    it('寫功課班 → 固定 5 天，且標記為 homework 而非級距', () => {
      const r = parseTuition('115國小輔導-寫功課[團][五年級] - 40 堂課');
      expect(r.isHomework).toBe(true);
      expect(r.days).toBe(5);
      expect(r.tierStatus).toBe('homework');
    });

    it('[團] 與 [四年級] 這類年級標記不被誤認為級距', () => {
      const r = parseTuition('115國小輔導-寫功課[團][四年級] - 40 堂課');
      expect(r.isHomework).toBe(true);
      const r2 = parseTuition('115國小輔導-四年級A[團] - 40 堂課');
      expect(r2.tierStatus).toBe('defaulted');
    });

    // review F2／F-NEW-2：未知修飾不可當無後綴回 5，否則等於替產品斷言它刻意不斷言的數值
    it('域外級距 [2] → days 為 null、tierStatus 為產品用語 unavailable', () => {
      const r = parseTuition('115國小輔導-四A[團][2] - 40 堂課');
      expect(r.days).toBeNull();
      expect(r.tierStatus).toBe('unavailable');
    });

    // review F-NEW-2b：非數字修飾同樣不可默默回 5
    it('非數字未知修飾 [Starter] → days 為 null，不可默默回全週 5 天', () => {
      const r = parseTuition('115國小輔導-一A[團][Starter] - 40 堂課');
      expect(r.days).toBeNull();
      expect(r.tierStatus).toBe('unavailable');
      expect(r.daysRaw).toContain('Starter');
    });

    it('未知數字修飾 [6] → unavailable', () => {
      const r = parseTuition('115國小輔導-四A[團][6] - 40 堂課');
      expect(r.days).toBeNull();
      expect(r.tierStatus).toBe('unavailable');
    });

    // 產品用 modifiers.find() 取第一個匹配級距；此處隨產品，不可自創「矛盾→不猜」規則
    it('多個級距修飾並存 → 隨產品取第一個匹配值', () => {
      const r = parseTuition('115國小輔導-一A[團][4_5][4] - 40 堂課');
      expect(r.days).toBe(4.5);
      expect(r.tierStatus).toBe('parsed');
    });

    it('無學費項 → days null、不誤判為 0', () => {
      const r = parseTuition(null);
      expect(r.days).toBeNull();
      expect(r.daysRaw).toBe('無學費項');
    });
  });

  describe('parseDiscounts：課程費折扣 → bps', () => {
    it('9折 → 9000 bps', () => {
      expect(parseDiscounts(['115國小輔導-三年級[團][3][9折] - 課程費9折']).rateBps).toBe(9000);
    });

    it('95折 → 9500 bps', () => {
      expect(parseDiscounts(['115國小輔導-四年級A[團][9.5折] - 課程費95折']).rateBps).toBe(9500);
    });

    it('85折 → 8500 bps', () => {
      expect(parseDiscounts(['[3_5][8.5折] - 課程費85折']).rateBps).toBe(8500);
    });

    it('7折 → 7000 bps', () => {
      expect(parseDiscounts(['[3_5][7折] - 課程費7折']).rateBps).toBe(7000);
    });

    it('無課程費折扣 → 10000 bps 且 status none', () => {
      const r = parseDiscounts(['[團][折扣] - 國小部_參加普測學費優惠']);
      expect(r.rateBps).toBe(10000);
      expect(r.rateParseStatus).toBe('none');
      expect(r.extraDiscounts).toHaveLength(1);
    });

    it('無折扣明細 → 10000 bps', () => {
      const r = parseDiscounts([]);
      expect(r.rateBps).toBe(10000);
      expect(r.rateParseStatus).toBe('none');
    });

    // review F3：認不出格式不可等同「確定無折扣」，否則新格式會靜默變成 MATCH
    it('未列入白名單的折扣格式 → rateParseStatus unknown，不可當無折扣', () => {
      const r = parseDiscounts(['[團][88折] - 課程費88折']);
      expect(r.rateParseStatus).toBe('unknown');
      expect(r.extraDiscounts).toHaveLength(1);
    });

    it('純獨立優惠項不誤標為 unknown', () => {
      const r = parseDiscounts(['[團][雜費] - 安課訂金']);
      expect(r.rateParseStatus).toBe('none');
    });

    // review F-NEW-4：順序不得影響判定，未知格式不可被後續 parsed 蓋掉
    it('未知格式在前、已解析在後 → 仍為 unknown（順序無關）', () => {
      const r = parseDiscounts(['[團][88折] - 課程費88折', '[團][9折] - 課程費9折']);
      expect(r.rateParseStatus).toBe('unknown');
    });

    it('已解析在前、未知格式在後 → 仍為 unknown（順序無關）', () => {
      const r = parseDiscounts(['[團][9折] - 課程費9折', '[團][88折] - 課程費88折']);
      expect(r.rateParseStatus).toBe('unknown');
    });
  });

  /**
   * 分類路由：缺陷真正發生的地方。
   *
   * 只測 parseTuition 抓不到 review F-NEW-1／F-NEW-3 —— 那些 bug 出在
   * 「parse 結果如何被路由成 statusCategory、以及 statusCategory 如何被 UI 消費」，
   * 所以這裡直接測 compare() 的輸出分類與 BADGES／NEEDS_HUMAN 的掛載完整性。
   *
   * 全部使用合成學生，不含任何真實個資。
   */
  describe('compare：分類路由與 UI 掛載', () => {
    const webStudent = (name: string, over: Record<string, unknown> = {}) => ({
      name,
      personCode: 'P-SYNTH-0001',
      grade: 2,
      gradeRaw: '小二',
      subjectCount: 1,
      baseDiscountBps: 9000,
      anqinDays: 5,
      anqinDisplay: '5',
      tutoringDays: null,
      tutoringDisplay: null,
      applicableAnqinBps: 10000,
      applicableTutoringBps: null,
      tierMismatch: false,
      tierComparisons: [],
      issues: [],
      trace: { rawTags: '', careDays: { anqin: { isEnrolled: true }, tutoring: { isEnrolled: false } } },
      enrollments: [{ rawToken: '115國小輔導-一A[團]', baseName: '國小輔導-一A', erpBillingTier: 5 }],
      ...over,
    });

    const reportStudent = (name: string, over: Record<string, unknown> = {}) => ({
      name,
      tuition: null,
      discounts: [],
      other: [],
      otherDiscounts: [],
      billNo: 'SYNTH-BILL',
      billDate: '2026-09-10',
      billStatus: '已繳',
      ...over,
    });

    const runOne = (report: Record<string, unknown>[], web: Record<string, unknown>[]) =>
      compare(new Map(report.map(r => [r.name as string, r])), web as never[], '2026-10-14').records[0];

    // review F-NEW-1：報表確有學費項但級距認不出來，不可標成「報表無學費項」
    it('級距無法解析 → TIER_UNPARSED，不可標成報表無學費項', () => {
      const r = runOne(
        [reportStudent('測試甲', { tuition: '115國小輔導-一A[團][Starter] - 40 堂課' })],
        [webStudent('測試甲 (Mia)')],
      );
      expect(r.statusCategory).toBe('TIER_UNPARSED');
      expect(r.statusLabel).not.toContain('無學費');
      expect(r.note.notes.join()).toMatch(/格式/);
    });

    // review F-NEW-4：數字雖一致但格式認不出來，不可宣稱完全一致
    it('折扣格式無法解析 → RATE_UNPARSED，不可標成完全一致', () => {
      const detail = '[團][88折] - 課程費88折';
      const r = runOne(
        [reportStudent('測試乙', { tuition: '115國小輔導-一A[團] - 40 堂課', discounts: [detail], otherDiscounts: [detail] })],
        [webStudent('測試乙', { applicableAnqinBps: 10000 })],
      );
      expect(r.statusCategory).toBe('RATE_UNPARSED');
    });

    // review F-NEW-3：同名多人時不可靜默配對到最後一人
    it('名單同名多人 → UNPAIRABLE，不可靜默配對', () => {
      const r = runOne([reportStudent('同名')], [webStudent('同名 (A)'), webStudent('同名 (B)')]);
      expect(r.statusCategory).toBe('UNPAIRABLE');
      expect(r.personCode).not.toBe('P-SYNTH-0001');
    });

    it('名單確無此人 → NOT_IN_WEB', () => {
      const r = runOne([reportStudent('查無此人')], [webStudent('其他人')]);
      expect(r.statusCategory).toBe('NOT_IN_WEB');
    });

    it('報表無學費項 → EXCEL_NO_TUITION', () => {
      const r = runOne([reportStudent('測試丙')], [webStudent('測試丙')]);
      expect(r.statusCategory).toBe('EXCEL_NO_TUITION');
    });

    it('天數與折扣皆一致 → MATCH', () => {
      const r = runOne(
        [reportStudent('測試丁', { tuition: '115國小輔導-一A[團] - 40 堂課' })],
        [webStudent('測試丁')],
      );
      expect(r.statusCategory).toBe('MATCH');
    });

    // review F-NEW-3：新增類別若沒接進 BADGES，第一次出現就會渲染 undefined
    it('BADGES 涵蓋所有分類，不得有 undefined', () => {
      const cats = ['MATCH', 'DAY_DIFF', 'DISCOUNT_DIFF', 'BOTH_DIFF', 'NOT_IN_WEB',
        'EXCEL_NO_TUITION', 'UNPAIRABLE', 'TIER_UNPARSED', 'RATE_UNPARSED'] as const;
      for (const cat of cats) {
        expect(BADGES[cat], `分類 ${cat} 缺少 badge`).toBeTruthy();
        expect(BADGES[cat]).not.toContain('undefined');
      }
    });

    it('需人工判讀的分類都在 NEEDS_HUMAN 內，UI 分頁才不會漏掉', () => {
      expect(NEEDS_HUMAN).toEqual(
        expect.arrayContaining(['NOT_IN_WEB', 'EXCEL_NO_TUITION', 'UNPAIRABLE', 'TIER_UNPARSED', 'RATE_UNPARSED']),
      );
    });

    /**
     * Note 形狀測試（PR A 的證明，非內容測試）。
     *
     * 過去 MATCH／NOT_IN_WEB／EXCEL_NO_TUITION 只回 {tone, notes}，其餘分支多五個欄位。
     * 消費者全靠 `?` 與 falsy 判讀才安全——這是抽取共用層時最易靜默劣化的地方：
     * `Note` 型別若為 union，所有消費者就得永遠寫 `?`。
     *
     * 這裡逐一走過**全部 9 個分類**，斷言 `Object.keys` 的集合完全相同。
     * 內容已由上方各案例的 note.notes 斷言涵蓋。
     */
    /**
     * 覆蓋範圍說明：形狀測試走過全部 9 個分類，但**值層級**測試只涵蓋旗標
     * 實際會被讀到的分支。
     *
     * `UNPAIRABLE` 與 `NOT_IN_WEB` 刻意沒有值層級測試：compare() 對未配對學生
     * 傳給 buildNotes 的 `web` 是裸字面量 `{ asOfDate }`，沒有 tierComparisons／
     * issues／rawTags，故其旗標在任何 finish() 預設值下都必然為空。實測把兩者
     * 改成 finishWithInsights 後本檔 41 項測試全數通過，證實任何斷言其旗標的
     * 測試都無法失敗（review #119 第二、三輪 Finding）。
     *
     * 測試名稱若承諾偵測不到的保證，會成為未來的假訊號，故寧可只留說明。
     * 對應推理保留在 `scripts/compare-billing-report.mjs` 的 buildNotes 內。
     */
    it('全部 9 個分類的 note 欄位集合一致（共用層的 Note 型別前提）', () => {
      const cases: Record<string, [Record<string, unknown>[], Record<string, unknown>[]]> = {
        MATCH: [
          [reportStudent('合成甲', { tuition: '115國小輔導-一A[團] - 40 堂課' })],
          [webStudent('合成甲')],
        ],
        DAY_DIFF: [
          [reportStudent('合成乙', { tuition: '115國小輔導-一A[團][4_5] - 40 堂課' })],
          [webStudent('合成乙', { anqinDays: 5, anqinDisplay: '5' })],
        ],
        // 報表 9 折 (9000) vs 系統無折扣 (10000) → 天數同、折扣不同
        DISCOUNT_DIFF: [
          [reportStudent('合成丙', { tuition: '115國小輔導-一A[團] - 40 堂課', discounts: ['x[9折] - 課程費9折'] })],
          [webStudent('合成丙', { applicableAnqinBps: 10000 })],
        ],
        // 報表 4.5 天 (4500→顯示) vs 系統 5 天，且折扣 9000 vs 10000
        BOTH_DIFF: [
          [reportStudent('合成丁', { tuition: '115國小輔導-一A[團][4_5] - 40 堂課', discounts: ['x[9折] - 課程費9折'] })],
          [webStudent('合成丁', { anqinDays: 5, anqinDisplay: '5', applicableAnqinBps: 10000 })],
        ],
        NOT_IN_WEB: [[reportStudent('合成戊')], [webStudent('合成己')]],
        EXCEL_NO_TUITION: [[reportStudent('合成庚')], [webStudent('合成庚')]],
        UNPAIRABLE: [[reportStudent('合成辛')], [webStudent('合成辛 (A)'), webStudent('合成辛 (B)')]],
        TIER_UNPARSED: [
          [reportStudent('合成壬', { tuition: '115國小輔導-一A[團][Starter] - 40 堂課' })],
          [webStudent('合成壬 (Mia)')],
        ],
        RATE_UNPARSED: [
          [reportStudent('合成癸', { tuition: '115國小輔導-一A[團] - 40 堂課', discounts: ['x[88折] - 課程費88折'], otherDiscounts: ['x[88折] - 課程費88折'] })],
          [webStudent('合成癸', { applicableAnqinBps: 10000 })],
        ],
      };

      const expectedKeys = ['dupIssues', 'homework', 'mismatches', 'notes', 'tags', 'tone', 'withdrawal'].sort();

      for (const [status, [report, web]] of Object.entries(cases)) {
        const rec = runOne(report, web);
        expect(rec.statusCategory, `案例 ${status} 未走到預期分類`).toBe(status);
        expect(Object.keys(rec.note).sort(), `分類 ${status} 的 note 欄位集合不一致`).toEqual(expectedKeys);
      }
    });

    /**
     * Note 值層級測試（review #119 Finding 1 的回歸防護）。
     *
     * 形狀測試只看 `Object.keys`，而既有 fixture 的 `tierComparisons`／`issues` 皆為空，
     * 因此「預設值是空陣列」與「預設值是該學生的真實資料」無法區分——形狀測試
     * 在錯誤實作下仍會通過。
     *
     * 實際曾發生的 bug：`finish()` 把 `dupIssues`／`mismatches` 設為**衍生資料**而非空值，
     * 導致 MATCH 的學生被拉進「天數差異的最可能來源」歸納群組。分類計數完全不變
     * （MATCH 仍是 MATCH），只有渲染結果改變。
     *
     * 本測試直接斷言：無論分類為何，只有「該分支原本就帶旗標」的情況才應有值。
     */
    it('MATCH 分支不得帶入 insight 旗標，即使名單學生確實有 mismatch/dupIssue', () => {
      const student = webStudent('合成丁', {
        tierComparisons: [{ status: 'mismatch', erpDeclaredTier: 5, computedTier: 4.5, rawToken: 'x' }],
        issues: [{ code: 'DUPLICATE_SUBJECT_ENROLLMENT', category: '國小輔導' }],
      });
      const rec = runOne(
        [reportStudent('合成丁', { tuition: '115國小輔導-一A[團] - 40 堂課' })],
        [student],
      );

      expect(rec.statusCategory).toBe('MATCH');
      // 這三行是本測試的核心：MATCH 不得因 finish() 的預設值而被餵進歸納群組
      expect(rec.note.mismatches, 'MATCH 學生的 mismatches 應為空（否則會誤入天數差異群組）').toEqual([]);
      expect(rec.note.dupIssues, 'MATCH 學生的 dupIssues 應為空（否則會誤入重複報名群組）').toEqual([]);
      expect(rec.note.homework).toBe(false);
      expect(rec.note.withdrawal).toBe(false);
    });

    /**
     * TIER_UNPARSED／UNPAIRABLE 的值層級覆蓋。
     *
     * 真實 9–10 月報表中 `tierUnparsed: 0`、`unpairable: 0`，故渲染層基準
     * **永遠走不到這兩個分支**（零樣本問題）。這裡以單元測試補足：兩者皆需
     * 與 main 一致地攜帶真實 insight 旗標。
     *
     * 背景：b4892f5 曾把 TIER_UNPARSED 誤降為空值——那正是這類分支在
     * 基準與渲染層都看不見的「修正過頭」（review #119 第二輪 Finding 1）。
     */
    it('TIER_UNPARSED 應攜帶真實 insight 旗標（main 版行為，不可被修正過頭）', () => {
      const rec = runOne(
        [reportStudent('合成壬', { tuition: '115國小輔導-一A[團][Starter] - 40 堂課' })],
        [webStudent('合成壬 (Mia)', {
          tierComparisons: [{ status: 'mismatch', erpDeclaredTier: 5, computedTier: 4.5, rawToken: 'w' }],
          issues: [{ code: 'DUPLICATE_SUBJECT_ENROLLMENT', category: '國小輔導' }],
        })],
      );
      expect(rec.statusCategory).toBe('TIER_UNPARSED');
      expect(rec.note.mismatches, 'TIER_UNPARSED 不得丟失 mismatches，否則該生會消失於天數差異群組').toHaveLength(1);
      expect(rec.note.dupIssues, 'TIER_UNPARSED 不得丟失 dupIssues').toHaveLength(1);
    });

    it('確實需要餵旗標的分支仍帶著真實資料（防止修正過頭）', () => {
      const rec = runOne(
        [reportStudent('合成乙', { tuition: '115國小輔導-一A[團][4_5] - 40 堂課' })],
        [webStudent('合成乙', {
          tierComparisons: [{ status: 'mismatch', erpDeclaredTier: 5, computedTier: 4.5, rawToken: 'z' }],
        })],
      );
      expect(rec.statusCategory).toBe('DAY_DIFF');
      expect(rec.note.mismatches, 'DAY_DIFF 分支應保留真實 mismatches，否則歸納群組會漏人').toHaveLength(1);
    });
  });
});
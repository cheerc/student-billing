import { describe, it, expect } from 'vitest';

import {
  parseSessionTuition,
  parseAmountColumns,
  findNonStandardDiscounts,
  routeRateField,
  compare,
  renderHtml,
  buildHumanReviewList,
  isNeedsHumanRecord,
  SESSION_CATEGORY_REGISTRY,
  INSIGHT_GROUPS,
  BADGES as SESSION_BADGES,
  NEEDS_HUMAN as SESSION_NEEDS_HUMAN,
  SESSION_RATE_CATEGORIES,
} from '../../scripts/compare-session-pricing-report.mjs';
import { readMultiTuitionReport } from '../../scripts/shared/report-xlsx';
import { buildRunSnapshotContext } from '../../scripts/shared/rate-context';

const LEGACY_V2_CONTEXT = buildRunSnapshotContext({ ruleSetVersion: 'erp-tag-v2' })!;

/**
 * 按堂計價帳務比對工具的解析與分類契約。
 *
 * ## 預期結果怎麼來的（CLAUDE.md §8 禁止反向產生測試 Expected）
 *
 * 本檔全部使用合成 fixture，預期值依下列依據**獨立手算**，不以工具輸出反推：
 *
 *  - 折價率 bps：沿用 `report-xlsx.ts` 的「課程費 NN折」白名單語意
 *    （95→9500、9→9000、85→8500、8→8000、7→7000、無→10000），
 *    此為報表**字串格式**規格，見 report-xlsx.ts 的 RATE_PATTERNS 說明。
 *  - 堂數：明細字尾 `- NN 堂課` 的字面數字，無換算規則。
 *  - 類別路由：`historicalRateCategoryOfClass` 的名稱子字串規則（國小輔導／國小數學／兒童美語），
 *    直接引用產品端函式本身測，確保工具沒有另寫一份對照表。
 *  - 學費金額欄位：報表欄 9 起為各班金額欄、表頭即班名；金額以該列數字
 *    與**同名表頭**配對。這是米豆奶報表的版面事實，已於 10-11 月報表實測：
 *    學費列 37 筆全部命中同名欄，其餘科目落在「非學費費用」欄。
 *
 * ## 刻意不做的驗證
 *
 * 真實 10-11 月報表中沒有「同一名學生同時有美語與數學兩筆學費」的情形
 * （實測 37 名學生／37 筆學費列，雙科者 0）。因此雙科展開改以**合成 fixture**
 * 驗證，不可對真實報表要求此行為出現。
 */
describe('按堂計價帳務比對工具：報表解析契約', () => {
  describe('parseSessionTuition：堂數與班名', () => {
    it('解析班名與堂數（不做任何換算）', () => {
      const r = parseSessionTuition('兒童美語-Dommie[團][W9] - 16 堂課');
      expect(r.className).toBe('兒童美語-Dommie[團][W9]');
      expect(r.sessions).toBe(16);
    });

    it('堂數 24 亦照字面解析（單價因班而異，不可假設固定）', () => {
      expect(parseSessionTuition('兒童美語-Gino[團][Starter] - 24 堂課').sessions).toBe(24);
    });

    it('班名含空格與全形數字時仍可解析', () => {
      const r = parseSessionTuition('兒童美語-老師甲[團][W1] - 20 堂課');
      expect(r.className).toBe('兒童美語-老師甲[團][W1]');
      expect(r.sessions).toBe(20);
    });

    it('無學費列 → sessions null、className null（不可當成 0 堂）', () => {
      const r = parseSessionTuition(null);
      expect(r.sessions).toBeNull();
      expect(r.className).toBeNull();
    });

    it('學費明細缺堂數 → sessions null，但班名仍可用於類別路由', () => {
      const r = parseSessionTuition('兒童美語-Dommie[團][W9]');
      expect(r.sessions).toBeNull();
      expect(r.className).toBe('兒童美語-Dommie[團][W9]');
    });

    it('分隔符用 " - "：明細前半為班名，後半不影響類別判定', () => {
      const r = parseSessionTuition('兒童美語-Dommie[團][W9] - 16 堂課 - 說明文字');
      expect(r.className).toBe('兒童美語-Dommie[團][W9]');
    });
  });

  /**
   * 金額欄位定位：**同名表頭優先**，這是本工具與國小輔導工具最大的版面差異。
   *
   * 真實報表的欄 9.. 不是「第一個數字欄」也不是「最後一欄」，而是
   * **每個班一欄**（欄 9/10/11 分別是三個兒童美語班，欄 12 是「非學費費用」）。
   * 實測 37 筆學費列的金額 100% 落在與該列班名**同名**的欄位；
   * 雜費／商品等科目則落在「非學費費用」欄。
   *
   * 因此規則是：先找表頭與班名相同者；找不到才接受「非學費費用」欄。
   * 若退化成「取第一個數字欄」，Dommie 的 7360 與 Gino 的 7200 就會互相污染。
   */
  describe('parseAmountColumns：金額欄位定位', () => {
    /** 欄位索引（1-based）→ 表頭。欄 1..8 為固定版面，其餘為班名／非學費費用。 */
    const headers = [
      '學生', '帳單編號', '建單日期', '明細', '排課起始日', '排課截止日', '會計科目', '狀態',
      '兒童美語-Dommie[團][W9]', '兒童美語-Archy[團][W7]', '兒童美語-Gino[團][Starter]', '非學費費用',
    ];
    const columnIndex = new Map(headers.map((h, i) => [h, i + 1]));

    const rowWithAmounts = (amounts: Record<string, number>) => ({
      getCell: (n: number) => ({
        text: undefined,
        value: n === 1 ? '合成甲' : (amounts[headers[n - 1]!] ?? undefined),
      }),
    });

    it('同名班名欄的金額（先於「非學費費用」欄）', () => {
      const r = parseAmountColumns(columnIndex, rowWithAmounts({
        '兒童美語-Dommie[團][W9]': 7360,
        '非學費費用': 1200,
      }), '兒童美語-Dommie[團][W9]');
      expect(r.tuitionAmount).toBe(7360);
      expect(r.amountColumnHeading).toBe('兒童美語-Dommie[團][W9]');
      expect(r.amountRoute).toBe('class-column');
    });

    it('同名欄不存在 → 退回「非學費費用」欄並記錄為非學費欄', () => {
      const r = parseAmountColumns(columnIndex, rowWithAmounts({ '非學費費用': 300 }), '不存在的班');
      expect(r.tuitionAmount).toBe(300);
      expect(r.amountColumnHeading).toBe('非學費費用');
      expect(r.amountRoute).toBe('non-tuition-column');
    });

    it('同名欄存在但該列無金額（undefined）→ 不可取其他欄的金額頂替', () => {
      const r = parseAmountColumns(columnIndex, rowWithAmounts({
        '兒童美語-Gino[團][Starter]': 300,
      }), '兒童美語-Dommie[團][W9]');
      // Dommie 欄此列無值：同名欄「存在」但無金額，必須回 null，不可撈 Gino 的 300
      expect(r.tuitionAmount).toBeNull();
      expect(r.amountRoute).toBe('class-column');
    });

    it('兩個班都有金額時，依班名只取自己的那一欄（不可混用）', () => {
      const r = parseAmountColumns(columnIndex, rowWithAmounts({
        '兒童美語-Dommie[團][W9]': 7360,
        '兒童美語-Gino[團][Starter]': 7200,
      }), '兒童美語-Gino[團][Starter]');
      expect(r.tuitionAmount).toBe(7200);
      expect(r.amountColumnHeading).toBe('兒童美語-Gino[團][Starter]');
    });

    it('文字金額不被當成數字金額（避免把說明欄讀成金額）', () => {
      const r = parseAmountColumns(columnIndex, {
        getCell: (n: number) => ({
          text: undefined,
          value: n === 1 ? '合成甲' : (n === 9 ? '7,360 元' : undefined),
        }),
      }, '兒童美語-Dommie[團][W9]');
      expect(r.tuitionAmount).toBeNull();
    });

    it('整列無金額 → tuitionAmount null、amountColumnHeading null', () => {
      const r = parseAmountColumns(columnIndex, rowWithAmounts({}), '兒童美語-Dommie[團][W9]');
      expect(r.tuitionAmount).toBeNull();
      expect(r.amountColumnHeading).toBe('兒童美語-Dommie[團][W9]');
      expect(r.amountRoute).toBe('class-column');
    });

    it('「非學費費用」欄缺漏時，退回同名列後仍為 null（不可隨意取任一數字欄）', () => {
      const noFeeCol = new Map([...columnIndex].filter(([h]) => h !== '非學費費用'));
      const r = parseAmountColumns(noFeeCol, rowWithAmounts({ '兒童美語-Dommie[團][W9]': 7360 }), '不存在的班');
      expect(r.tuitionAmount).toBeNull();
      expect(r.amountRoute).toBe('none');
    });
  });

  it('omitted Run context does not use the historical class-name mapper', () => {
    const result = compare(
      new Map([['合成生', {
        name: '合成生',
        tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
        discounts: ['兒童美語-Dommie[團][W9] - 課程費8折'],
        otherDiscounts: [], other: [], billNo: 'SYNTH-BILL', billDate: '2026-10-01', billStatus: '已繳',
      }]]),
      [{
        name: '合成生', personCode: 'SYNTH_001', grade: 4, applicableEnglishBps: 8000,
        applicableMathBps: 8500, enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie' }],
      }],
      '2026-10-01',
    ).records[0]!;

    expect(result.statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
    expect(result.web!.rateBps).toBeNull();
  });

  /**
   * 非標準折扣偵測。
   *
   * 真實報表有且只有一筆：某生除「課程費95折」外另有
   * 「本校_扣3/9-4/29 學費 15*40=600」（期中去補加收，**不含**「課程費」字樣）。
   *
   * 此訊號**獨立於 rateParseStatus**：該生的白名單命中「課程費95折」，
   * 故 `parseDiscounts` 的狀態仍是 'parsed'。若把偵測做成「status !== parsed」
   * 就抓不到這筆——而它恰恰是期中最容易被忽略、卻最需要人工確認的帳務事實。
   */
  describe('findNonStandardDiscounts：非標準折扣明細', () => {
    it('認出不含白名單、且帶金額算式的補加收明細', () => {
      const hits = findNonStandardDiscounts([
        '兒童美語-Dommie[團][W9][9.5折] - 課程費95折',
        '兒童美語-Dommie[團][W9][折扣] - 本校_扣3/9-4/29 學費 15*40=600',
      ]);
      expect(hits).toEqual(['兒童美語-Dommie[團][W9][折扣] - 本校_扣3/9-4/29 學費 15*40=600']);
    });

    it('僅有標準課程費折扣 → 無命中', () => {
      expect(findNonStandardDiscounts(['x[9折] - 課程費9折'])).toEqual([]);
      expect(findNonStandardDiscounts(['x[9.5折] - 課程費95折'])).toEqual([]);
    });

    it('普測優惠／訂金等無金額算式的項目不算非標準（那些是常態獨立優惠項）', () => {
      expect(findNonStandardDiscounts(['x[雜費] - 國小部_參加普測學費優惠'])).toEqual([]);
      expect(findNonStandardDiscounts(['x[折扣] - 安課訂金'])).toEqual([]);
    });

    it('明細順序不影響結果', () => {
      const a = ['x[折扣] - 補收 學費 15*40=600', 'x[9折] - 課程費9折'];
      const b = ['x[9折] - 課程費9折', 'x[折扣] - 補收 學費 15*40=600'];
      expect(findNonStandardDiscounts(a)).toEqual(findNonStandardDiscounts(b));
      expect(findNonStandardDiscounts(a)).toHaveLength(1);
    });

    it('undefined 明細不可被視為命中（比對以字面量進行）', () => {
      expect(findNonStandardDiscounts([undefined])).toEqual([]);
    });
  });

  /**
   * 類別 → 系統欄位路由。
   *
   * §9.0 明令「不得複寫產品的班名解析，複寫必然漂移」。因此本測試直接以產品端
   * `historicalRateCategoryOfClass` 為預期值：若工具端自寫一份對照表並與產品分歧，
   * 這裡就會失敗。
   */
  describe('routeRateField：班名 → 系統適用率欄位', () => {
    const student = {
      applicableEnglishBps: 9000,
      applicableMathBps: 8500,
      applicableAnqinBps: 7000,
      applicableTutoringBps: 9500,
      grade: 3,
    };

    it('兒童美語 → 英文適用率欄位', () => {
      const r = routeRateField('兒童美語-Dommie[團][W9]', student);
      expect(r.category).toBe('english');
      expect(r.field).toBe('applicableEnglishBps');
      expect(r.bps).toBe(9000);
    });

    it('國小數學 → 數學適用率欄位', () => {
      const r = routeRateField('115國小數學-三A[團]', student);
      expect(r.category).toBe('math');
      expect(r.field).toBe('applicableMathBps');
      expect(r.bps).toBe(8500);
    });

    it('國小輔導 → care（非本工具範圍，但路由必須明確回 care 而非猜）', () => {
      expect(routeRateField('115國小輔導-三年級[團][3]', student).category).toBe('care');
    });

    it('不屬美語／數學／輔導者 → category null（需人工歸類，不可靜默略過）', () => {
      const r = routeRateField('某補習班-甲[團]', student);
      expect(r.category).toBeNull();
      expect(r.field).toBeNull();
      expect(r.bps).toBeNull();
    });

    it('不可用 id.toLowerCase() 推導欄位名（會得到 appliableenglishbps）', () => {
      for (const r of [routeRateField('兒童美語-A[團]', student), routeRateField('國小數學-A[團]', student)]) {
        expect(r.field).toBeDefined();
        // 唯一有效的覆蓋是下面兩條：它們會在欄位名被拼錯時轉紅。
        // （此處原本另有一行 `if (r.field) expect(r.field).toBe(r.field.toLowerCase() ? r.field : r.field)`，
        // 三元兩分支皆回傳 r.field，斷言恆真、永遠不會失敗——review M-1 已移除。）
        if (r.category === 'english') expect(r.field).toBe('applicableEnglishBps');
        if (r.category === 'math') expect(r.field).toBe('applicableMathBps');
      }
    });

    it('對同一組班名路由出正確類別', () => {
      expect(routeRateField('兒童美語-Dommie[團][W9]', student).category).toBe('english');
      expect(routeRateField('115國小數學-三A[團]', student).category).toBe('math');
      expect(routeRateField('115國小輔導-三年級[團][3]', student).category).toBe('care');
      expect(routeRateField('未知班級[團]', student).category).toBeNull();
    });

    it('缺該生對應欄位值 → bps null（已配置但此生無適用值，不可當 100%）', () => {
      const r = routeRateField('兒童美語-A[團]', { applicableEnglishBps: null, grade: 3 });
      expect(r.category).toBe('english');
      expect(r.bps).toBeNull();
    });
  });

  /** 名單學生：只帶本工具實際讀到的欄位。 */
  const webStudent = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    personCode: 'P-SYNTH-0001',
    grade: 3,
    gradeRaw: '小三',
    baseDiscountBps: 9000,
    subjectCount: 1,
    applicableAnqinBps: null,
    applicableTutoringBps: null,
    applicableEnglishBps: 10000,
    applicableMathBps: null,
    tierComparisons: [],
    issues: [],
    trace: { rawTags: '' },
    enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null }],
    ...over,
  });

  /** 報表學生：以 tuitionRows 陣列表達，可同時有美語與數學兩筆學費。 */
  const reportStudent = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    tuitionRows: [],
    discounts: [],
    otherDiscounts: [],
    other: [],
    billNo: 'SYNTH-BILL',
    billDate: '2026-10-01',
    billStatus: '已繳',
    ...over,
  });

  /** 金額查表省略 → 學費金額皆為 null（比對邏輯不應因此改變分類）。 */
  const runCompare = (report: Record<string, unknown>[], web: Record<string, unknown>[]) =>
    compare(new Map(report.map(r => [r.name as string, r])) as never, web as never[], '2026-10-14', undefined, LEGACY_V2_CONTEXT).records;

  describe('compare：分類路由', () => {
    /**
     * 折扣列一律沿用真實報表的班名寫法：班名尾端掛著方括號標記。
     * 這是報表既有格式，不是 fixture 的發明；工具據此把折扣分派給對應的班。
     */
    const ENGLISH_DISCOUNT_9 = '兒童美語-Dommie[團][W9][9折] - 課程費9折';
    const ENGLISH_DISCOUNT_95 = '兒童美語-Dommie[團][W9][9.5折] - 課程費95折';
    const MATH_DISCOUNT_85 = '115國小數學-三A[團][8.5折] - 課程費85折';

    it('折扣一致 → MATCH', () => {
      const [r] = runCompare(
        [reportStudent('合成甲', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
          discounts: [ENGLISH_DISCOUNT_9],
        })],
        [webStudent('合成甲', { applicableEnglishBps: 9000 })],
      );
      expect(r.statusCategory).toBe('MATCH');
    });

    it('報表 9 折 vs 系統無折扣 → DISCOUNT_DIFF', () => {
      const [r] = runCompare(
        [reportStudent('合成乙', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
          discounts: [ENGLISH_DISCOUNT_9],
        })],
        [webStudent('合成乙', { applicableEnglishBps: 10000 })],
      );
      expect(r.statusCategory).toBe('DISCOUNT_DIFF');
    });

    it('國小數學班 → 比對數學適用率，而非英文', () => {
      const [r] = runCompare(
        [reportStudent('合成丙', {
          tuitionRows: ['115國小數學-三A[團] - 20 堂課'],
          discounts: [MATH_DISCOUNT_85],
        })],
        [webStudent('合成丙', { applicableEnglishBps: 7000, applicableMathBps: 8500 })],
      );
      expect(r.statusCategory).toBe('MATCH');
      expect(r.web.rateBps).toBe(8500);
      expect(r.web.rateField).toBe('applicableMathBps');
    });

    it('報表折扣格式認不出來 → RATE_UNPARSED（即使數字巧合相同也不得宣稱一致）', () => {
      const [r] = runCompare(
        [reportStudent('合成丁', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
          discounts: ['兒童美語-Dommie[團][W9][88折] - 課程費88折'],
        })],
        [webStudent('合成丁', { applicableEnglishBps: 10000 })],
      );
      expect(r.statusCategory).toBe('RATE_UNPARSED');
    });

    it('名單查無此人 → NOT_IN_WEB', () => {
      const [r] = runCompare(
        [reportStudent('查無此人', { tuitionRows: ['兒童美語-A[團] - 16 堂課'] })],
        [webStudent('其他人')],
      );
      expect(r.statusCategory).toBe('NOT_IN_WEB');
    });

    it('名單同名多人 → UNPAIRABLE（不可靜默配對到最後一人）', () => {
      const [r] = runCompare(
        [reportStudent('同名', { tuitionRows: ['兒童美語-A[團] - 16 堂課'] })],
        [webStudent('同名 (A)'), webStudent('同名 (B)')],
      );
      expect(r.statusCategory).toBe('UNPAIRABLE');
      expect(r.personCode).not.toBe('P-SYNTH-0001');
    });

    it('報表有學費列但無折扣明細、系統也無折扣 → MATCH', () => {
      const [r] = runCompare(
        [reportStudent('合成戊', { tuitionRows: ['兒童美語-A[團] - 16 堂課'] })],
        [webStudent('合成戊', { applicableEnglishBps: 10000 })],
      );
      expect(r.statusCategory).toBe('MATCH');
    });

    it('報表有學費列但無折扣明細、系統有折扣 → DISCOUNT_DIFF', () => {
      const [r] = runCompare(
        [reportStudent('合成己', { tuitionRows: ['兒童美語-A[團] - 16 堂課'] })],
        [webStudent('合成己', { applicableEnglishBps: 9000 })],
      );
      expect(r.statusCategory).toBe('DISCOUNT_DIFF');
    });

    it('班級不屬美語／數學 → UNKNOWN_CLASS（需人工歸類，不可靜默略過）', () => {
      const [r] = runCompare(
        [reportStudent('合成庚', { tuitionRows: ['某補習班-甲[團] - 16 堂課'] })],
        [webStudent('合成庚')],
      );
      expect(r.statusCategory).toBe('UNKNOWN_CLASS');
    });

    it('系統端該生無適用率（bps null）→ WEB_RATE_NOT_CONFIGURED', () => {
      const [r] = runCompare(
        [reportStudent('合成辛', {
          tuitionRows: ['兒童美語-A[團] - 16 堂課'],
          discounts: ['x[9折] - 課程費9折'],
        })],
        [webStudent('合成辛', { applicableEnglishBps: null })],
      );
      expect(r.statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
    });

    it('報表無學費列（僅雜費等）→ EXCEL_NO_TUITION', () => {
      const [r] = runCompare(
        [reportStudent('合成壬', { tuitionRows: [] })],
        [webStudent('合成壬')],
      );
      expect(r.statusCategory).toBe('EXCEL_NO_TUITION');
    });

    /**
     * 非標準折扣優先於折扣差異：該生可能「數字一致但附帶補加收」。
     * 把它歸進 NON_STANDARD_DISCOUNT 才能讓人工看到那筆補收，
     * 若歸進 DISCOUNT_DIFF 則補收明細被平均掉、看不出成因。
     */
    it('標準折扣一致但附帶補加收 → NON_STANDARD_DISCOUNT（非 MATCH）', () => {
      const makeUp = '兒童美語-Dommie[團][W9][折扣] - 本校_扣3/9-4/29 學費 15*40=600';
      const [r] = runCompare(
        [reportStudent('合成癸', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
          discounts: [ENGLISH_DISCOUNT_95, makeUp],
          otherDiscounts: [makeUp],
        })],
        [webStudent('合成癸', { applicableEnglishBps: 9500 })],
      );
      expect(r.statusCategory).toBe('NON_STANDARD_DISCOUNT');
      // 補加收**不得**被摺進折價率：報表仍讀為 9500
      expect(r.excel.rateBps).toBe(9500);
      expect(r.note.notes.join()).toContain('600');
    });

    it('非標準折扣與 rateParseStatus 無關：status 為 parsed 仍須標記', () => {
      const makeUp = '兒童美語-Dommie[團][W9][折扣] - 補收 學費 15*40=600';
      const [r] = runCompare(
        [reportStudent('合成子', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
          discounts: [ENGLISH_DISCOUNT_9, makeUp],
          otherDiscounts: [makeUp],
        })],
        [webStudent('合成子', { applicableEnglishBps: 9000 })],
      );
      expect(r.excel.rateParseStatus).toBe('parsed');
      expect(r.statusCategory).toBe('NON_STANDARD_DISCOUNT');
    });

    /**
     * Issue #234：非標準分支的「一致／不一致」必須由兩邊折價率實際比較產生。
     *
     * 預期值手算（Coordinator Ruling）：
     *  - 報表折價率 ≠ 網頁折價率（且兩邊都可判定）→ 歸 DISCOUNT_DIFF（硬性差異優先，
     *    計入折扣差異與差異筆數），說明**同時**列出非標準明細，不得丟失；仍計入需人工判讀。
     *  - 兩邊相等 → 維持 NON_STANDARD_DISCOUNT，說明寫「一致」。
     *  - 任一邊無法判定 → 維持 NON_STANDARD_DISCOUNT（需人工）；說明不得寫「一致」。
     * bps → 標籤：9500 → `9.5折 (95%)`、9000 → `9折 (90%)`（bpsToLabel）。
     */
    describe('非標準折扣的折價率比較（Issue #234）', () => {
      const MAKE_UP = '兒童美語-Dommie[團][W9][折扣] - 補收 學費 15*40=600';
      const TUITION = '兒童美語-Dommie[團][W9] - 16 堂課';
      const META = {
        runId: 'run-synth', asOfDate: '2026-10-14', xlsxPath: '/synthetic/report.xlsx',
        ruleSetVersion: 'erp-tag-v2', numericPolicy: 'synthetic', rateSource: 'synthetic',
        billAnchorDate: '2026-10-01', duplicateNames: [] as string[], amountColumns: '（合成）',
      };
      const stat = (html: string, label: string) =>
        html.match(new RegExp(`<span class="stat-label">${label}</span>\\s*<span class="stat-value[^"]*">(\\d+)</span>`))?.[1];

      it('報表 9.5 折 vs 網頁 9 折且有補加收 → DISCOUNT_DIFF，說明不含「一致」、同時列出補加收明細', () => {
        const [r] = runCompare(
          [reportStudent('合成乙一', {
            tuitionRows: [TUITION],
            discounts: [ENGLISH_DISCOUNT_95, MAKE_UP],
            otherDiscounts: [MAKE_UP],
          })],
          [webStudent('合成乙一', { applicableEnglishBps: 9000 })],
        );
        expect(r.statusCategory).toBe('DISCOUNT_DIFF');
        const text = r.note.notes.join('\n');
        expect(text).not.toContain('一致');
        expect(text).toContain('9.5折 (95%)');
        expect(text).toContain('9折 (90%)');
        // 非標準明細不得因改歸折扣差異而消失
        expect(text).toContain(MAKE_UP);
      });

      it('折價率不同的非標準列：計入折扣差異、差異筆數與需人工判讀，不計入非標準卡', () => {
        const { records } = compare(
          new Map([reportStudent('合成乙二', {
            tuitionRows: [TUITION],
            discounts: [ENGLISH_DISCOUNT_95, MAKE_UP],
            otherDiscounts: [MAKE_UP],
          })].map((r) => [r.name as string, r])) as never,
          [webStudent('合成乙二', { applicableEnglishBps: 9000 })] as never[],
          '2026-10-14', undefined, LEGACY_V2_CONTEXT,
        );
        const [r] = records;
        expect(isNeedsHumanRecord(r)).toBe(true);
        expect(buildHumanReviewList(records)).toContain('合成乙二');
        const html = renderHtml(records, META);
        expect(stat(html, '折扣差異')).toBe('1');
        expect(stat(html, '差異筆數')).toBe('1');
        expect(stat(html, '非標準折扣')).toBe('0');
        expect(stat(html, '需人工判讀')).toBe('1');
        // 「需人工判讀」分頁以 data-human 篩列：必須帶標記，否則該列在分頁中消失
        expect(html).toContain('data-human="1"');
        // 補加收仍列在歸納的「非標準折扣明細」群組，而非「堂數或單價異常」
        const group = html.slice(html.indexOf('非標準折扣明細（需人工確認'), html.indexOf('堂數或單價異常（需人工確認'));
        expect(group).toContain('合成乙二');
      });

      it('需人工判讀卡副標各項加總 = 卡片數值（含「非標準（分類在他處）」）', () => {
        const { records } = compare(
          new Map([reportStudent('合成乙三', {
            tuitionRows: [TUITION],
            discounts: [ENGLISH_DISCOUNT_95, MAKE_UP],
            otherDiscounts: [MAKE_UP],
          })].map((r) => [r.name as string, r])) as never,
          [webStudent('合成乙三', { applicableEnglishBps: 9000 })] as never[],
          '2026-10-14', undefined, LEGACY_V2_CONTEXT,
        );
        const html = renderHtml(records, META);
        const m = html.match(/<span class="stat-label">需人工判讀<\/span>\s*<span class="stat-value[^"]*">(\d+)<\/span>\s*<span class="stat-sub">([^<]*)<\/span>/);
        expect(Number(m![1])).toBe(1);
        const sum = (m![2]!.match(/\d+/g) ?? []).reduce((a, n) => a + Number(n), 0);
        expect(sum).toBe(1);
      });

      it('報表只有補加收、無課程費折扣（讀為無折扣）vs 網頁 9 折 → DISCOUNT_DIFF，保留補加收明細', () => {
        const [r] = runCompare(
          [reportStudent('合成乙四', {
            tuitionRows: [TUITION],
            discounts: [MAKE_UP],
            otherDiscounts: [MAKE_UP],
          })],
          [webStudent('合成乙四', { applicableEnglishBps: 9000 })],
        );
        expect(r.statusCategory).toBe('DISCOUNT_DIFF');
        expect(r.note.notes.join('\n')).toContain(MAKE_UP);
        expect(r.note.notes.join('\n')).not.toContain('一致');
      });

      it('折價率相同且有補加收 → 維持 NON_STANDARD_DISCOUNT，說明寫「與網頁 9折 (90%) 一致」', () => {
        const [r] = runCompare(
          [reportStudent('合成乙五', {
            tuitionRows: [TUITION],
            discounts: [ENGLISH_DISCOUNT_9, MAKE_UP],
            otherDiscounts: [MAKE_UP],
          })],
          [webStudent('合成乙五', { applicableEnglishBps: 9000 })],
        );
        expect(r.statusCategory).toBe('NON_STANDARD_DISCOUNT');
        expect(r.note.notes.join('\n')).toContain('報表折價率仍讀為 9折 (90%)，與網頁 9折 (90%) 一致');
      });

      it('報表折扣格式無法解析且有補加收（數字巧合相同）→ 維持 NON_STANDARD_DISCOUNT，說明不得寫「一致」', () => {
        const [r] = runCompare(
          [reportStudent('合成乙六', {
            tuitionRows: [TUITION],
            discounts: ['兒童美語-Dommie[團][W9][88折] - 課程費88折', MAKE_UP],
            otherDiscounts: ['兒童美語-Dommie[團][W9][88折] - 課程費88折', MAKE_UP],
          })],
          [webStudent('合成乙六', { applicableEnglishBps: 10000 })],
        );
        expect(r.excel.rateParseStatus).toBe('unknown');
        expect(r.statusCategory).toBe('NON_STANDARD_DISCOUNT');
        const text = r.note.notes.join('\n');
        expect(text).not.toContain('一致');
        expect(text).toContain('無法確定');
        expect(isNeedsHumanRecord(r)).toBe(true);
      });

      it('報表折扣格式無法解析且有補加收、數字也不同 → 仍維持 NON_STANDARD_DISCOUNT（未知不宣稱一致或不一致）', () => {
        const [r] = runCompare(
          [reportStudent('合成乙七', {
            tuitionRows: [TUITION],
            discounts: ['兒童美語-Dommie[團][W9][88折] - 課程費88折', MAKE_UP],
            otherDiscounts: ['兒童美語-Dommie[團][W9][88折] - 課程費88折', MAKE_UP],
          })],
          [webStudent('合成乙七', { applicableEnglishBps: 9000 })],
        );
        expect(r.statusCategory).toBe('NON_STANDARD_DISCOUNT');
        expect(r.note.notes.join('\n')).not.toContain('一致');
      });
    });

    /**
     * Issue #237：「其他折扣」（非課程費、無金額算式的折扣明細，例如扣車資）會顯示在 HTML 標籤，
     * 說明文字必須與折扣差異分支同一措辭列出，不可只有標籤、說明裡卻不提。
     * 預期句型依 Issue #237 與折扣差異分支既有措辭手寫：`報表另有非課程費折扣項：<明細>。`
     */
    describe('其他折扣（extraDiscounts）在說明中列出（Issue #237）', () => {
      const BUS_FEE = '兒童美語-Dommie[團][W9][折扣] - 扣車資';
      const NOTE_BUS_FEE = `報表另有非課程費折扣項：${BUS_FEE}。`;

      it('MATCH：報表有其他折扣明細 → 說明列出該項', () => {
        const [r] = runCompare(
          [reportStudent('合成丑', {
            tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
            discounts: [ENGLISH_DISCOUNT_9, BUS_FEE],
            otherDiscounts: [BUS_FEE],
          })],
          [webStudent('合成丑', { applicableEnglishBps: 9000 })],
        );
        expect(r.statusCategory).toBe('MATCH');
        expect(r.note.notes).toContain(NOTE_BUS_FEE);
      });

      it('NON_STANDARD_DISCOUNT：除補加收外另有其他折扣明細 → 說明另列該項（補加收不重複列在此句）', () => {
        const makeUp = '兒童美語-Dommie[團][W9][折扣] - 補收 學費 15*40=600';
        const [r] = runCompare(
          [reportStudent('合成寅', {
            tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
            discounts: [ENGLISH_DISCOUNT_9, makeUp, BUS_FEE],
            otherDiscounts: [makeUp, BUS_FEE],
          })],
          [webStudent('合成寅', { applicableEnglishBps: 9000 })],
        );
        expect(r.statusCategory).toBe('NON_STANDARD_DISCOUNT');
        expect(r.note.notes).toContain(NOTE_BUS_FEE);
        // 補加收已由「非標準明細」句列出，不得再混進其他折扣句
        expect(r.note.notes.filter((n: string) => n.includes('報表另有非課程費折扣項')).join()).not.toContain('15*40=600');
      });

      it('NOT_IN_WEB：名單已無此人但報表有其他折扣明細 → 說明列出該項（PR #240 review）', () => {
        const [r] = runCompare(
          [reportStudent('合成辰', {
            tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
            discounts: [ENGLISH_DISCOUNT_9, BUS_FEE],
            otherDiscounts: [BUS_FEE],
          })],
          [webStudent('其他人')],
        );
        expect(r.statusCategory).toBe('NOT_IN_WEB');
        expect(r.note.notes).toContain(NOTE_BUS_FEE);
      });

      it('EXCEL_NO_TUITION：無學費列但有其他折扣明細 → 說明列出該項（PR #240 review）', () => {
        const [r] = runCompare(
          [reportStudent('合成巳', {
            tuitionRows: [],
            discounts: [BUS_FEE],
            otherDiscounts: [BUS_FEE],
          })],
          [webStudent('合成巳')],
        );
        expect(r.statusCategory).toBe('EXCEL_NO_TUITION');
        expect(r.note.notes).toContain(NOTE_BUS_FEE);
      });

      it('MATCH 且無其他折扣 → 不出現其他折扣句', () => {
        const [r] = runCompare(
          [reportStudent('合成卯', {
            tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
            discounts: [ENGLISH_DISCOUNT_9],
          })],
          [webStudent('合成卯', { applicableEnglishBps: 9000 })],
        );
        expect(r.statusCategory).toBe('MATCH');
        expect(r.note.notes.join('')).not.toContain('非課程費折扣項');
      });
    });

    /**
     * 雙科展開：同一名學生同時有美語與數學學費列 → 兩筆紀錄，各自路由到自己的系統欄位。
     *
     * 真實 10-11 月報表無此情形，故只能以合成 fixture 驗證。
     *
     * fixture 的折扣列刻意沿用**真實報表的寫法**——班名尾端掛著折價率標記
     * （`…[W9][9折]`），這是報表既有格式，不是本工具自創的。
     */
    it('雙科（美語＋數學）→ 展開為兩筆紀錄，各自路由到自己的系統欄位', () => {
      const records = runCompare(
        [reportStudent('合成雙', {
          tuitionRows: [
            '兒童美語-Dommie[團][W9] - 16 堂課',
            '115國小數學-三A[團] - 20 堂課',
          ],
          discounts: [
            '兒童美語-Dommie[團][W9][9折] - 課程費9折',
            '115國小數學-三A[團][8.5折] - 課程費85折',
          ],
          otherDiscounts: [],
        })],
        [webStudent('合成雙', { applicableEnglishBps: 9000, applicableMathBps: 8500 })],
      );
      expect(records).toHaveLength(2);
      const byField = Object.fromEntries(records.map(r => [r.web?.rateField, r]));
      expect(Object.keys(byField).sort()).toEqual(['applicableEnglishBps', 'applicableMathBps']);
      expect(byField.applicableEnglishBps!.excel.className).toBe('兒童美語-Dommie[團][W9]');
      expect(byField.applicableMathBps!.excel.className).toBe('115國小數學-三A[團]');
      expect(byField.applicableEnglishBps!.excel.rateBps).toBe(9000);
      expect(byField.applicableMathBps!.excel.rateBps).toBe(8500);
      expect(records.every(r => r.statusCategory === 'MATCH')).toBe(true);
    });

    /**
     * 折扣必須依**本筆學費的班**分派。
     *
     * 若不分派（拿整名學生的所有折扣一起比），數學班的 8.5 折會被算到美語班上，
     * 美語那筆就變成 9 折 vs 8.5 折的「差異」——報表與系統其實兩邊都對，
     * 錯的只有歸納。這種錯誤不會讓任何總數變得不合理，只會讓人查錯方向。
     */
    it('雙科時折扣依班分派，不可把另一門課的折扣算到這門課上', () => {
      const records = runCompare(
        [reportStudent('合成雙', {
          tuitionRows: [
            '兒童美語-Dommie[團][W9] - 16 堂課',
            '115國小數學-三A[團] - 20 堂課',
          ],
          discounts: [
            '兒童美語-Dommie[團][W9][9折] - 課程費9折',
            '115國小數學-三A[團][8.5折] - 課程費85折',
          ],
        })],
        [webStudent('合成雙', { applicableEnglishBps: 9000, applicableMathBps: 9000 })],
      );
      // 系統兩科都是 9 折：數學報表是 8.5 折 → 只有數學那筆該是差異
      const english = records.find(r => r.web?.rateField === 'applicableEnglishBps')!;
      const math = records.find(r => r.web?.rateField === 'applicableMathBps')!;
      expect(english.statusCategory).toBe('MATCH');
      expect(math.statusCategory).toBe('DISCOUNT_DIFF');
      expect(math.excel.rateBps).toBe(8500);
    });

    it('單一學費列 → 只產生一筆紀錄（不可無故展開）', () => {
      const records = runCompare(
        [reportStudent('合成單', { tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'] })],
        [webStudent('合成單')],
      );
      expect(records).toHaveLength(1);
    });

    it('無學費列的學生 → 一筆 EXCEL_NO_TUITION 紀錄，不產生兩筆', () => {
      const records = runCompare(
        [reportStudent('合成無', { tuitionRows: [] })],
        [webStudent('合成無')],
      );
      expect(records).toHaveLength(1);
      expect(records[0]!.statusCategory).toBe('EXCEL_NO_TUITION');
    });
  });

  describe('compare：反向在席查核 (ROSTER_NOT_BILLED)', () => {
    it('U05: 在席生所屬班級於報表有開單，但報表無學費列 → 產出 ROSTER_NOT_BILLED (needsHuman)', () => {
      const report = [
        reportStudent('開單生', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
        }),
      ];
      const roster = [
        webStudent('開單生', {
          enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null }],
        }),
        webStudent('未開單在席生', {
          personCode: 'P-SYNTH-0002',
          enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null }],
        }),
      ];
      const records = runCompare(report, roster);
      const notBilled = records.find(r => r.name === '未開單在席生');
      expect(notBilled).toBeDefined();
      expect(notBilled?.statusCategory).toBe('ROSTER_NOT_BILLED');
      expect(notBilled?.statusLabel).toBe('在席未開單需確認');
      expect(notBilled?.note.notes.join('')).toContain('名單在席');
      expect(notBilled?.note.tags).toContain('在席未開單');
    });

    it('U06: 已離班學生（withdrawalDate 非空）未在報表開單 → 不得產出 ROSTER_NOT_BILLED', () => {
      const report = [
        reportStudent('開單生', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
        }),
      ];
      const roster = [
        webStudent('開單生', {
          enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null }],
        }),
        webStudent('離班退費生', {
          personCode: 'P-SYNTH-0003',
          enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: '2026-10-15' }],
        }),
      ];
      const records = runCompare(report, roster);
      const notBilled = records.find(r => r.name === '離班退費生');
      expect(notBilled).toBeUndefined();
    });

    it('U07: 在席生報名其他班級（如國小數學），但報表未開該班學費列 → 不得跨科目產生 ROSTER_NOT_BILLED', () => {
      const report = [
        reportStudent('開單生', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
        }),
      ];
      const roster = [
        webStudent('開單生', {
          enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null }],
        }),
        webStudent('數學在席生', {
          personCode: 'P-SYNTH-0004',
          enrollments: [{ rawToken: '115國小數學-三A[團]', baseName: '115國小數學-三A', withdrawalDate: null }],
        }),
      ];
      const records = runCompare(report, roster);
      const notBilled = records.find(r => r.name === '數學在席生');
      expect(notBilled).toBeUndefined();
    });
  });

  /**
   * Issue #251 項目 1：反向在席查核的範圍只含「按堂計價」可能涉及的班。
   *
   * 預期值手算（合成 fixture）：
   *  - 報表開兩班：兒童美語（english）與國小輔導（care，月費、非本工具範圍）。
   *  - 名單另有各班在席未開單者各 1 人。
   *  - 快照（v4）判 care／none 的班不屬按堂計價 → 其在席未開單者不得被標 ROSTER_NOT_BILLED；
   *    english 照常；類別無法判定（unset、快照缺該班）不得靜默，維持反查（D17、§9.3）。
   */
  describe('compare：反向在席查核範圍依快照類別 (Issue #251)', () => {
    const ENGLISH = '兒童美語-Dommie[團][W9]';
    const ENGLISH_BASE = '兒童美語-Dommie';
    const CARE = '115國小輔導-三年級[團][3]';
    // 快照 base_name 為去修飾（含年度前綴 115）後的名冊班名，與工具 baseClassName 的輸出一致。
    const CARE_BASE = '國小輔導-三年級';
    const enroll = (rawToken: string, baseName: string) => [{ rawToken, baseName, withdrawalDate: null }];

    const runMixed = (
      classCategories: { base_name: string; category: string }[],
      extraBilledRaw = CARE,
      extraBilledBase = CARE_BASE,
    ) => {
      const context = buildRunSnapshotContext({
        ruleSetVersion: 'erp-tag-v4',
        classCategories: classCategories.map((c) => ({ ...c, fixed_five_days: 0, class_type: null })),
      })!;
      const report = [
        reportStudent('美語開單生', { tuitionRows: [`${ENGLISH} - 16 堂課`] }),
        reportStudent('另科開單生', { tuitionRows: [`${extraBilledRaw} - 16 堂課`] }),
      ];
      const roster = [
        webStudent('美語開單生', { enrollments: enroll(ENGLISH, ENGLISH_BASE) }),
        webStudent('另科開單生', { enrollments: enroll(extraBilledRaw, extraBilledBase) }),
        webStudent('美語未開單生', { enrollments: enroll(ENGLISH, ENGLISH_BASE) }),
        webStudent('另科未開單生', { enrollments: enroll(extraBilledRaw, extraBilledBase) }),
      ];
      return compare(
        new Map(report.map((r) => [r.name as string, r])) as never,
        roster as never[],
        '2026-10-14',
        undefined,
        context as never,
      ).records;
    };

    const notBilledNames = (records: { name: string; statusCategory: string }[]) =>
      records.filter((r) => r.statusCategory === 'ROSTER_NOT_BILLED').map((r) => r.name);

    it('快照判 care 的班在報表開單 → 該班在席未開單者不標 ROSTER_NOT_BILLED，english 班照常', () => {
      const records = runMixed([
        { base_name: ENGLISH_BASE, category: 'english' },
        { base_name: CARE_BASE, category: 'care' },
      ]);
      expect(notBilledNames(records)).toEqual(['美語未開單生']);
    });

    it('快照判 none 的班在報表開單 → 同樣不納入反查', () => {
      const records = runMixed([
        { base_name: ENGLISH_BASE, category: 'english' },
        { base_name: CARE_BASE, category: 'none' },
      ]);
      expect(notBilledNames(records)).toEqual(['美語未開單生']);
    });

    it('類別 unset 的班在報表開單 → 不靜默，仍反查', () => {
      const records = runMixed([
        { base_name: ENGLISH_BASE, category: 'english' },
        { base_name: CARE_BASE, category: 'unset' },
      ]);
      expect(notBilledNames(records).sort()).toEqual(['另科未開單生', '美語未開單生'].sort());
    });

    it('快照缺該班 → 不靜默，仍反查', () => {
      const records = runMixed([{ base_name: ENGLISH_BASE, category: 'english' }]);
      expect(notBilledNames(records).sort()).toEqual(['另科未開單生', '美語未開單生'].sort());
    });

    it('英文＋數學同報表 → 兩科皆在反查範圍', () => {
      const MATH = '115國小數學-三A[團]';
      const MATH_BASE = '國小數學-三A';
      const records = runMixed(
        [
          { base_name: ENGLISH_BASE, category: 'english' },
          { base_name: MATH_BASE, category: 'math' },
        ],
        MATH,
        MATH_BASE,
      );
      expect(notBilledNames(records).sort()).toEqual(['另科未開單生', '美語未開單生'].sort());
    });

    it('學雜費常模不受類別限縮：care 班同班多數收書籍費，未收者仍標書籍費偏離常模', () => {
      const context = buildRunSnapshotContext({
        ruleSetVersion: 'erp-tag-v4',
        classCategories: [{ base_name: CARE_BASE, category: 'care', fixed_five_days: 0, class_type: null }],
      })!;
      const names = ['生1', '生2', '生3', '生4', '未收生'];
      const report = names.map((n) => reportStudent(n, { tuitionRows: [`${CARE} - 16 堂課`] }));
      const roster = names.map((n) => webStudent(n, { enrollments: enroll(CARE, CARE_BASE) }));
      const fee = [{ subject: '書籍費', detail: '教材', amount: 1000 }];
      const ancillary = new Map(names.map((n) => [n, n === '未收生' ? [] : fee]));
      const records = compare(
        new Map(report.map((r) => [r.name as string, r])) as never,
        roster as never[],
        '2026-10-14',
        undefined,
        context as never,
        ancillary as never,
      ).records;
      expect(records.find((r) => r.name === '未收生')?.note.tags).toContain('書籍費偏離常模');
    });
  });

  describe('compare：堂數單價檢驗與異常標記 (SESSION_ANOMALY)', () => {
    it('學費不可整除堂數 (7350 / 16) → 判定 SESSION_ANOMALY 並提示無法整除', () => {
      const report = [
        reportStudent('學生A', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
        }),
      ];
      const roster = [
        webStudent('學生A', {
          applicableEnglishBps: 10000,
          enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null }],
        }),
      ];
      const amountLookup = {
        getAmount: () => ({
          tuitionAmount: 7350,
          amountColumnHeading: '兒童美語-Dommie[團][W9]',
          amountRoute: 'class-column',
        }),
      };
      const records = compare(
        new Map(report.map(s => [s.name, s])),
        roster,
        '2026-10-01',
        amountLookup,
        LEGACY_V2_CONTEXT
      ).records;
      expect(records[0]?.statusCategory).toBe('SESSION_ANOMALY');
      expect(records[0]?.statusLabel).toBe('堂數或單價異常需確認');
      expect(records[0]?.note.notes.join('')).toContain('無法整除');
    });

    it('同班多數 16 堂、少數 8 堂 → 8 堂者標記堂數偏離與 SESSION_ANOMALY', () => {
      const names = ['生1', '生2', '生3', '生4', '偏離生'];
      const report = names.map((name, i) =>
        reportStudent(name, {
          tuitionRows: [`兒童美語-Dommie[團][W9] - ${i === 4 ? 8 : 16} 堂課`],
        })
      );
      const roster = names.map((name) =>
        webStudent(name, {
          applicableEnglishBps: 10000,
          enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null }],
        })
      );
      const records = runCompare(report, roster);
      const outlier = records.find(r => r.name === '偏離生');
      expect(outlier?.statusCategory).toBe('SESSION_ANOMALY');
      expect(outlier?.note.notes.join('')).toContain('堂數偏離');
      expect(outlier?.note.tags).toContain('堂數偏離');
    });
  });

  /**
   * Issue #238 擁有者裁決（暫行例外，#118 新增每堂單價欄位後重新評估）：
   *  - 同班可整除的學費列，每堂單價應相同；不同 → 需人工確認（不判定哪邊正確，D17）。
   *  - 只適用按堂計價班（美語／數學）。安親課輔等月費班不做「學費 ÷ 堂數」檢查。
   * 預期值皆手算：7360÷16=460、7200÷16=450、7350÷16 無法整除。
   */
  describe('compare：同班每堂單價一致性與月費班排除 (Issue #238)', () => {
    const TOKEN = '兒童美語-Dommie[團][W9]';
    const ENROLL = [{ rawToken: TOKEN, baseName: '兒童美語-Dommie', withdrawalDate: null }];

    /** 依學生名查金額的 lookup；未列者回 null。 */
    const lookupByName = (amounts: Record<string, number>) => ({
      getAmount: (name: string) => ({
        tuitionAmount: amounts[name] ?? null,
        amountColumnHeading: TOKEN,
        amountRoute: 'class-column',
      }),
    });

    const run = (
      amounts: Record<string, number>,
      sessionsByName: Record<string, number>,
      context: unknown = LEGACY_V2_CONTEXT,
      className = TOKEN,
      enrollments: unknown = ENROLL,
    ) => {
      const names = Object.keys(sessionsByName);
      const report = names.map((n) => reportStudent(n, { tuitionRows: [`${className} - ${sessionsByName[n]} 堂課`] }));
      const roster = names.map((n) => webStudent(n, { enrollments }));
      return compare(
        new Map(report.map((r) => [r.name as string, r])) as never,
        roster as never[],
        '2026-10-14',
        lookupByName(amounts) as never,
        context as never,
      ).records;
    };

    it('同班 5 人，4 人 460 元／堂、1 人 450 元／堂 → 僅偏離者標 SESSION_ANOMALY 並列出兩個單價', () => {
      const records = run(
        { 生1: 7360, 生2: 7360, 生3: 7360, 生4: 7360, 偏離生: 7200 },
        { 生1: 16, 生2: 16, 生3: 16, 生4: 16, 偏離生: 16 },
      );
      const odd = records.find((r) => r.name === '偏離生');
      expect(odd?.statusCategory).toBe('SESSION_ANOMALY');
      expect(odd?.note.tags).toContain('單價不一致');
      const text = odd?.note.notes.join('') ?? '';
      expect(text).toContain('450');
      expect(text).toContain('460');
      for (const r of records.filter((x) => x.name !== '偏離生')) {
        expect(r.statusCategory).toBe('MATCH');
        expect(r.note.notes.join('')).not.toContain('單價');
      }
    });

    it('同班只有兩人且單價不同（460 vs 450，無多數） → 兩列都標需人工確認', () => {
      const records = run({ 甲: 7360, 乙: 7200 }, { 甲: 16, 乙: 16 });
      expect(records.map((r) => r.statusCategory)).toEqual(['SESSION_ANOMALY', 'SESSION_ANOMALY']);
    });

    it('同班單價全部相同 → 不產生單價異常', () => {
      const records = run({ 甲: 7360, 乙: 7360, 丙: 7360 }, { 甲: 16, 乙: 16, 丙: 16 });
      expect(records.every((r) => r.statusCategory === 'MATCH')).toBe(true);
    });

    it('無法整除的列不參與單價比較：4 人 460、1 人 7350（不可整除）→ 僅該列有「無法整除」，無單價不一致說明', () => {
      const records = run(
        { 生1: 7360, 生2: 7360, 生3: 7360, 生4: 7360, 不整除生: 7350 },
        { 生1: 16, 生2: 16, 生3: 16, 生4: 16, 不整除生: 16 },
      );
      const odd = records.find((r) => r.name === '不整除生');
      expect(odd?.statusCategory).toBe('SESSION_ANOMALY');
      expect(odd?.note.notes.join('')).toContain('無法整除');
      expect(odd?.note.tags ?? []).not.toContain('單價不一致');
      expect(records.filter((r) => r.name !== '不整除生').every((r) => r.statusCategory === 'MATCH')).toBe(true);
    });

    it('月費班（名稱含國小輔導，v2 名稱映射判為 care）→ 不做整除與堂數偏離檢查', () => {
      const care = '115國小輔導-三年級[團][3]';
      const records = run(
        { 生1: 7350, 生2: 7360, 生3: 7360, 生4: 7360 },
        { 生1: 16, 生2: 16, 生3: 16, 生4: 8 },
        LEGACY_V2_CONTEXT,
        care,
        [{ rawToken: care, baseName: '115國小輔導-三年級', withdrawalDate: null }],
      );
      for (const r of records) {
        const text = r.note.notes.join('');
        expect(text).not.toContain('無法整除');
        expect(text).not.toContain('單價');
        expect(r.note.tags ?? []).not.toContain('堂數偏離');
      }
    });

    it('類別以 run 快照為準而非班名：班名像美語但快照為 care → 不做檢查', () => {
      const context = buildRunSnapshotContext({
        ruleSetVersion: 'erp-tag-v4',
        classCategories: [{ base_name: '兒童美語-Dommie', category: 'care', fixed_five_days: 0, class_type: 'care' }],
      })!;
      const records = run({ 甲: 7350, 乙: 7200 }, { 甲: 16, 乙: 16 }, context);
      for (const r of records) {
        expect(r.note.notes.join('')).not.toContain('無法整除');
        expect(r.note.notes.join('')).not.toContain('單價');
      }
    });

    it('快照類別為 english 時照常檢查（快照路徑可觸發單價異常）', () => {
      const context = buildRunSnapshotContext({
        ruleSetVersion: 'erp-tag-v4',
        classCategories: [{ base_name: '兒童美語-Dommie', category: 'english', fixed_five_days: 0, class_type: 'english' }],
      })!;
      const records = run({ 甲: 7360, 乙: 7200 }, { 甲: 16, 乙: 16 }, context);
      expect(records.some((r) => r.note.tags?.includes('單價不一致'))).toBe(true);
    });

    it('類別無法判定（快照缺該班）→ 不執行也不靜默：保持需人工狀態並說明未檢驗', () => {
      const context = buildRunSnapshotContext({ ruleSetVersion: 'erp-tag-v4', classCategories: [] })!;
      const [r] = run({ 甲: 7350 }, { 甲: 16 }, context);
      expect(r.statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
      const text = r.note.notes.join('');
      expect(text).not.toContain('無法整除');
      expect(text).toContain('未執行');
      expect(text).toContain('沒有班級');
    });

    it('快照列存在但類別為 unset／none → 說明「類別未判定」，不可說成沒有快照', () => {
      for (const category of ['unset', 'none']) {
        const context = buildRunSnapshotContext({
          ruleSetVersion: 'erp-tag-v4',
          classCategories: [{ base_name: '兒童美語-Dommie', category, fixed_five_days: 0, class_type: null }],
        })!;
        const [r] = run({ 甲: 7350 }, { 甲: 16 }, context);
        expect(r.statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
        const text = r.note.notes.join('');
        expect(text).not.toContain('沒有班級');
        expect(text).toContain('快照存在');
        expect(text).toContain(category);
      }
    });
  });

  describe('compare：附加費用同班常模偵測', () => {
    it('同班多數收取書籍費 $1000，未收取者於 note 提示書籍費偏離常模', () => {
      const names = ['生1', '生2', '生3', '生4', '未收生'];
      const report = names.map((name) =>
        reportStudent(name, {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'],
        })
      );
      const roster = names.map((name) =>
        webStudent(name, {
          applicableEnglishBps: 10000,
          enrollments: [{ rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null }],
        })
      );
      const ancillaryFees = new Map([
        ['生1', [{ subject: '書籍費', detail: '教材', amount: 1000 }]],
        ['生2', [{ subject: '書籍費', detail: '教材', amount: 1000 }]],
        ['生3', [{ subject: '書籍費', detail: '教材', amount: 1000 }]],
        ['生4', [{ subject: '書籍費', detail: '教材', amount: 1000 }]],
        ['未收生', []],
      ]);
      const records = compare(
        new Map(report.map(s => [s.name, s])),
        roster,
        '2026-10-01',
        undefined,
        LEGACY_V2_CONTEXT,
        ancillaryFees
      ).records;
      const uncharged = records.find(r => r.name === '未收生');
      expect(uncharged?.note.notes.join('')).toContain('書籍費');
      expect(uncharged?.note.notes.join('')).toContain('未收取');
      expect(uncharged?.note.tags).toContain('書籍費偏離常模');
    });
  });

  /**
   * Issue #236 擁有者裁決（a）：偏離列計入「需人工判讀」。
   *
   * 預期值手算（合成 fixture，不取工具輸出）：
   *  - 班「兒童美語-Dommie[團][W9]」5 人，4 人 16 堂、1 人 8 堂 → 常規堂數 16（4/5=80% ≥ 50%），
   *    8 堂者為堂數偏離。
   *  - 系統適用率 9000、報表無折扣明細（讀為 10000）→ 該列 DISCOUNT_DIFF。
   *  - 其餘 4 人系統 10000、報表無折扣 → MATCH，且無任何偏離。
   *  - 因此：差異筆數 = 1、折扣差異 = 1、需人工判讀 = 1（偏離列）、MATCH = 4。
   *  - 附加費用：4 人收書籍費 1000、1 人未收 → 常模 1000（4/5），未收者偏離（金額 0 ≠ 1000）。
   */
  describe('偏離列計入需人工判讀（Issue #236）', () => {
    const CLASS_TOKEN = '兒童美語-Dommie[團][W9]';
    const enroll = [{ rawToken: CLASS_TOKEN, baseName: '兒童美語-Dommie', withdrawalDate: null }];
    const META = {
      runId: 'run-synth', asOfDate: '2026-10-14', xlsxPath: '/synthetic/report.xlsx',
      ruleSetVersion: 'erp-tag-v2', numericPolicy: 'synthetic', rateSource: 'synthetic',
      billAnchorDate: '2026-10-01', duplicateNames: [] as string[], amountColumns: '（合成）',
    };
    type AncillaryItem = { subject: string; detail: string; amount: number | null };
    type AncillaryMap = Map<string, AncillaryItem[]>;
    const run = (
      sessionsByName: Record<string, number>,
      bpsByName: Record<string, number> = {},
      fees?: AncillaryMap,
    ) => {
      const names = Object.keys(sessionsByName);
      const report = names.map((n) => reportStudent(n, { tuitionRows: [`${CLASS_TOKEN} - ${sessionsByName[n]} 堂課`] }));
      const roster = names.map((n) => webStudent(n, { applicableEnglishBps: bpsByName[n] ?? 10000, enrollments: enroll }));
      return compare(
        new Map(report.map((r) => [r.name as string, r])) as never,
        roster as never[], '2026-10-14', undefined, LEGACY_V2_CONTEXT, fees,
      ).records;
    };
    const stat = (html: string, label: string) => {
      const m = html.match(new RegExp(`<span class="stat-label">${label}</span>\\s*<span class="stat-value[^"]*">(\\d+)</span>`));
      return m ? Number(m[1]) : null;
    };
    const SESSIONS = { 生1: 16, 生2: 16, 生3: 16, 生4: 16, 偏離生: 8 };

    it('已是 DISCOUNT_DIFF 的列另有堂數偏離 → 分類不變，但計入需人工判讀', () => {
      const records = run(SESSIONS, { 偏離生: 9000 });
      const odd = records.find((r) => r.name === '偏離生')!;
      expect(odd.statusCategory).toBe('DISCOUNT_DIFF');
      expect(odd.note.tags).toContain('堂數偏離');
      expect(isNeedsHumanRecord(odd)).toBe(true);
      expect(records.filter((r) => r.name !== '偏離生').every((r) => !isNeedsHumanRecord(r))).toBe(true);
    });

    it('MATCH 列的學雜費偏離常模 → 升級為 SESSION_ANOMALY（計入需人工、差異筆數）', () => {
      const fees: AncillaryMap = new Map(
        ['生1', '生2', '生3', '生4'].map((n): [string, AncillaryItem[]] => [n, [{ subject: '書籍費', detail: '教材', amount: 1000 }]]),
      );
      fees.set('偏離生', []);
      const records = run({ 生1: 16, 生2: 16, 生3: 16, 生4: 16, 偏離生: 16 }, {}, fees);
      const odd = records.find((r) => r.name === '偏離生')!;
      expect(odd.note.tags).toContain('書籍費偏離常模');
      expect(odd.statusCategory).toBe('SESSION_ANOMALY');
      expect(isNeedsHumanRecord(odd)).toBe(true);
    });

    it('非 MATCH 列的學雜費偏離 → 分類不變、仍計入需人工判讀', () => {
      const fees: AncillaryMap = new Map(
        ['生1', '生2', '生3', '生4'].map((n): [string, AncillaryItem[]] => [n, [{ subject: '書籍費', detail: '教材', amount: 1000 }]]),
      );
      fees.set('偏離生', []);
      const records = run({ 生1: 16, 生2: 16, 生3: 16, 生4: 16, 偏離生: 16 }, { 偏離生: 9000 }, fees);
      const odd = records.find((r) => r.name === '偏離生')!;
      expect(odd.statusCategory).toBe('DISCOUNT_DIFF');
      expect(isNeedsHumanRecord(odd)).toBe(true);
    });

    it('HTML：統計卡「需人工判讀」、分頁按鈕、列標記、歸納群組與差異筆數一致', () => {
      const records = run(SESSIONS, { 偏離生: 9000 });
      const html = renderHtml(records, META);
      expect(stat(html, '差異筆數')).toBe(1);
      expect(stat(html, '折扣差異')).toBe(1);
      expect(stat(html, '需人工判讀')).toBe(1);
      expect(html).toContain('需人工判讀 (1)');
      // 需人工判讀分頁的列過濾依據：偏離列必須帶標記，其餘列不得帶
      expect(html.match(/data-human="1"/g) ?? []).toHaveLength(1);
      expect(html).toMatch(/堂數或單價異常（需人工確認）（1 筆）/);
    });

    it('TUI 需人工確認明細列出偏離列，且筆數與統計卡相同', () => {
      const records = run(SESSIONS, { 偏離生: 9000 });
      const list = buildHumanReviewList(records);
      const lines = list.split('\n').filter((l: string) => l.startsWith('  - '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('偏離生');
      expect(lines[0]).toContain('堂數偏離');
    });

    it('學雜費含車資項：扣除車資後等於常模 → 不偏離、仍為 MATCH（Issue #236 裁決 2）', () => {
      // 手算：5 人學雜費皆 500；車資生另有車資 300，排除後仍 500 = 常模
      const fees: AncillaryMap = new Map(
        ['生1', '生2', '生3', '生4'].map((n): [string, AncillaryItem[]] => [n, [{ subject: '學雜費', detail: '學雜費', amount: 500 }]]),
      );
      fees.set('車資生', [
        { subject: '學雜費', detail: '學雜費', amount: 500 },
        { subject: '學雜費', detail: '車資', amount: 300 },
      ]);
      const records = run({ 生1: 16, 生2: 16, 生3: 16, 生4: 16, 車資生: 16 }, {}, fees);
      const bus = records.find((r) => r.name === '車資生')!;
      expect(bus.statusCategory).toBe('MATCH');
      expect(bus.note.tags ?? []).not.toContain('學雜費偏離常模');
      expect(isNeedsHumanRecord(bus)).toBe(false);
    });

    it('無偏離、無需人工分類 → 需人工判讀為 0，TUI 清單為空', () => {
      const records = run({ 生1: 16, 生2: 16, 生3: 16 });
      expect(stat(renderHtml(records, META), '需人工判讀')).toBe(0);
      expect(buildHumanReviewList(records)).toBe('');
    });
  });

  /**
   * Issue #241：車資明細表。
   *
   * 預期值手算（合成 fixture，不取工具輸出）：
   *  - 甲（Dommie 班）：車資 600（名目含算式）→ 1 列。
   *  - 乙（Dommie 班）：學雜費科目、明細「車資」300；科目「車資」明細「單趟車資」150；
   *    另有書籍費 1000（非車資，不得入表）→ 2 列。
   *  - 丙：只有書籍費 → 0 列。
   *  - 丁（Gino 班）：車資、金額讀不到（null）→ 1 列，金額不計入合計。
   *  - 因此：筆數 4、金額合計 600 + 300 + 150 = 1050、金額未讀到 1 筆。
   */
  describe('車資明細表（Issue #241）', () => {
    const DOMMIE = '兒童美語-Dommie[團][W9]';
    const GINO = '兒童美語-Gino[團][Starter]';
    const META = {
      runId: 'run-synth', asOfDate: '2026-10-14', xlsxPath: '/synthetic/report.xlsx',
      ruleSetVersion: 'erp-tag-v2', numericPolicy: 'synthetic', rateSource: 'synthetic',
      billAnchorDate: '2026-10-01', duplicateNames: [] as string[], amountColumns: '（合成）',
    };
    type Fee = { subject: string; detail: string; amount: number | null };
    const FARE_A = '車資 20趟*30=600 & 加收';
    const fees = new Map<string, Fee[]>([
      ['甲', [{ subject: '車資', detail: FARE_A, amount: 600 }]],
      ['乙', [
        { subject: '學雜費', detail: '車資', amount: 300 },
        { subject: '書籍費', detail: '教材', amount: 1000 },
        { subject: '車資', detail: '單趟車資', amount: 150 },
      ]],
      ['丙', [{ subject: '書籍費', detail: '教材', amount: 1000 }]],
      ['丁', [{ subject: '車資', detail: '車資待確認', amount: null }]],
    ]);
    const classOf: Record<string, string> = { 甲: DOMMIE, 乙: DOMMIE, 丙: DOMMIE, 丁: GINO };
    const build = (f: Map<string, Fee[]> | undefined) => {
      const names = ['甲', '乙', '丙', '丁'];
      const report = names.map((n) => reportStudent(n, { tuitionRows: [`${classOf[n]} - 16 堂課`] }));
      const roster = names.map((n) => webStudent(n, {
        personCode: `P-${n}`,
        applicableEnglishBps: 10000,
        enrollments: [{ rawToken: classOf[n], baseName: classOf[n]!.replace(/\[.*$/, ''), withdrawalDate: null }],
      }));
      return compare(
        new Map(report.map((r) => [r.name as string, r])) as never,
        roster as never[], '2026-10-14', undefined, LEGACY_V2_CONTEXT, f,
      );
    };

    it('compare 回傳車資列：只含車資項，依報表順序，保留名目原文與班級', () => {
      const { fareItems } = build(fees);
      expect(fareItems).toHaveLength(4);
      expect(fareItems.map((f: { name: string }) => f.name)).toEqual(['甲', '乙', '乙', '丁']);
      expect(fareItems[0]).toMatchObject({
        name: '甲', personCode: 'P-甲', className: DOMMIE, subject: '車資', detail: FARE_A, amount: 600,
      });
      expect(fareItems[1]).toMatchObject({ subject: '學雜費', detail: '車資', amount: 300 });
      expect(fareItems[3]).toMatchObject({ name: '丁', className: GINO, amount: null });
    });

    it('HTML：車資明細表列出每列原文與金額，表尾有筆數與合計（1,050），未讀到金額者另註', () => {
      const { records, fareItems } = build(fees);
      const html = renderHtml(records, { ...META, fareItems });
      expect(html).toContain('車資明細');
      expect(html).toContain('車資 20趟*30=600 &amp; 加收');
      expect(html).toContain('共 4 筆');
      expect(html).toContain('1,050');
      expect(html).toContain('1 筆金額未讀到');
      // 非車資項（書籍費／教材）不得進車資表；主表的「其他科目」仍可出現，故只檢查車資區塊
      const section = html.slice(html.indexOf('id="fare-detail"'), html.indexOf('</section>', html.indexOf('id="fare-detail"')));
      expect(section).not.toContain('教材');
      expect(section).not.toContain('1,000');
    });

    it('車資列為資訊列：不影響需人工判讀、差異筆數與列標記', () => {
      const { records, fareItems } = build(fees);
      const stat = (h: string, label: string) =>
        h.match(new RegExp(`<span class="stat-label">${label}</span>\\s*<span class="stat-value[^"]*">(\\d+)</span>`))?.[1];
      const withFare = renderHtml(records, { ...META, fareItems });
      const without = renderHtml(records, META);
      for (const label of ['需人工判讀', '差異筆數', '報科學費筆數']) {
        expect(stat(withFare, label)).toBe(stat(without, label));
      }
      expect(withFare.match(/data-human="1"/g)?.length ?? 0).toBe(without.match(/data-human="1"/g)?.length ?? 0);
    });

    it('無車資項 → 顯示空狀態，不出現合計', () => {
      const { records, fareItems } = build(new Map([['丙', [{ subject: '書籍費', detail: '教材', amount: 1000 }]]]));
      expect(fareItems).toEqual([]);
      const html = renderHtml(records, { ...META, fareItems });
      expect(html).toContain('車資明細');
      expect(html).toContain('本次報表無車資項目');
      expect(html).not.toContain('共 0 筆');
    });
  });

  /**
   * 「需人工判讀」統計卡副標各項加總必須等於卡片數值（Issue #241 附帶；PR #243 審查發現
   * 副標漏列 NOT_IN_WEB）。手算：甲（名單有）→ MATCH 不計；乙（名單無此人）→ NOT_IN_WEB 1；
   * 丙（報表無學費列）→ EXCEL_NO_TUITION 1；丙在名單中有 Dommie 在席報名但該班已開單、
   * 丙無學費列 → 另有 ROSTER_NOT_BILLED 1 → 卡片 3，副標各數字加總也須為 3。
   */
  describe('需人工判讀統計卡副標加總', () => {
    it('含「名單已無此人」時，副標各項加總 = 卡片數值', () => {
      const META = {
        runId: 'run-synth', asOfDate: '2026-10-14', xlsxPath: '/synthetic/report.xlsx',
        ruleSetVersion: 'erp-tag-v2', numericPolicy: 'synthetic', rateSource: 'synthetic',
        billAnchorDate: '2026-10-01', duplicateNames: [] as string[], amountColumns: '（合成）',
      };
      const report = [
        reportStudent('甲', { tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'] }),
        reportStudent('乙', { tuitionRows: ['兒童美語-Dommie[團][W9] - 16 堂課'] }),
        reportStudent('丙', { tuitionRows: [] }),
      ];
      const roster = [webStudent('甲', { applicableEnglishBps: 10000 }), webStudent('丙', { applicableEnglishBps: 10000 })];
      const { records } = compare(
        new Map(report.map((r) => [r.name as string, r])) as never,
        roster as never[], '2026-10-14', undefined, LEGACY_V2_CONTEXT,
      );
      const html = renderHtml(records, META);
      const m = html.match(/<span class="stat-label">需人工判讀<\/span>\s*<span class="stat-value[^"]*">(\d+)<\/span>\s*<span class="stat-sub">([^<]*)<\/span>/);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(3);
      const sum = (m![2]!.match(/\d+/g) ?? []).reduce((a, n) => a + Number(n), 0);
      expect(sum).toBe(3);
    });
  });

  /**
   * Issue #235：「報科學費筆數」＝報表實際的學費列數。
   *
   * 預期值手算（合成 fixture）：
   *  - 無學費列的紀錄類型有兩種：ROSTER_NOT_BILLED（反向在席查核，報表無此人此班）、
   *    EXCEL_NO_TUITION（報表有此人但無學費列）；兩者都不得計入。
   *  - NOT_IN_WEB 等其餘分類皆由學費列產生（每筆學費列一筆），照常計入。
   *  - 「全部」分頁、「顯示 N 筆」、差異筆數與折扣一致率的分母仍是**紀錄數**（含上述兩類），
   *    因為它們對應表格實際列數與「僅差異」分頁（cat !== MATCH）。
   */
  describe('報科學費筆數只計學費列（Issue #235）', () => {
    const META = {
      runId: 'run-synth', asOfDate: '2026-10-14', xlsxPath: '/synthetic/report.xlsx',
      ruleSetVersion: 'erp-tag-v2', numericPolicy: 'synthetic', rateSource: 'synthetic',
      billAnchorDate: '2026-10-01', duplicateNames: [] as string[], amountColumns: '（合成）',
    };
    const TUITION = '兒童美語-Dommie[團][W9] - 16 堂課';
    const stat = (html: string, label: string) =>
      html.match(new RegExp(`<span class="stat-label">${label}</span>\\s*<span class="stat-value[^"]*">(\\d+)</span>`))?.[1];
    const sub = (html: string, label: string) =>
      html.match(new RegExp(`<span class="stat-label">${label}</span>\\s*<span class="stat-value[^"]*">\\d+</span>\\s*<span class="stat-sub">([^<]*)</span>`))?.[1];

    it('在席未開單紀錄不計入：1 學費列 + 1 未開單 → 報科學費筆數 1，其餘仍以紀錄數 2 計', () => {
      const records = runCompare(
        [reportStudent('開單生', { tuitionRows: [TUITION], discounts: [] })],
        [
          webStudent('開單生'),
          webStudent('未開單在席生', { personCode: 'P-SYNTH-0002' }),
        ],
      );
      expect(records.map(r => r.statusCategory).sort()).toEqual(['MATCH', 'ROSTER_NOT_BILLED']);
      const html = renderHtml(records, META);
      expect(stat(html, '報科學費筆數')).toBe('1');
      // 未開單紀錄仍可見、仍計入差異筆數與需人工判讀
      expect(stat(html, '差異筆數')).toBe('1');
      expect(stat(html, '需人工判讀')).toBe('1');
      expect(sub(html, '需人工判讀')).toContain('未開單 1');
      // 表格列數與「全部」分頁、折扣一致率分母＝紀錄數 2（1/2 = 50.0%）
      expect(html).toContain('全部 (2)');
      expect(html).toContain('顯示 2 筆');
      expect(sub(html, '折扣一致')).toBe('50.0%');
    });

    it('報表無學費列的紀錄（EXCEL_NO_TUITION）不計入；NOT_IN_WEB 由學費列產生，照常計入', () => {
      // 手算：甲 MATCH（1 學費列）、乙 NOT_IN_WEB（1 學費列）、丙 EXCEL_NO_TUITION（0 學費列）、
      // 未開單 ROSTER_NOT_BILLED（0 學費列）→ 紀錄 4、學費列 2
      const records = runCompare(
        [
          reportStudent('甲', { tuitionRows: [TUITION] }),
          reportStudent('乙', { tuitionRows: [TUITION] }),
          reportStudent('丙', { tuitionRows: [] }),
        ],
        [
          webStudent('甲'),
          webStudent('丙', { enrollments: [] }),
          webStudent('未開單在席生', { personCode: 'P-SYNTH-0002' }),
        ],
      );
      expect(records.map(r => r.statusCategory).sort()).toEqual(
        ['EXCEL_NO_TUITION', 'MATCH', 'NOT_IN_WEB', 'ROSTER_NOT_BILLED'],
      );
      const html = renderHtml(records, META);
      expect(stat(html, '報科學費筆數')).toBe('2');
      expect(stat(html, '差異筆數')).toBe('3');
      expect(html).toContain('全部 (4)');
      expect(html).toContain('顯示 4 筆');
    });

    it('雙科學生兩筆學費列 → 計 2 筆（副標「雙科學生會有兩筆」仍成立）', () => {
      const records = runCompare(
        [reportStudent('雙科生', {
          tuitionRows: [TUITION, '兒童美語-Gino[團][W9] - 16 堂課'],
        })],
        [webStudent('雙科生', {
          enrollments: [
            { rawToken: '兒童美語-Dommie[團][W9]', baseName: '兒童美語-Dommie', withdrawalDate: null },
            { rawToken: '兒童美語-Gino[團][W9]', baseName: '兒童美語-Gino', withdrawalDate: null },
          ],
        })],
      );
      expect(records).toHaveLength(2);
      expect(stat(renderHtml(records, META), '報科學費筆數')).toBe('2');
    });

    /** 承 PR #245 審查 Nit：同時帶 nonStandardPending 與 deviation 者只計一次。 */
    it('同一筆同時帶 nonStandardPending 與 deviation → 需人工判讀只計 1，副標加總 = 1', () => {
      // 手算：生1–生4 皆 16 堂（眾數、無偏離）；偏離生 8 堂 → 堂數偏離；
      // 偏離生報表 9.5 折 vs 網頁 9 折且有補加收 → DISCOUNT_DIFF + nonStandardPending。
      const MAKE_UP = '兒童美語-Dommie[團][W9][折扣] - 補收 學費 15*40=600';
      const names = ['生1', '生2', '生3', '生4'];
      const report = [
        ...names.map(n => reportStudent(n, { tuitionRows: [TUITION] })),
        reportStudent('偏離生', {
          tuitionRows: ['兒童美語-Dommie[團][W9] - 8 堂課'],
          discounts: ['兒童美語-Dommie[團][W9][9.5折] - 課程費95折', MAKE_UP],
          otherDiscounts: [MAKE_UP],
        }),
      ];
      const roster = [
        ...names.map(n => webStudent(n, { applicableEnglishBps: 10000 })),
        webStudent('偏離生', { applicableEnglishBps: 9000 }),
      ];
      const records = runCompare(report, roster);
      const odd = records.find(r => r.name === '偏離生')!;
      expect(odd.statusCategory).toBe('DISCOUNT_DIFF');
      expect((odd as { deviation?: boolean }).deviation).toBe(true);
      expect((odd as { nonStandardPending?: boolean }).nonStandardPending).toBe(true);
      const html = renderHtml(records, META);
      expect(stat(html, '需人工判讀')).toBe('1');
      const parts = sub(html, '需人工判讀')!;
      expect((parts.match(/\d+/g) ?? []).reduce((a, n) => a + Number(n), 0)).toBe(1);
      // 兩旗標互斥歸屬：只計入「偏離（分類在他處）」，不重複計入「非標準（分類在他處）」
      expect(parts).toContain('偏離（分類在他處）1');
      expect(parts).toContain('非標準（分類在他處）0');
    });
  });

  /** 分類完整性：新增分類若沒接進 badge／needsHuman，第一次出現就會渲染錯誤。 */
  describe('分類註冊完整性', () => {
    it('BADGES 涵蓋全部分類，不得有 undefined', () => {
      for (const id of SESSION_RATE_CATEGORIES) {
        expect(SESSION_BADGES[id], `分類 ${id} 缺少 badge`).toBeTruthy();
        expect(SESSION_BADGES[id]).not.toContain('undefined');
      }
    });

    it('需人工判讀的分類都在 NEEDS_HUMAN 內', () => {
      expect(SESSION_NEEDS_HUMAN).toEqual(expect.arrayContaining([
        'NON_STANDARD_DISCOUNT', 'RATE_UNPARSED', 'UNKNOWN_CLASS',
        'WEB_RATE_NOT_CONFIGURED', 'NOT_IN_WEB', 'UNPAIRABLE', 'EXCEL_NO_TUITION',
        'SESSION_ANOMALY', 'ROSTER_NOT_BILLED',
      ]));
    });

    it('不得沿用國小輔導的級距分類（按堂計價無級距制度）', () => {
      for (const tierCat of ['DAY_DIFF', 'BOTH_DIFF', 'TIER_UNPARSED']) {
        expect(SESSION_RATE_CATEGORIES, `按堂計價不應有 ${tierCat}`).not.toContain(tierCat);
      }
    });

    it('每個分類的 insightGroup 皆為已宣告的群組，或顯式宣告 none', () => {
      // 每個 id 的 groupOf 必須命中 INSIGHT_GROUPS 的某個 key；
      // 宣告 'none' 者則**不得**是任何群組 key（否則它會被算進群組卻沒有群組可歸）。
      // .mjs 不受 tsconfig checkJs 保護（CLAUDE.md §9.0），元素型別推導為 any[]，
      // 故 map 參數必須顯式標註，否則 strict 的 noImplicitAny 會擋下。
      const declared = new Set(INSIGHT_GROUPS.map((g: { key: string }) => g.key));
      for (const id of SESSION_RATE_CATEGORIES) {
        const g = SESSION_CATEGORY_REGISTRY.groupOf[id];
        expect(g, `分類 ${id} 未宣告 insightGroup`).toBeTruthy();
        if (g === 'none') {
          expect(declared.has(g), `分類 ${id} 宣告 none，但 INSIGHT_GROUPS 內不應有名為 none 的群組`).toBe(false);
        } else {
          expect(declared.has(g), `分類 ${id} 的 insightGroup「${g}」不存在於 INSIGHT_GROUPS——該分類的記錄會被所有群組同時丟棄`).toBe(true);
        }
      }
    });

    /**
     * 孤兒守衛：`groupOf` 指向**不存在的群組 key** 時，`renderInsightGroups`
     * 會把該分類的記錄**同時從所有群組中丟棄**——不報錯、不計數、不留痕跡。
     *
     * 這是 review M-6 找到的真實缺口：原守衛只斷言 `groupOf[id]` 為 truthy，
     * 與 INSIGHT_GROUPS 的 key 完全沒有比對，故拼錯 insightGroup 時 49 項測試全綠。
     *
     * ## 本守衛**不**偵測什麼（誠實界定）
     *
     * 把某分類的 `insightGroup` 從 'unpairable' 改成 'none' **不會**被本守衛擋下，
     * 那是合理的配置選擇（該分類確實不必進任何歸納群組），規格也只要求
     * 「'none' 者不得是任何群組 key」，未要求它必須屬於某個群組。
     *
     * 但它同樣會讓該分類的記錄不出現在任何歸納區塊。因此：
     *   - 要偵測「拼錯 key」→ 本測試（可失敗，已以 M-6 實測）。
     *   - 要偵測「歸納區塊整組漏掉某分類」→ 需另比較**渲染後的歸納區塊**
     *     與 records 的涵蓋率，那是本測試刻意不承諾的範圍。
     *
     * 測試名稱若承諾偵測不到的保證，會成為未來的假訊號（PR #119 教訓）。
     */
    it('孤兒 insightGroup 守衛：指向不存在的群組 key 必須被擋下', () => {
      const declared = INSIGHT_GROUPS.map((g: { key: string }) => g.key);
      // 守衛條件（與上方主守衛一致）：非 'none' 者必須命中已宣告的群組 key
      const accepts = (groupOf: Record<string, string>) => {
        const keys = new Set(declared);
        return Object.entries(groupOf).every(([, g]) => g && (g === 'none' || keys.has(g)));
      };
      // 對照：正確的 registry 應被接受
      expect(accepts(SESSION_CATEGORY_REGISTRY.groupOf as Record<string, string>), '守衛條件誤拒了正確的 registry').toBe(true);
      // 拼錯的 key 必須被拒（這正是 M-6 的失效）
      expect(accepts({ ...(SESSION_CATEGORY_REGISTRY.groupOf as Record<string, string>), NOT_IN_WEB: 'notInWebTypo' })).toBe(false);
      // 未宣告的空值必須被拒
      expect(accepts({ ...(SESSION_CATEGORY_REGISTRY.groupOf as Record<string, string>), MATCH: '' })).toBe(false);
    });
  });
});

/**
 * 雙科展開的來源：共用層的 `readMultiTuitionReport`。
 *
 * 這裡以 ExcelRowLike 替身直接驗證：兩筆學費列都必須被保留，
 * 順序依報表列順序。若共用層退回單一字串，第二筆會靜默消失——
 * 該生報告上會只剩一門課，而筆數與各欄計數都不會報錯。
 */
describe('共用層：readMultiTuitionReport 保留多筆學費列', () => {
  const sheet = (rows: Record<number, string | undefined>[]) => ({
    eachRow: (cb: (row: { getCell: (n: number) => { text: string | undefined } }, n: number) => void) => {
      rows.forEach((cells, i) => cb({ getCell: (n: number) => ({ text: cells[n] }) }, i + 1));
    },
  });

  it('同一名學生的兩筆學費列都被保留', () => {
    const m = readMultiTuitionReport(sheet([
      { 1: '表頭' },
      { 1: '合成雙', 4: '兒童美語-A[團] - 16 堂課', 7: '學費' },
      { 1: '合成雙', 4: '115國小數學-三A[團] - 20 堂課', 7: '學費' },
    ]), { tuition: '學費', discount: '折扣' });
    expect(m.get('合成雙')!.tuitionRows).toEqual([
      '兒童美語-A[團] - 16 堂課',
      '115國小數學-三A[團] - 20 堂課',
    ]);
  });

  it('只有一筆學費列者長度為 1', () => {
    const m = readMultiTuitionReport(sheet([
      { 1: '表頭' },
      { 1: '合成甲', 4: '兒童美語-A[團] - 16 堂課', 7: '學費' },
    ]), { tuition: '學費', discount: '折扣' });
    expect(m.get('合成甲')!.tuitionRows).toEqual(['兒童美語-A[團] - 16 堂課']);
  });

  it('與 readReport 的科目分派一致：折扣累加、其他科目進 other', () => {
    const rows = [
      { 1: '表頭' },
      { 1: '合成甲', 2: 'B-1', 4: '兒童美語-A[團] - 16 堂課', 7: '學費' },
      { 1: '合成甲', 4: 'x[9折] - 課程費9折', 7: '折扣' },
      { 1: '合成甲', 4: '書籍費', 7: '學雜費' },
    ];
    const m = readMultiTuitionReport(sheet(rows), { tuition: '學費', discount: '折扣' });
    const e = m.get('合成甲')!;
    expect(e.discounts).toEqual(['x[9折] - 課程費9折']);
    expect(e.other).toEqual(['書籍費']);
    expect(e.billNo).toBe('B-1');
  });
});

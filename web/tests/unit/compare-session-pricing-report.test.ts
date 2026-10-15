import { describe, it, expect } from 'vitest';

import {
  parseSessionTuition,
  parseAmountColumns,
  findNonStandardDiscounts,
  routeRateField,
  compare,
  SESSION_CATEGORY_REGISTRY,
  INSIGHT_GROUPS,
  BADGES as SESSION_BADGES,
  NEEDS_HUMAN as SESSION_NEEDS_HUMAN,
  SESSION_RATE_CATEGORIES,
} from '../../scripts/compare-session-pricing-report.mjs';
import { readMultiTuitionReport } from '../../scripts/shared/report-xlsx';
import { rateCategoryOfClass } from '../../src/application/applicable-rate';

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
 *  - 類別路由：`rateCategoryOfClass` 的名稱子字串規則（國小輔導／國小數學／兒童美語），
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
   * `rateCategoryOfClass` 為預期值：若工具端自寫一份對照表並與產品分歧，
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

    it('與產品端 rateCategoryOfClass 對同一組班名必須一致（防止複寫漂移）', () => {
      const classNames = [
        '兒童美語-Dommie[團][W9]', '兒童美語-Gino[團][Starter]', '兒童美語-Archy[團][W7]',
        '115國小數學-三A[團]', '115國小數學-一A[團]', '115國小輔導-三年級[團][3]',
        '國小輔導-一A[團]', '未知班級[團]', '',
      ];
      for (const className of classNames) {
        expect(routeRateField(className, student).category, `班名「${className}」路由與產品不一致`)
          .toBe(rateCategoryOfClass(className));
      }
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
    compare(new Map(report.map(r => [r.name as string, r])) as never, web as never[], '2026-10-14').records;

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
import { describe, it, expect } from 'vitest';
import { parseTuition, parseDiscounts, normalizeName } from '../../scripts/compare-billing-report.mjs';

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

    it('無級距修飾 → 全週 5 天（[團] 不是級距）', () => {
      const r = parseTuition('115國小輔導-四年級A[團] - 40 堂課');
      expect(r.days).toBe(5);
      expect(r.tierStatus).toBe('full_week');
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
      expect(r2.tierStatus).toBe('full_week');
    });

    // review F2：未知修飾不可當無後綴回 5，否則等於替產品斷言它刻意不斷言的數值
    it('域外級距 [2] → days 為 null 並標記 unknown，不可默默回 5', () => {
      const r = parseTuition('115國小輔導-四A[團][2] - 40 堂課');
      expect(r.days).toBeNull();
      expect(r.tierStatus).toBe('unknown');
    });

    it('未知數字修飾 [6] → unknown', () => {
      const r = parseTuition('115國小輔導-四A[團][6] - 40 堂課');
      expect(r.days).toBeNull();
      expect(r.tierStatus).toBe('unknown');
    });

    it('同時出現多個已知級距 → 資料矛盾，不猜', () => {
      const r = parseTuition('115國小輔導-一A[團][4_5][4] - 40 堂課');
      expect(r.days).toBeNull();
      expect(r.tierStatus).toBe('ambiguous');
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
  });
});
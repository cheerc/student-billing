import { describe, it, expect } from 'vitest';
import {
  checkTuitionDivisibility,
  analyzeClassSessions,
  analyzeClassAncillaryNorms,
  type AncillaryItem,
} from '../../scripts/shared/heuristics';

/**
 * 啟發式檢驗與同班常模統計純函式單元測試（Issue #231 G2 / G3）。
 *
 * 全部使用合成數據，無真實個資（CLAUDE.md §3）。
 * 預期結果依 Plan 20 §2 Ruling 3、Ruling 4 與 §5.2 U01-U04 獨立手算。
 */
describe('帳務比對啟發式檢驗模組 (heuristics.ts)', () => {
  describe('checkTuitionDivisibility: 學費堂數整除性檢驗', () => {
    it('U01: 7360 / 16 可整除 → isDivisible: true, unitPrice: 460, note: null', () => {
      const res = checkTuitionDivisibility(7360, 16);
      expect(res.isDivisible).toBe(true);
      expect(res.unitPrice).toBe(460);
      expect(res.note).toBeNull();
    });

    it('U02: 7350 / 16 無法整除 → isDivisible: false, unitPrice: 459.375, note 提示無法整除', () => {
      const res = checkTuitionDivisibility(7350, 16);
      expect(res.isDivisible).toBe(false);
      expect(res.unitPrice).toBe(459.375);
      expect(res.note).toContain('無法整除');
      expect(res.note).toContain('7,350');
      expect(res.note).toContain('16');
      expect(res.note).toContain('459.38');
    });

    it('學費或堂數為空／0 時不判定異常', () => {
      expect(checkTuitionDivisibility(null, 16).isDivisible).toBe(true);
      expect(checkTuitionDivisibility(7360, null).isDivisible).toBe(true);
      expect(checkTuitionDivisibility(null, null).isDivisible).toBe(true);
      expect(checkTuitionDivisibility(7360, 0).isDivisible).toBe(true);
    });
  });

  describe('analyzeClassSessions: 同班堂數眾數與偏離分析', () => {
    it('U03: 5 人中 4 人 16 堂、1 人 8 堂 → 眾數 16 (80%)，8 判定為偏離 (outlier)', () => {
      const records = [
        { sessions: 16 },
        { sessions: 16 },
        { sessions: 16 },
        { sessions: 16 },
        { sessions: 8 },
      ];
      const analysis = analyzeClassSessions(records);
      expect(analysis.classModeSessions).toBe(16);
      expect(analysis.modeCount).toBe(4);
      expect(analysis.totalWithSessions).toBe(5);
      expect(analysis.modeRatio).toBe(0.8);

      expect(analysis.isOutlier(16)).toBe(false);
      expect(analysis.isOutlier(8)).toBe(true);

      const check8 = analysis.checkSession(8);
      expect(check8.isOutlier).toBe(true);
      expect(check8.notes[0]).toContain('堂數偏離');
      expect(check8.notes[0]).toContain('16 堂');

      const check16 = analysis.checkSession(16);
      expect(check16.isOutlier).toBe(false);
      expect(check16.notes).toHaveLength(0);
    });

    it('同班無堂數達 50% 門檻時，無常規模式，不誤報偏離', () => {
      const records = [
        { sessions: 16 },
        { sessions: 12 },
        { sessions: 8 },
      ];
      const analysis = analyzeClassSessions(records);
      expect(analysis.classModeSessions).toBeNull();
      expect(analysis.isOutlier(16)).toBe(false);
      expect(analysis.isOutlier(12)).toBe(false);
      expect(analysis.isOutlier(8)).toBe(false);
    });

    it('空列表或全部堂數為空時安全處理', () => {
      const analysis = analyzeClassSessions([{ sessions: null }, { sessions: null }]);
      expect(analysis.classModeSessions).toBeNull();
      expect(analysis.totalWithSessions).toBe(0);
      expect(analysis.isOutlier(16)).toBe(false);
    });
  });

  describe('analyzeClassAncillaryNorms: 附加費用同班常模統計與偏離比對', () => {
    it('U04: 書籍費 4 人 $1000、1 人 $0 → 常模 $1000，0 元學生產生未收取警示', () => {
      const classFees = new Map<string, AncillaryItem[]>([
        ['學生A', [{ subject: '書籍費', detail: 'Starter 教材', amount: 1000 }]],
        ['學生B', [{ subject: '書籍費', detail: 'Starter 教材', amount: 1000 }]],
        ['學生C', [{ subject: '書籍費', detail: 'Starter 教材', amount: 1000 }]],
        ['學生D', [{ subject: '書籍費', detail: 'Starter 教材', amount: 1000 }]],
        ['學生E', []], // 未收書籍費
      ]);

      const results = analyzeClassAncillaryNorms(classFees);

      const resA = results.get('學生A')?.find(r => r.subject === '書籍費');
      expect(resA?.normAmount).toBe(1000);
      expect(resA?.studentAmount).toBe(1000);
      expect(resA?.isAnomaly).toBe(false);

      const resE = results.get('學生E')?.find(r => r.subject === '書籍費');
      expect(resE?.normAmount).toBe(1000);
      expect(resE?.studentAmount).toBe(0);
      expect(resE?.isAnomaly).toBe(true);
      expect(resE?.note).toContain('未收取');
      expect(resE?.note).toContain('1,000');
    });

    it('少數學生單獨購買商品（如書包）時提示另有商品明細，不誤報為其他人漏領', () => {
      const classFees = new Map<string, AncillaryItem[]>([
        ['學生A', [{ subject: '商品', detail: '書包', amount: 300 }]],
        ['學生B', []],
        ['學生C', []],
      ]);

      const results = analyzeClassAncillaryNorms(classFees);

      // 商品佔比 1/3 (< 50%)，不構成全班常模
      const resB = results.get('學生B')?.find(r => r.subject === '商品');
      expect(resB?.isAnomaly).toBeFalsy();

      const resA = results.get('學生A')?.find(r => r.subject === '商品');
      expect(resA?.normAmount).toBeNull();
      expect(resA?.studentAmount).toBe(300);
      expect(resA?.isAnomaly).toBe(false);
      expect(resA?.note).toContain('書包');
      expect(resA?.note).toContain('300');
    });
  });
});

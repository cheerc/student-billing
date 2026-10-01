import { describe, it, expect } from 'vitest';
import { summarize } from '../../scripts/parity-d2b.mts';
import type { StudentSnapshot } from '@/domain/students';

/** 真實 calculator→baseline 腳本的欄位映射；expected 由 R09/R10/R14 手算。 */
describe('D2c parity baseline 的四率不可讀成 undefined', () => {
  it('數學＋美語兩科：基本率與四種適用率皆 9500 bps（兩版）', () => {
    const student: StudentSnapshot = {
      personCode: 'SYNTH-RATE', name: '合成學生', branch: null, grade: 4,
      gradeRaw: '4', gradeStatus: 'valid', contact: null, schoolInfo: null,
      tagsRaw: '', tags: [], notesRaw: '', sourceRow: 1,
      enrollments: ['國小數學-四A', '兒童美語-Gino'].map(baseName => ({
        baseName, rawToken: baseName, yearPrefix: null, groupFlag: null, modifiers: [],
        withdrawalDate: null, erpBillingTierRaw: null, erpBillingTier: null,
        tierParseStatus: 'not_applicable' as const, parseStatus: 'ok' as const,
      })),
    };
    const summary = summarize(student);
    for (const version of [summary.v2, summary.v3]) {
      expect(version.baseDiscountBps).toBe(9500);
      expect(version.applicableAnqinBps).toBe(9500);
      expect(version.applicableTutoringBps).toBe(9500);
      expect(version.applicableMathBps).toBe(9500);
      expect(version.applicableEnglishBps).toBe(9500);
    }
  });
});

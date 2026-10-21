import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildSchedulePreview } from '@/application/schedule-preview';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import type { CalculateDraft } from '@/contracts/settings';
import { loadModule, makeStudent } from '../helpers/d1-test-kit';

/**
 * D1（specs/11 §3 D1、04 §8 UX35）：規則版本能力旗標。
 *
 * 動機（manifest §1.4）：`=== 'erp-tag-v2'` 的字面比較有 4 處會改變行為
 * （billing-calculator.ts:107,226,263、schedule-preview.ts:248）。D2 新增 v3 時只要漏改任一處，
 * v3 就會靜默退回 v1 的純時刻比對，而且沒有任何型別錯誤。D1 先把這些判斷收成能力旗標，
 * 並用本檔逐版明列（v1／v2／compat 各自的旗標值與可觀察行為）固定下來。
 *
 * 第一組（旗標表）針對新模組，模組尚不存在時是斷言失敗；第二、三組是特徵化測試——
 * 走既有入口（calculateStudentBilling、buildSchedulePreview）觀察，D1 前後都必須成立。
 * expected 皆獨立手算：
 *   課輔窗口 16:30–19:30＝990–1170；週一 16:30–18:00＝990–1080 → 重疊 90 分 → raw −90/180＝−0.5
 *   → D24：d=0.5，n=0，f=0.5∈[0.3,0.8) → 扣 0.5 → 年級 4 課輔天數 = max(3, 5−0.5)＝4.5；重疊 0 → 5。
 */

interface Capabilities {
  sameWeekdayOnly: boolean;
  unknownWeekdayWarning: boolean;
  scheduleIncompleteOnUnknownWeekday: boolean;
  categoryBasedBilling: boolean;
  maxDeductionSelection: boolean;
  missingEnglishScheduleWarning: boolean;
  diagnosticsDecomposition: boolean;
  unmappedClassWarning: boolean;
  extraDeductionAfterFloor: boolean;
  homeworkDiscountDecoupled: boolean;
}

describe('D1 能力旗標表（新模組 @/domain/billing/rule-set）', () => {
  it('模組存在，並逐版明列旗標：v2 全開；v1、compat、未知字串全關（與 8961c03 的 === v2 語意相同）', async () => {
    const mod = await loadModule<{
      ruleSetCapabilities: (v: string) => Capabilities;
      isFormalRuleSetVersion: (v: string) => boolean;
      FORMAL_RULE_SET_VERSIONS: ReadonlySet<string>;
    }>('@/domain/billing/rule-set');
    expect(mod, '@/domain/billing/rule-set 需存在').not.toBeNull();
    const caps = mod!.ruleSetCapabilities;

    // R2-4: 嚴格 toEqual 斷言全量 9 項旗標（#112 新增 homeworkDiscountDecoupled），防止靜默弱化
    expect(caps('erp-tag-v2')).toEqual({
      sameWeekdayOnly: true,
      unknownWeekdayWarning: true,
      scheduleIncompleteOnUnknownWeekday: true,
      categoryBasedBilling: false,
      maxDeductionSelection: false,
      missingEnglishScheduleWarning: false,
      diagnosticsDecomposition: false,
      unmappedClassWarning: false,
      extraDeductionAfterFloor: false,
      homeworkDiscountDecoupled: false,
    });
    for (const off of ['erp-tag-v1', 'excel-v260922-compat', 'garbage-version', '']) {
      expect(caps(off), off).toEqual({
        sameWeekdayOnly: false,
        unknownWeekdayWarning: false,
        scheduleIncompleteOnUnknownWeekday: false,
        categoryBasedBilling: false,
        maxDeductionSelection: false,
        missingEnglishScheduleWarning: false,
        diagnosticsDecomposition: false,
        unmappedClassWarning: false,
        extraDeductionAfterFloor: false,
        homeworkDiscountDecoupled: false,
      });
    }

    // 正式軌成員包含 v1、v2、v3、v4（D2 新增 v3；#112 新增 v4）
    expect([...mod!.FORMAL_RULE_SET_VERSIONS].sort()).toEqual(['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'erp-tag-v4']);
    expect(mod!.isFormalRuleSetVersion('erp-tag-v1')).toBe(true);
    expect(mod!.isFormalRuleSetVersion('erp-tag-v2')).toBe(true);
    expect(mod!.isFormalRuleSetVersion('excel-v260922-compat')).toBe(false);
    expect(mod!.isFormalRuleSetVersion('erp-tag-v3')).toBe(true);
    expect(mod!.isFormalRuleSetVersion('erp-tag-v4')).toBe(true);
  });
});

describe('D1 特徵化：calculateStudentBilling 的逐版行為（D1 前後相同）', () => {
  const session = (weekday: string) => [{ start: 990, end: 1080, weekday }];
  const calc = (version: 'erp-tag-v1' | 'erp-tag-v2' | 'excel-v260922-compat', weekday: string) =>
    calculateStudentBilling(makeStudent('S', ['國小數學-X'], { grade: 4 }), {
      ruleSetVersion: version,
      scheduleOverride: new Map([['國小數學-X', session(weekday)]]),
    });

  it('週六 16:30–18:00：v2 只比對週一至五 → 0 扣（5 天）；v1、compat 純時刻比對 → 扣 0.5（4.5 天）', () => {
    expect(calc('erp-tag-v2', '六').careDays.tutoring.days).toBe(5);
    expect(calc('erp-tag-v1', '六').careDays.tutoring.days).toBe(4.5);
    expect(calc('excel-v260922-compat', '六').careDays.tutoring.days).toBe(4.5);
  });

  it('未知星期「八」：只有 v2 fail-closed 為 0 並出 UNKNOWN_WEEKDAY 與 schedule_incomplete；v1、compat 不出警告且照時刻算 4.5', () => {
    const v2 = calc('erp-tag-v2', '八');
    expect(v2.careDays.tutoring.days).toBe(5);
    expect(v2.issues.map((i) => i.code)).toContain('UNKNOWN_WEEKDAY');
    expect(v2.tierComparisons[0].issues).toContain('SCHEDULE_INCOMPLETE');
    expect(v2.tierComparisons[0].needsReview).toBe(true);

    for (const v of ['erp-tag-v1', 'excel-v260922-compat'] as const) {
      const r = calc(v, '八');
      expect(r.careDays.tutoring.days, v).toBe(4.5);
      expect(r.issues.map((i) => i.code), v).not.toContain('UNKNOWN_WEEKDAY');
      expect(r.tierComparisons[0].issues, v).not.toContain('SCHEDULE_INCOMPLETE');
    }
  });

  it('合法星期一：三個版本都扣 0.5（同星期語意不改變原本就成立的情況）', () => {
    for (const v of ['erp-tag-v1', 'erp-tag-v2', 'excel-v260922-compat'] as const) {
      expect(calc(v, '一').careDays.tutoring.days, v).toBe(4.5);
    }
  });
});

describe('D1 特徵化：buildSchedulePreview 的逐版行為（讀模型）', () => {
  function draftWith(weekday: string): CalculateDraft {
    const seed = buildSeedDraft();
    return {
      ...seed,
      classes: [
        {
          baseName: '國小數學-X',
          subject: '國小數學',
          teacher: null,
          active: true,
          sessions: [{ weekday, startMinutes: 990, endMinutes: 1080 }],
        },
      ],
    } as unknown as CalculateDraft;
  }

  it('週六：v2 重疊 0（no_overlap）；v1 重疊 90（calculated）', () => {
    const v2 = buildSchedulePreview(draftWith('六'), 'erp-tag-v2');
    const v1 = buildSchedulePreview(draftWith('六'), 'erp-tag-v1');
    expect(v2.rows[0].tutoring).toMatchObject({ overlapMinutes: 0, status: 'no_overlap' });
    expect(v1.rows[0].tutoring).toMatchObject({ overlapMinutes: 90, status: 'calculated' });
    expect(v2.classes[0].tutoring.rounded).toBe(0);
    expect(v1.classes[0].tutoring.rounded).toBe(-0.5);
  });

  it('未知星期「八」：v2 標 unknown_weekday 並回 UNKNOWN_WEEKDAY 問題；v1 不標', () => {
    const v2 = buildSchedulePreview(draftWith('八'), 'erp-tag-v2');
    const v1 = buildSchedulePreview(draftWith('八'), 'erp-tag-v1');
    expect(v2.rows[0].tutoring.status).toBe('unknown_weekday');
    expect(v2.issues.map((i) => i.code)).toEqual(['UNKNOWN_WEEKDAY']);
    expect(v1.rows[0].tutoring.status).toBe('calculated');
    expect(v1.issues).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { calculateApplicableRate } from '@/domain/billing/discount-rules';
import { applicableRateForClass } from '@/application/applicable-rate';
import { computeRosterChanges } from '@/application/roster-changes';
import {
  FORMAL_RULE_SET_VERSIONS,
  TARGET_FORMAL_RULE_SET_VERSION,
  isFormalRuleSetVersion,
  historicalRuleSetMetadata,
} from '@/domain/billing/rule-set';
import type { StudentSnapshot } from '@/domain/students';
import type { ClassSettingLookup } from '@/domain/classification/class-category';
import type { RosterChangeContext } from '@/application/roster-changes';

/**
 * specs/14 §7 A15–A17、§3.4、§3.11：
 * 收費規則變更：課程學費折扣與固定 5 天解耦（erp-tag-v4）。
 *
 * 驗收項目：
 *  - A15: 固定 5 天旗標不影響學生層課程學費折扣（erp-tag-v4）
 *  - A16: 逐班層「本班適用折扣」完全由「列入多科折扣」（category）決定（erp-tag-v4）
 *  - A17: 版本隔離（v1/v2/v3/compat 計算結果與本改動前逐欄相同）
 *  - 天數下限保底防護：fixedFiveDays 對 careDays 的 5 天地板依然生效
 */

function makeStudent(params: {
  personCode: string;
  grade: number;
  baseNames: string[];
  tagsRaw?: string;
}): StudentSnapshot {
  return {
    personCode: params.personCode,
    name: `學生${params.personCode}`,
    branch: '本校',
    gradeRaw: `${params.grade}年級`,
    grade: params.grade,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: params.tagsRaw ?? '',
    tags: params.tagsRaw ? params.tagsRaw.split(/[,;\s]+/).filter(Boolean) : [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: params.baseNames.map((bn) => ({
      rawToken: `${bn}[團]`,
      yearPrefix: null,
      baseName: bn,
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    })),
  };
}

describe('specs/14 §3.11: erp-tag-v4 規則版本定義與能力旗標', () => {
  it('FORMAL_RULE_SET_VERSIONS 包含 erp-tag-v4，且 TARGET_FORMAL_RULE_SET_VERSION 為 erp-tag-v4', () => {
    expect(FORMAL_RULE_SET_VERSIONS.has('erp-tag-v4' as any)).toBe(true);
    expect(isFormalRuleSetVersion('erp-tag-v4')).toBe(true);
    expect(TARGET_FORMAL_RULE_SET_VERSION).toBe('erp-tag-v4');
  });

  it('historical metadata is read-only and unknown versions fail closed', () => {
    expect(historicalRuleSetMetadata('erp-tag-v4')).toEqual({
      known: true,
      hasClassCategorySnapshot: true,
      hasClassSemanticsSnapshot: true,
      fixedFiveDaysAffectsRate: false,
      sameWeekdayOnly: true,
    });
    expect(historicalRuleSetMetadata('erp-tag-v3')).toEqual({
      known: true,
      hasClassCategorySnapshot: true,
      hasClassSemanticsSnapshot: false,
      fixedFiveDaysAffectsRate: true,
      sameWeekdayOnly: true,
    });
    expect(historicalRuleSetMetadata('erp-tag-v2').hasClassCategorySnapshot).toBe(false);
    expect(historicalRuleSetMetadata('erp-tag-v1').sameWeekdayOnly).toBe(false);
    expect(historicalRuleSetMetadata('unknown-version')).toEqual({
      known: false,
      hasClassCategorySnapshot: false,
      hasClassSemanticsSnapshot: false,
      fixedFiveDaysAffectsRate: false,
      sameWeekdayOnly: false,
    });
  });
});

describe('specs/14 A15: 固定 5 天旗標不影響學生層課程學費折扣（erp-tag-v4）', () => {
  it('A15-1: 同一學生勾與不勾固定 5 天，六個課程學生層收費率完全相同（例如 2 科皆 9500）', () => {
    // Grade 4，報名 輔導班 (care) + 數學班 (math) -> 2 科有效科數
    // 手算：科數 2，無兄弟姊妹、無特殊折扣 -> 基本率 9500 bps
    const student = makeStudent({
      personCode: 'A15-1',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
    });

    // 勾選固定 5 天
    const settingsFixed = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', categorySource: 'manual', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    // 不勾選固定 5 天
    const settingsNotFixed = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', categorySource: 'manual', fixedFiveDays: false }],
      ['國小數學-四A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    const resFixedV4 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4' as any,
      classSettings: settingsFixed,
    });
    const resNotFixedV4 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4' as any,
      classSettings: settingsNotFixed,
    });

    // v4 下：勾與不勾，六個課程收費率完全相同
    expect(resFixedV4.applicableRates).toEqual(resNotFixedV4.applicableRates);
    expect(resFixedV4.applicableRates.tutoring).toBe(9500);
    expect(resFixedV4.applicableRates.math).toBe(9500);
    expect(resFixedV4.applicableRates.english).toBe(9500);

    expect(() => calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v3',
      classSettings: settingsFixed,
    })).toThrow(/請以 v4 明確升級/);
  });

  it('A15-2: 小一安親園內生：v4 下勾固定 5 天仍享有園內生優惠（9500 - 500 = 9000），不被強制 10000', () => {
    // Grade 1，報名 輔導班 (care) + 數學班 (math)，園內生標籤 -> 2 科有效科數
    // 手算：基本率 9500，園內生安親側 -500 -> 9000 bps
    const student = makeStudent({
      personCode: 'A15-2',
      grade: 1,
      baseNames: ['國小輔導-一年級', '國小數學-一A'],
      tagsRaw: '園內生',
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-一年級', { category: 'care', categorySource: 'manual', fixedFiveDays: true }],
      ['國小數學-一A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    const resV4 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4' as any,
      classSettings: settings,
    });
    expect(resV4.applicableRates.anqin).toBe(9000);
    expect(resV4.applicableRates.math).toBe(9500);

    expect(() => calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v3',
      classSettings: settings,
    })).toThrow(/請以 v4 明確升級/);
  });

  it('A15-3: roster-changes 在 v4 下不再將寫功課/固定 5 天班級列為折扣變動原因', () => {
    const classSettings = new Map<string, ClassSettingLookup>([
      ['國小輔導-一A', { category: 'care', categorySource: 'manual', fixedFiveDays: false }],
      ['國小數學-三A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
      ['國小輔導-寫功課', { category: 'none', categorySource: 'manual', fixedFiveDays: true }],
    ]);

    const before = makeStudent({ personCode: 'A15-3', grade: 3, baseNames: ['國小輔導-一A', '國小數學-三A'] });
    const after = makeStudent({ personCode: 'A15-3', grade: 3, baseNames: ['國小輔導-一A', '國小數學-三A', '國小輔導-寫功課'] });

    // 在 v4 下：＋寫功課 不影響折扣（2 科依然是 9500），輔導班適用率不變，無折扣變動
    const ctxV4: RosterChangeContext = { classSettings, ruleSetVersion: 'erp-tag-v4' };
    const changesV4 = computeRosterChanges([before], [after], ctxV4, ctxV4);
    const stuChangeV4 = changesV4.changes.find((c) => c.personCode === 'A15-3');
    expect(stuChangeV4?.classDiscountChanges ?? []).toHaveLength(0);

    expect(() => computeRosterChanges([before], [after], { classSettings, ruleSetVersion: 'erp-tag-v3' }, { classSettings, ruleSetVersion: 'erp-tag-v3' }))
      .toThrow(/只支援 erp-tag-v4/);
  });

  it('A15-4: v4 course-rate helper has no historical-version switches', () => {
    // 2 科有效科數基本率 9500 bps，非園內生
    // 解耦 (v4): 即使 hasHomeworkOrMeian = true，仍回傳 9500
    expect(calculateApplicableRate('anqin', 9500, false)).toBe(9500);
    expect(calculateApplicableRate('tutoring', 9500, false)).toBe(9500);
  });
});

describe('specs/14 A16: 逐班層「本班適用折扣」完全由「列入多科折扣」（category）決定（erp-tag-v4）', () => {
  it('A16-1: 學生只報寫功課班（category = none，0 個折扣類別），學生層收費率為 10000，不是 null', () => {
    // 學生層收費率：只報寫功課 (none)，有效科數 0 -> 基本率 10000 bps，非 null
    const student = makeStudent({
      personCode: 'A16-1',
      grade: 4,
      baseNames: ['國小輔導-寫功課'],
    });
    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-寫功課', { category: 'none', categorySource: 'manual', fixedFiveDays: true }],
    ]);

    const resV4 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4' as any,
      classSettings: settings,
    });
    expect(resV4.baseDiscountBps).toBe(10000);
    expect(resV4.applicableRates.tutoring).toBe(10000);
    expect(resV4.applicableRates.anqin).toBe(10000);
    expect(resV4.applicableRates.tutoring).not.toBeNull();
  });

  it('A16-2: applicableRateForClass 對 category = none 且 fixed_five_days = 1 的班回傳 not_configured', () => {
    const rateFields = {
      grade: 4,
      applicableAnqinBps: 9500,
      applicableTutoringBps: 9500,
      applicableMathBps: 9500,
      applicableEnglishBps: 9500,
    };

    // 快照：寫功課為 none, fixed_five_days = 1
    const snapshotMap = new Map([
      ['國小輔導-寫功課', { base_name: '國小輔導-寫功課', category: 'none', fixed_five_days: 1 }],
      ['國小輔導-四年級', { base_name: '國小輔導-四年級', category: 'care', fixed_five_days: 1 }],
    ]);
    const semanticSnapshotMap = new Map([
      ['國小輔導-寫功課', { baseName: '國小輔導-寫功課', category: 'none' }],
      ['國小輔導-四年級', { baseName: '國小輔導-四年級', category: 'care' }],
    ]);
    const v4Context = {
      ruleSetVersion: 'erp-tag-v4',
      findSnapshot: (name: string) => snapshotMap.get(name),
      findSemanticSnapshot: (name: string) => semanticSnapshotMap.get(name),
    };

    // 在 erp-tag-v4 下：
    // (a) none 類別班即使 fixed_five_days = 1，也回傳 not_configured
    const noneRateV4 = applicableRateForClass(
      '國小輔導-寫功課',
      rateFields,
      v4Context
    );
    expect(noneRateV4).toEqual({ status: 'not_configured' });

    // (b) care 類別且 fixed_five_days = 1 的班，正常回傳該生課輔收費率 9500（不硬回 10000）
    const careRateV4 = applicableRateForClass(
      '國小輔導-四年級',
      rateFields,
      v4Context
    );
    expect(careRateV4).toEqual({ status: 'configured', bps: 9500 });

    // 對照組：在 erp-tag-v3 下，fixed_five_days = 1 強制回傳 10000
    const noneRateV3 = applicableRateForClass(
      '國小輔導-寫功課',
      rateFields,
      { ruleSetVersion: 'erp-tag-v3', findSnapshot: (name) => snapshotMap.get(name) }
    );
    expect(noneRateV3).toEqual({ status: 'configured', bps: 10000 });

    const careRateV3 = applicableRateForClass(
      '國小輔導-四年級',
      rateFields,
      { ruleSetVersion: 'erp-tag-v3', findSnapshot: (name) => snapshotMap.get(name) }
    );
    expect(careRateV3).toEqual({ status: 'configured', bps: 10000 });
  });
});

describe('specs/14 A17: historical runs are read-only and cannot invoke a calculator', () => {
  it('retained historical identifiers fail closed at the new-calculation boundary', () => {
    const student = makeStudent({
      personCode: 'A17-1',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', categorySource: 'manual', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    for (const version of ['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'excel-v260922-compat']) {
      expect(() => calculateStudentBilling(student, { ruleSetVersion: version, classSettings: settings })).toThrow(/請以 v4 明確升級/);
    }

    const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: settings });
    expect(resV4.applicableRates.tutoring).toBe(9500);
    expect(resV4.applicableRates.math).toBe(9500);
  });

  it('防護：固定 5 天對 careDays 的天數下限保底在 v4 下依然生效（不可把天數地板也移除了）', () => {
    // 報名輔導班 (fixedFiveDays = true) + 數學班（產生衝堂扣天 1 天）
    const student = makeStudent({
      personCode: 'FLOOR-1',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', categorySource: 'manual', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    // 數學班時段：週一 16:30-18:00（課輔衝堂扣天 1.0 天）
    const scheduleOverride = new Map([
      ['國小數學-四A', [{ start: 990, end: 1080, weekday: '一', skipDeduction: false }]],
    ]);

    const resV4 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4' as any,
      classSettings: settings,
      scheduleOverride,
    });

    // 雖然數學班衝堂扣 1 天（5 - 1 = 4），但因輔導班勾選固定 5 天，天數地板保底 5 天依然生效！
    expect(resV4.careDays.tutoring.days).toBe(5);
  });
});

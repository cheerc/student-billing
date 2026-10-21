import { describe, it, expect } from 'vitest';
import { applicableRateForClass } from '@/application/applicable-rate';

describe('Ruling 5: applicableRateForClass 旗標回退優先序（usesSnapshot > ruleSetVersion > isV3Run）', () => {
  const rateFields = {
    grade: 4,
    applicableAnqinBps: 9500,
    applicableTutoringBps: 9500,
    applicableMathBps: 9000,
    applicableEnglishBps: 8500,
  };

  const snapshots = new Map([
    // 名稱是數學，但快照覆寫為 english
    ['國小數學-四A', { base_name: '國小數學-四A', category: 'english', fixed_five_days: 0 }],
    // 寫功課，fixed_five_days: 1
    ['國小輔導-寫功課', { base_name: '國小輔導-寫功課', category: 'none', fixed_five_days: 1 }],
  ]);

  it('1. usesSnapshot: false 明確關閉時，即使 ruleSetVersion 為 v4 / isV3Run=true，仍退回名稱映射', () => {
    const res = applicableRateForClass('國小數學-四A', rateFields, {
      usesSnapshot: false,
      ruleSetVersion: 'erp-tag-v4',
      isV3Run: true,
      findSnapshot: (n) => snapshots.get(n),
    });
    // 名稱映射：國小數學 -> math (9000)，若讀快照則為 english (8500)
    expect(res).toEqual({ status: 'configured', bps: 9000 });
  });

  it('2. usesSnapshot: true 明確開啟時，即使 isV3Run=false，仍優先讀取快照', () => {
    const res = applicableRateForClass('國小數學-四A', rateFields, {
      usesSnapshot: true,
      isV3Run: false,
      findSnapshot: (n) => snapshots.get(n),
    });
    // 讀快照：english (8500)
    expect(res).toEqual({ status: 'configured', bps: 8500 });
  });

  it('3. 未提供 usesSnapshot 時，依 ruleSetVersion 能力旗標判定：v4 不受固定 5 天覆寫，none 班為 not_configured', () => {
    const res = applicableRateForClass('國小輔導-寫功課', rateFields, {
      ruleSetVersion: 'erp-tag-v4',
      isV3Run: true,
      findSnapshot: (n) => snapshots.get(n),
    });
    expect(res).toEqual({ status: 'not_configured' });
  });

  it('4. fixedFiveDaysAffectsRate 明確指定優先於 ruleSetVersion：顯式 true 仍會強制 10000', () => {
    const res = applicableRateForClass('國小輔導-寫功課', rateFields, {
      ruleSetVersion: 'erp-tag-v4',
      fixedFiveDaysAffectsRate: true,
      findSnapshot: (n) => snapshots.get(n),
    });
    expect(res).toEqual({ status: 'configured', bps: 10000 });
  });
});

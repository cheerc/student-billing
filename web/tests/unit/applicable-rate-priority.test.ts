import { describe, it, expect } from 'vitest';
import { applicableRateForClass } from '@/application/applicable-rate';

describe('applicableRateForClass requires snapshots for snapshot-capable Run versions', () => {
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

  it('v4 metadata cannot be overridden to re-enable name mapping', () => {
    const res = applicableRateForClass('國小數學-四A', rateFields, {
      usesSnapshot: false,
      ruleSetVersion: 'erp-tag-v4',
      isV3Run: true,
      findSnapshot: (n) => snapshots.get(n),
    });
    // Run metadata requires the snapshot despite an explicit false hint.
    expect(res).toEqual({ status: 'configured', bps: 8500 });
  });

  it('usesSnapshot: true explicitly reads the snapshot', () => {
    const res = applicableRateForClass('國小數學-四A', rateFields, {
      usesSnapshot: true,
      isV3Run: false,
      findSnapshot: (n) => snapshots.get(n),
    });
    // 讀快照：english (8500)
    expect(res).toEqual({ status: 'configured', bps: 8500 });
  });

  it('v4 none class remains not_configured when its snapshot row is present', () => {
    const res = applicableRateForClass('國小輔導-寫功課', rateFields, {
      ruleSetVersion: 'erp-tag-v4',
      isV3Run: true,
      findSnapshot: (n) => snapshots.get(n),
    });
    expect(res).toEqual({ status: 'not_configured' });
  });

  it('fixedFiveDaysAffectsRate explicit override remains supported for a present row', () => {
    const res = applicableRateForClass('國小輔導-寫功課', rateFields, {
      ruleSetVersion: 'erp-tag-v4',
      fixedFiveDaysAffectsRate: true,
      findSnapshot: (n) => snapshots.get(n),
    });
    expect(res).toEqual({ status: 'configured', bps: 10000 });
  });

  it('v3/v4 version without a snapshot resolver fails closed', () => {
    for (const ruleSetVersion of ['erp-tag-v3', 'erp-tag-v4']) {
      expect(applicableRateForClass('國小數學-四A', rateFields, { ruleSetVersion }))
        .toEqual({ status: 'not_configured' });
    }
  });

  it('only explicit v1/v2 versions use the frozen historical mapper', () => {
    expect(applicableRateForClass('國小數學-四A', rateFields, { ruleSetVersion: 'erp-tag-v2' }))
      .toEqual({ status: 'configured', bps: 9000 });
    expect(applicableRateForClass('國小數學-四A', rateFields))
      .toEqual({ status: 'not_configured' });
  });

  it('unknown or compatibility historical versions are unavailable even when the class name looks configured', () => {
    const res = applicableRateForClass('國小數學-四A', rateFields, {
      ruleSetVersion: 'corrupt-v99',
      usesSnapshot: false,
      findSnapshot: (n) => snapshots.get(n),
    });
    expect(res).toEqual({ status: 'not_configured' });
    expect(applicableRateForClass('國小數學-四A', rateFields, {
      ruleSetVersion: 'excel-v260922-compat',
    })).toEqual({ status: 'not_configured' });
  });
});

import { describe, it, expect } from 'vitest';
import { applicableRateForClass } from '@/application/applicable-rate';

describe('applicableRateForClass requires snapshot row from single snapshot', () => {
  const rateFields = {
    grade: 4,
    applicableAnqinBps: 9500,
    applicableTutoringBps: 9500,
    applicableMathBps: 9000,
    applicableEnglishBps: 8500,
  };

  const snapshots = new Map([
    // 快照為 english
    ['國小數學-四A', { base_name: '國小數學-四A', category: 'english', fixed_five_days: 0 }],
    // 寫功課，none
    ['國小輔導-寫功課', { base_name: '國小輔導-寫功課', category: 'none', fixed_five_days: 1 }],
  ]);

  it('reads the category row directly from single snapshot', () => {
    const res = applicableRateForClass('國小數學-四A', rateFields, {
      findSnapshot: (n) => snapshots.get(n),
    });
    expect(res).toEqual({ status: 'configured', bps: 8500 });
  });

  it('none class returns not_configured', () => {
    const res = applicableRateForClass('國小輔導-寫功課', rateFields, {
      findSnapshot: (n) => snapshots.get(n),
    });
    expect(res).toEqual({ status: 'not_configured' });
  });

  it('missing snapshot resolver returns not_configured', () => {
    expect(applicableRateForClass('國小數學-四A', rateFields))
      .toEqual({ status: 'not_configured' });
  });

  it('class not in snapshot returns not_configured without guessing by name', () => {
    expect(applicableRateForClass('未知班級', rateFields, {
      findSnapshot: (n) => snapshots.get(n),
    })).toEqual({ status: 'not_configured' });
  });
});

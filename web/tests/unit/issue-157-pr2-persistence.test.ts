import { describe, expect, it } from 'vitest';
import { gridRowsToClasses, type ClassSetting, type ScheduleGridRow } from '@/contracts/settings';
import { persistClassAttributes } from '@/domain/classification/persist-class-attributes';

function row(className: string): ScheduleGridRow {
  return {
    rowId: className,
    className,
    teacher: null,
    weekday: '',
    startTime: '',
    endTime: '',
    startMinutes: null,
    endMinutes: null,
    active: true,
    skipDeduction: false,
  };
}

function existingClass(
  baseName: string,
  category: ClassSetting['category'],
  categorySource: ClassSetting['categorySource'],
  fixedFiveDays = false
): ClassSetting {
  return {
    baseName,
    subject: '其他',
    teacher: null,
    active: true,
    sessions: [],
    classType: 'non_care',
    category,
    categorySource,
    fixedFiveDays,
  };
}

describe('Issue #157 PR-2：class attribute draft persistence', () => {
  it('shared writer emits only writable category sources and keeps an explicit fixed-five false', () => {
    expect(persistClassAttributes({ classType: 'care', category: 'none', categorySource: 'manual', fixedFiveDays: false }))
      .toEqual({ classType: 'care', category: 'none', categorySource: 'manual', fixedFiveDays: false });
    expect(persistClassAttributes({ category: 'unset', categorySource: 'unset' }))
      .toEqual({ category: 'unset', categorySource: 'unset' });
    expect(persistClassAttributes({ category: 'math', categorySource: 'seed' })).toEqual({});
    expect(persistClassAttributes({ category: 'english', categorySource: 'auto' })).toEqual({});
  });

  it('writes explicit unset and manual decisions, retains fixed false, and omits seed and legacy auto', () => {
    const rows = [row('明確撤回班'), row('明確不折扣班'), row('seed基準班'), row('舊auto班')];
    const existing = [
      existingClass('明確撤回班', 'unset', 'unset'),
      existingClass('明確不折扣班', 'none', 'manual'),
      existingClass('seed基準班', 'math', 'seed'),
      existingClass('舊auto班', 'english', 'auto'),
    ];

    const persisted = gridRowsToClasses(rows, existing);
    const byName = new Map(persisted.map((cls) => [cls.baseName, cls]));

    expect(byName.get('明確撤回班')).toMatchObject({
      category: 'unset',
      categorySource: 'unset',
      fixedFiveDays: false,
    });
    expect(byName.get('明確不折扣班')).toMatchObject({ category: 'none', categorySource: 'manual' });
    expect(byName.get('seed基準班')).not.toHaveProperty('category');
    expect(byName.get('seed基準班')).not.toHaveProperty('categorySource');
    expect(byName.get('舊auto班')).not.toHaveProperty('category');
    expect(byName.get('舊auto班')).not.toHaveProperty('categorySource');
  });
});

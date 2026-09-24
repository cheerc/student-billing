import { describe, it, expect } from 'vitest';
import { draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { SettingsDraft } from '@/contracts/settings';

const CARE = {
  anqin: { startMinutes: 780, endMinutes: 960 },
  tutoring: { startMinutes: 990, endMinutes: 1170 },
};

function baseDraft(): SettingsDraft {
  return {
    classes: [
      {
        baseName: '國小數學-一A',
        subject: '國小數學',
        teacher: null,
        active: true,
        sessions: [],
      },
    ],
    aliases: [],
    careWindows: CARE,
    effectiveFrom: null,
    effectiveTo: null,
  };
}

describe('N2: draftToScheduleOverride 空 sessions 語義', () => {
  it('sessions 為空的班級視為未變更，不產生覆寫（沿用 seed 時段）', () => {
    const override = draftToScheduleOverride(baseDraft());
    expect(override.size).toBe(0);
    expect(override.has('國小數學-一A')).toBe(false);
  });

  it('明確填寫時段的班級才產生覆寫', () => {
    const draft = baseDraft();
    draft.classes[0].sessions = [{ weekday: '四', startMinutes: 900, endMinutes: 990 }];
    const override = draftToScheduleOverride(draft);
    expect(override.size).toBe(1);
    expect(override.get('國小數學-一A')).toEqual([{ start: 900, end: 990, weekday: '四' }]);
  });
});

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

describe('09 §8.2.4（方案 A）：draftToScheduleOverride 空 sessions 語義', () => {
  it('active 班級 sessions 為空＝無時段：產生空覆寫（不退回 seed 時段）', () => {
    const override = draftToScheduleOverride(baseDraft());
    expect(override.size).toBe(1);
    expect(override.get('國小數學-一A')).toEqual([]);
  });

  it('停用班級（active=false）同為空覆寫（不扣天）', () => {
    const draft = baseDraft();
    draft.classes[0].active = false;
    draft.classes[0].sessions = [{ weekday: '四', startMinutes: 900, endMinutes: 990 }];
    expect(draftToScheduleOverride(draft).get('國小數學-一A')).toEqual([]);
  });

  it('班級不在 draft 內：沒有該 key（由計算端判 schedule_not_found，不退回 seed）', () => {
    const draft = baseDraft();
    draft.classes = [];
    expect(draftToScheduleOverride(draft).has('國小數學-一A')).toBe(false);
  });

  it('明確填寫時段的班級才產生覆寫', () => {
    const draft = baseDraft();
    draft.classes[0].sessions = [{ weekday: '四', startMinutes: 900, endMinutes: 990 }];
    const override = draftToScheduleOverride(draft);
    expect(override.size).toBe(1);
    expect(override.get('國小數學-一A')).toEqual([{ start: 900, end: 990, weekday: '四' }]);
  });
});

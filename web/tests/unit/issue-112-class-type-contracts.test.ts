import { describe, it, expect } from 'vitest';
import {
  resolveClassAttributes,
  carryAttributesOnRename,
  detectMergeConflicts,
  type ClassAttributesView,
  DEFAULT_CARE_CLASS_NAMES,
} from '@/domain/classification/class-attributes';
import { resolveClassEnrollment } from '@/domain/classification/class-category';
import {
  ClassSettingSchema,
  gridRowsToClasses,
  gridRowsToCalculateClasses,
  isSettingsDirty,
  type ScheduleGridRow,
} from '@/contracts/settings';

describe('Issue #112 PR-1A: 課程類型 (classType) 資料模型與屬性重構單元驗收', () => {
  describe('A3: 預設分流與 classType 資料模型', () => {
    it('seed 的 8 個 care_window 班級預設 classType 為 care', () => {
      for (const name of DEFAULT_CARE_CLASS_NAMES) {
        const attr = resolveClassAttributes(name);
        expect(attr.classType).toBe('care');
      }
    });

    it('其餘非 care_window 班級預設 classType 為 non_care', () => {
      const nonCareExamples = ['國小數學-四A', '兒童美語-Gino', '小六數學加強班', '正音A班'];
      for (const name of nonCareExamples) {
        const attr = resolveClassAttributes(name);
        expect(attr.classType).toBe('non_care');
      }
    });

    it('舊草稿向後相容：未帶 classType 時，若 baseName 在 8 個 care 班或 fixedFiveDays 為 true 則歸入 care，其餘歸入 non_care', () => {
      // 8 個 care 班之一且無 classType
      const r1 = resolveClassAttributes('國小輔導-四年級', {});
      expect(r1.classType).toBe('care');

      // 舊寫功課班（未帶 classType，但有歷史已存 fixedFiveDays: true）
      const r2 = resolveClassAttributes('自訂寫功課班', { fixedFiveDays: true });
      expect(r2.classType).toBe('care');

      // 一般班級（未帶 classType，fixedFiveDays: false）
      const r3 = resolveClassAttributes('國小數學-五B', { fixedFiveDays: false });
      expect(r3.classType).toBe('non_care');

      // 顯式 classType 優先
      const r4 = resolveClassAttributes('國小數學-五B', { classType: 'care' });
      expect(r4.classType).toBe('care');
      const r5 = resolveClassAttributes('國小輔導-四年級', { classType: 'non_care' });
      expect(r5.classType).toBe('non_care');
    });

    it('ClassSettingSchema 支援 classType，且已不含 fixedSource', () => {
      const parsed = ClassSettingSchema.parse({
        baseName: '測試班',
        subject: '國小輔導',
        classType: 'care',
        category: 'care',
        fixedFiveDays: true,
      });
      expect(parsed.classType).toBe('care');
      expect((parsed as any).fixedSource).toBeUndefined();
    });

    it('isSettingsDirty 可偵測 classType 的變更，且不再比對 fixedSource', () => {
      const baseRow: ScheduleGridRow = {
        rowId: 'r1',
        className: '測試班',
        teacher: null,
        weekday: '一',
        startTime: '13:00',
        endTime: '15:00',
        startMinutes: 780,
        endMinutes: 900,
        active: true,
        skipDeduction: false,
      };

      const baseline = {
        rows: [baseRow],
        aliases: [],
        classAttrs: [
          {
            className: '測試班',
            classType: 'non_care' as const,
            category: 'none' as const,
            categorySource: 'auto' as const,
            fixedFiveDays: false,
          },
        ],
      };

      // 相同屬性：not dirty
      expect(
        isSettingsDirty(baseline, [baseRow], [], [
          {
            className: '測試班',
            classType: 'non_care',
            category: 'none',
            categorySource: 'auto',
            fixedFiveDays: false,
          },
        ])
      ).toBe(false);

      // classType 變更：dirty
      expect(
        isSettingsDirty(baseline, [baseRow], [], [
          {
            className: '測試班',
            classType: 'care',
            category: 'none',
            categorySource: 'auto',
            fixedFiveDays: false,
          },
        ])
      ).toBe(true);
    });
  });

  describe('A5: 安親課輔班 sessions 強制為 []（specs/14 §3.6 & A5）', () => {
    it('gridRowsToClasses 與 gridRowsToCalculateClasses 對 classType === care 班級強制輸出 sessions: []', () => {
      const rows: ScheduleGridRow[] = [
        {
          rowId: 'row-care',
          className: '國小輔導-四年級',
          teacher: '玟君',
          weekday: '一',
          startTime: '13:00',
          endTime: '16:00',
          startMinutes: 780,
          endMinutes: 960,
          active: true,
          skipDeduction: false,
        },
        {
          rowId: 'row-noncare',
          className: '國小數學-四A',
          teacher: '張老師',
          weekday: '一',
          startTime: '16:30',
          endTime: '18:00',
          startMinutes: 990,
          endMinutes: 1080,
          active: true,
          skipDeduction: false,
        },
      ];

      const existingClasses = [
        { baseName: '國小輔導-四年級', subject: '國小輔導', teacher: '玟君', active: true, sessions: [], classType: 'care' as const },
        { baseName: '國小數學-四A', subject: '國小數學', teacher: '張老師', active: true, sessions: [], classType: 'non_care' as const },
      ];

      const saveClasses = gridRowsToClasses(rows, existingClasses as any);
      const careSave = saveClasses.find((c) => c.baseName === '國小輔導-四年級')!;
      const nonCareSave = saveClasses.find((c) => c.baseName === '國小數學-四A')!;
      expect(careSave.sessions).toEqual([]);
      expect(nonCareSave.sessions).toHaveLength(1);

      const calcClasses = gridRowsToCalculateClasses(rows, existingClasses as any);
      const careCalc = calcClasses.find((c) => c.baseName === '國小輔導-四年級')!;
      const nonCareCalc = calcClasses.find((c) => c.baseName === '國小數學-四A')!;
      expect(careCalc.sessions).toEqual([]);
      expect(nonCareCalc.sessions).toHaveLength(1);
    });
  });

  describe('A6, A7: 固定 5 天預設一律為 false，移除 auto 偵測與 fixedSource', () => {
    it('所有班級未手動指定時，fixedFiveDays 預設恆為 false（含寫功課與美安）', () => {
      expect(resolveClassAttributes('寫功課-一A').fixedFiveDays).toBe(false);
      expect(resolveClassAttributes('美安-三年級').fixedFiveDays).toBe(false);
      expect(resolveClassAttributes('國小輔導-美安').fixedFiveDays).toBe(false);
      expect(resolveClassAttributes('國小輔導-四年級').fixedFiveDays).toBe(false);
      expect(resolveClassAttributes('國小數學-四A').fixedFiveDays).toBe(false);
    });

    it('EffectiveClassAttributes 不再包含 fixedSource 欄位', () => {
      const attr = resolveClassAttributes('任何班級');
      expect((attr as any).fixedSource).toBeUndefined();
    });

    it('手動指定 fixedFiveDays: true 原樣保留', () => {
      const attr = resolveClassAttributes('寫功課-一A', { fixedFiveDays: true });
      expect(attr.fixedFiveDays).toBe(true);
    });

    it('gridRowsToClasses: existing.fixedFiveDays === false 時，輸出班級物件明確帶有 fixedFiveDays: false 屬性', () => {
      const rows: ScheduleGridRow[] = [
        {
          rowId: 'row-1',
          className: '測試班',
          teacher: null,
          weekday: '一',
          startTime: '16:30',
          endTime: '18:00',
          startMinutes: 990,
          endMinutes: 1080,
          active: true,
          skipDeduction: false,
        },
      ];
      const existingClasses = [
        {
          baseName: '測試班',
          subject: '測試',
          teacher: null,
          active: true,
          sessions: [],
          fixedFiveDays: false,
        },
      ];
      const result = gridRowsToClasses(rows, existingClasses as any);
      expect('fixedFiveDays' in result[0]).toBe(true);
      expect(result[0].fixedFiveDays).toBe(false);
    });

    it('resolveClassEnrollment: 未設定或未勾選時，寫功課/美安/一般班級的 fixedFiveDays 恆為 false（消除雙軌分歧）', () => {
      // 1. 無 classSettings（未對應或未指定）：寫功課、美安、一般班級皆為 false
      const unmappedHw = resolveClassEnrollment({ rawToken: '寫功課', baseName: '寫功課' });
      expect(unmappedHw.fixedFiveDays).toBe(false);
      expect(unmappedHw.category).toBe('none');

      const unmappedMeian = resolveClassEnrollment({ rawToken: '美安', baseName: '美安' });
      expect(unmappedMeian.fixedFiveDays).toBe(false);

      const unmappedCare = resolveClassEnrollment({ rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' });
      expect(unmappedCare.fixedFiveDays).toBe(false);

      // 2. 有 classSettings 但 cls.fixedFiveDays 未設定 (undefined) 或為 false
      const classSettingMap = new Map([
        ['國小輔導-寫功課', { category: 'none' as const }],
        ['美安-三年級', { category: 'none' as const, fixedFiveDays: false }],
        ['特設五天班', { fixedFiveDays: true }],
      ]);

      const mappedHw = resolveClassEnrollment(
        { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
        undefined,
        classSettingMap
      );
      expect(mappedHw.fixedFiveDays).toBe(false);

      const mappedMeian = resolveClassEnrollment(
        { rawToken: '美安-三年級', baseName: '美安-三年級' },
        undefined,
        classSettingMap
      );
      expect(mappedMeian.fixedFiveDays).toBe(false);

      const mappedExplicit = resolveClassEnrollment(
        { rawToken: '特設五天班', baseName: '特設五天班' },
        undefined,
        classSettingMap
      );
      expect(mappedExplicit.fixedFiveDays).toBe(true);

      // 3. 雙軌一致性驗證：resolveClassEnrollment 與 resolveClassAttributes 針對寫功課的 fixedFiveDays 判定完全一致（皆為 false）
      expect(mappedHw.fixedFiveDays).toBe(resolveClassAttributes('國小輔導-寫功課').fixedFiveDays);
    });
  });

  describe('A12: 班級生命週期與屬性繼承', () => {
    it('整班改名時 classType 與 fixedFiveDays 原值隨班帶到新班名', () => {
      const currentAttrs = new Map<string, ClassAttributesView>([
        [
          '舊安親班',
          {
            classType: 'care',
            category: 'care',
            categorySource: 'manual',
            fixedFiveDays: true,
          },
        ],
      ]);
      const baselineAttrs = new Map<string, ClassAttributesView>();

      const out = carryAttributesOnRename(
        [{ from: '舊安親班', to: '新安親班' }],
        currentAttrs,
        baselineAttrs
      );

      expect(out.get('新安親班')).toEqual({
        classType: 'care',
        category: 'care',
        categorySource: 'manual',
        fixedFiveDays: true,
      });
    });

    it('同名合併時若 classType 不同，產生衝突並阻擋儲存', () => {
      const sourceAttrs = new Map<string, ClassAttributesView>([
        [
          '班級A',
          {
            classType: 'care',
            category: 'care',
            categorySource: 'auto',
            fixedFiveDays: false,
          },
        ],
        [
          '班級B',
          {
            classType: 'non_care',
            category: 'care',
            categorySource: 'auto',
            fixedFiveDays: false,
          },
        ],
      ]);

      const conflicts = detectMergeConflicts(
        [{ mergedName: '合併班', sources: ['班級A', '班級B'] }],
        sourceAttrs
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].mergedName).toBe('合併班');
    });

    it('同名合併時若 fixedFiveDays 不同，產生衝突並阻擋儲存', () => {
      const sourceAttrs = new Map<string, ClassAttributesView>([
        [
          '班級A',
          {
            classType: 'care',
            category: 'care',
            categorySource: 'auto',
            fixedFiveDays: true,
          },
        ],
        [
          '班級B',
          {
            classType: 'care',
            category: 'care',
            categorySource: 'auto',
            fixedFiveDays: false,
          },
        ],
      ]);

      const conflicts = detectMergeConflicts(
        [{ mergedName: '合併班', sources: ['班級A', '班級B'] }],
        sourceAttrs
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].mergedName).toBe('合併班');
    });
  });
});

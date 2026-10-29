import { describe, it, expect } from 'vitest';
import { buildSeedGridRows, gridRowsToClasses, SettingsDraftSchema } from '@/contracts/settings';
import { applyManualAttrsToClasses } from '@/domain/classification/persist-class-attributes';
import { stageNewClassFromRoster } from '@/domain/schedules/class-name-sync';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';

/**
 * #189 D62 Phase 2：由「班名同步」→「新增為課表班級」建立的班級必須能存檔。
 *
 * 真實失敗（E2E `class-name-sync.spec.ts`）：新增「交通車」為「不排課」→ 確認變更 →
 * 伺服器回 400 INVALID_DRAFT「此課程類型不支援待補時段」，儲存按鈕永久 disabled。
 * 成因：`gridRowsToClasses` 以「尚無設定」的班名先解析成 `other`（可排課），因此產生
 * `incompleteSessions`；`applyManualAttrsToClasses` 之後才把 classType 改寫成 `unscheduled`／`care`，
 * 卻沒有同步移除那些時段欄位，於是違反 `ClassSettingSchema` 的類型限制。
 *
 * 預期（規格）：不排課與安親課輔班不帶任何時段／待補時段；可排課類型（美語／數學／其他）
 * 仍保留「星期未定」的待補列，維持 1c 待補時間警示。
 */
describe('#189：班名同步新增班級的草稿序列化', () => {
  function serializeNewClass(erpBaseName: string, classType: 'unscheduled' | 'math' | 'care' | 'english' | 'other') {
    const draft = buildSeedDraft();
    const staged = stageNewClassFromRoster(buildSeedGridRows(), { erpBaseName, classType });
    const manualAttrs = new Map([
      [
        erpBaseName,
        {
          classType,
          category: 'unset' as const,
          categorySource: 'unset' as const,
          hasMultiSubjectDiscount: classType === 'care' || classType === 'english' || classType === 'math',
          fixedFiveDays: false,
        },
      ],
    ]);
    const classes = applyManualAttrsToClasses(gridRowsToClasses(staged.rows, draft.classes), manualAttrs);
    const cls = classes.find((c) => c.baseName === erpBaseName);
    return { draft, classes, cls };
  }

  it('新增「不排課」班級不含時段與待補時段，草稿通過存檔契約', () => {
    const { draft, classes, cls } = serializeNewClass('交通車', 'unscheduled');

    expect(cls).toBeDefined();
    expect(cls!.classType).toBe('unscheduled');
    expect(cls!.sessions).toHaveLength(0);
    expect(cls!.incompleteSessions).toBeUndefined();

    const parsed = SettingsDraftSchema.safeParse({ ...draft, classes });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it('新增「安親課輔班」也不含時段（與不排課同一條類型限制）', () => {
    const { draft, classes, cls } = serializeNewClass('安親新生班', 'care');

    expect(cls).toBeDefined();
    expect(cls!.classType).toBe('care');
    expect(cls!.sessions).toHaveLength(0);
    expect(cls!.incompleteSessions).toBeUndefined();

    const parsed = SettingsDraftSchema.safeParse({ ...draft, classes });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it('新增「數學班」保留一列星期未定的待補時段（1c 待補時間警示的來源）', () => {
    const { draft, classes, cls } = serializeNewClass('國小數學-一', 'math');

    expect(cls).toBeDefined();
    expect(cls!.classType).toBe('math');
    expect(cls!.sessions).toHaveLength(0);
    expect(cls!.incompleteSessions).toHaveLength(1);
    expect(cls!.incompleteSessions![0].weekday).toBe('');

    const parsed = SettingsDraftSchema.safeParse({ ...draft, classes });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });
});

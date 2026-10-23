import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_CLASS_TYPE_DEFINITIONS,
  ClassTypeDefinitionSchema,
  SettingsDraftSchema,
  type ClassTypeDefinition,
} from '@/contracts/settings';
import { deriveSubject, SEED_CLASSES, SEED_CLASS_CATEGORIES } from '@/domain/schedules/seed-manifest';
import {
  carryClassSemanticsOnRename,
  clearUnsupportedClassSemantics,
  detectSemanticMergeConflicts,
  normalizeSettingsDraftSemantics,
  SEED_CLASS_SEMANTICS,
} from '@/domain/classification/class-semantics';
import { ClassSemanticsPanel } from '@/components/settings/class-semantics-panel';

const CARE_WINDOWS = {
  anqin: { startMinutes: 780, endMinutes: 960 },
  tutoring: { startMinutes: 990, endMinutes: 1170 },
};

describe('PR-3 bounded class semantics contract', () => {
  it('supports a data-only timetable type and keeps classType, category, subject and roles independent', () => {
    const studyRoom: ClassTypeDefinition = {
      id: 'study_room',
      label: '自習教室',
      scheduleMode: 'timetable',
      supportedAttributeKeys: ['subject', 'category', 'skipDeduction', 'summaryDayRoles', 'erpTierApplicability'],
      summaryRoleOptions: ['mathDays', 'homeworkDays'],
    };
    const draft = SettingsDraftSchema.parse({
      classes: [{
        baseName: '1234班',
        subject: '自習課程',
        teacher: null,
        active: true,
        sessions: [{ weekday: '三', startMinutes: 600, endMinutes: 660 }],
        classTypeId: studyRoom.id,
        category: 'none',
        categorySource: 'manual',
        summaryDayRoles: ['homeworkDays'],
        summaryDayRolesStatus: 'configured',
        summaryDayRolesSource: 'manual',
        erpTierApplicability: 'not_applicable',
        erpTierApplicabilitySource: 'manual',
      }],
      classTypeDefinitions: [...DEFAULT_CLASS_TYPE_DEFINITIONS, studyRoom],
      aliases: [],
      careWindows: CARE_WINDOWS,
      effectiveFrom: null,
      effectiveTo: null,
    });

    const normalized = normalizeSettingsDraftSemantics(draft);
    expect(normalized.classes[0]).toMatchObject({
      baseName: '1234班',
      subject: '自習課程',
      classTypeId: 'study_room',
      category: 'none',
      summaryDayRoles: ['homeworkDays'],
      erpTierApplicability: 'not_applicable',
    });
    expect(normalized.classTypeDefinitions?.find((definition) => definition.id === 'study_room')?.scheduleMode)
      .toBe('timetable');
    expect(SettingsDraftSchema.parse(JSON.parse(JSON.stringify(draft))).classes[0].summaryDayRoles).toEqual(['homeworkDays']);
  });

  it('rejects an unknown type id, unsupported schedule mode and roles outside the bounded type options', () => {
    const base = {
      classes: [{ baseName: '1234班', subject: '其他', sessions: [], classTypeId: 'missing_type' }],
      classTypeDefinitions: DEFAULT_CLASS_TYPE_DEFINITIONS,
      aliases: [],
      careWindows: CARE_WINDOWS,
    };
    expect(SettingsDraftSchema.safeParse(base).success).toBe(false);
    expect(SettingsDraftSchema.safeParse({
      ...base,
      classes: [{ baseName: '1234班', subject: '其他', sessions: [], classTypeId: 'care' }],
      classTypeDefinitions: [...DEFAULT_CLASS_TYPE_DEFINITIONS, {
        id: 'bad_mode', label: '錯誤', scheduleMode: 'custom_formula',
        supportedAttributeKeys: [], summaryRoleOptions: [],
      }],
    }).success).toBe(false);
    const referenced = {
      classes: [{ baseName: 'A班', subject: '', classTypeId: 'study_room', sessions: [] }],
      classTypeDefinitions: [...DEFAULT_CLASS_TYPE_DEFINITIONS, {
        id: 'study_room', label: '自習教室', scheduleMode: 'timetable' as const,
        supportedAttributeKeys: ['subject' as const], summaryRoleOptions: [],
      }],
      aliases: [], careWindows: CARE_WINDOWS,
    };
    // Type labels may be renamed without changing the stable id; deleting a referenced id is rejected.
    expect(SettingsDraftSchema.safeParse({
      ...referenced,
      classTypeDefinitions: referenced.classTypeDefinitions.map((item) =>
        item.id === 'study_room' ? { ...item, label: '讀書室' } : item
      ),
    }).success).toBe(true);
    expect(SettingsDraftSchema.safeParse({
      ...referenced,
      classTypeDefinitions: DEFAULT_CLASS_TYPE_DEFINITIONS,
    }).success).toBe(false);
    expect(SettingsDraftSchema.safeParse({
      ...referenced,
      classes: [{ ...referenced.classes[0], classType: 'care' }],
    }).success).toBe(false);
    expect(SettingsDraftSchema.safeParse({
      ...referenced,
      classes: [{ ...referenced.classes[0], classType: 'non_care' }],
    }).success).toBe(true);
    expect(SettingsDraftSchema.safeParse({
      ...base,
      classes: [{ baseName: '1234班', subject: '其他', sessions: [], classTypeId: 'study_room', summaryDayRoles: ['saturdayTutoringDays'] }],
      classTypeDefinitions: [...DEFAULT_CLASS_TYPE_DEFINITIONS, {
        id: 'study_room', label: '自習教室', scheduleMode: 'timetable',
        supportedAttributeKeys: ['subject', 'summaryDayRoles'], summaryRoleOptions: ['mathDays'],
      }],
    }).success).toBe(false);
  });

  it('has an explicit synthetic semantics row for each of the 49 existing seed classes', () => {
    expect(SEED_CLASSES).toHaveLength(49);
    expect(SEED_CLASS_SEMANTICS.size).toBe(49);
    expect([...SEED_CLASS_SEMANTICS.keys()].sort()).toEqual(SEED_CLASSES.map((item) => item.baseName).sort());
    for (const [baseName, semantics] of SEED_CLASS_SEMANTICS) {
      expect(semantics.category).toBe(SEED_CLASS_CATEGORIES.get(baseName));
      expect(semantics.subject).toBe(deriveSubject(baseName));
      expect(semantics.summaryDayRoles.every((role) =>
        DEFAULT_CLASS_TYPE_DEFINITIONS.some((definition) => definition.summaryRoleOptions.includes(role))
      )).toBe(true);
    }
  });

  it('hydrates old settings with a read-only built-in type map and explicit unset for non-seed semantics', () => {
    const legacyDraft = SettingsDraftSchema.parse({
      classes: [
        { baseName: '國小數學-一A', subject: '舊課程', sessions: [], classType: 'non_care' },
        { baseName: '1234班', subject: '自訂課程', sessions: [], classType: 'non_care' },
      ],
      aliases: [],
      careWindows: CARE_WINDOWS,
    });
    const hydrated = normalizeSettingsDraftSemantics(legacyDraft);
    expect(hydrated.classTypeDefinitions).toEqual(DEFAULT_CLASS_TYPE_DEFINITIONS);
    expect(hydrated.classes[0]).toMatchObject({
      classTypeId: 'non_care',
      summaryDayRoles: ['mathDays'],
      summaryDayRolesStatus: 'configured',
      summaryDayRolesSource: 'seed',
      erpTierApplicability: 'not_applicable',
      erpTierApplicabilitySource: 'seed',
    });
    expect(hydrated.classes[1]).toMatchObject({
      classTypeId: 'non_care',
      subject: '自訂課程',
      summaryDayRoles: [],
      summaryDayRolesStatus: 'unset',
      summaryDayRolesSource: 'unset',
      erpTierApplicability: 'unset',
      erpTierApplicabilitySource: 'unset',
    });
  });

  it('uses fixedFiveDays only for the explicit legacy hydration path and requires a type in new settings', () => {
    const old = normalizeSettingsDraftSemantics(SettingsDraftSchema.parse({
      classes: [{ baseName: '舊班', subject: '', fixedFiveDays: true, sessions: [] }],
      aliases: [], careWindows: CARE_WINDOWS,
    }));
    expect(old.classes[0].classTypeId).toBe('care');

    const newDraft = {
      classes: [{ baseName: '新班', subject: '', fixedFiveDays: true, sessions: [] }],
      classTypeDefinitions: [...DEFAULT_CLASS_TYPE_DEFINITIONS],
      aliases: [], careWindows: CARE_WINDOWS,
    };
    expect(SettingsDraftSchema.safeParse(newDraft).success).toBe(false);
  });

  it('keeps legacy flags through repeated read normalization while writes keep unsupported true blocked', () => {
    const historical = normalizeSettingsDraftSemantics({
      classes: [
        { baseName: '舊非安親班 false', subject: '', classType: 'non_care', fixedFiveDays: false, sessions: [] },
        { baseName: '舊非安親班 true', subject: '', classType: 'non_care', fixedFiveDays: true, sessions: [] },
      ],
      aliases: [], careWindows: CARE_WINDOWS,
    });
    const editorDraft = normalizeSettingsDraftSemantics(historical);
    expect(editorDraft.classes.map((item) => item.fixedFiveDays)).toEqual([false, true]);
    expect(SettingsDraftSchema.safeParse(editorDraft).success).toBe(false);
    const html = renderToStaticMarkup(React.createElement(ClassSemanticsPanel, {
      classes: editorDraft.classes,
      definitions: editorDraft.classTypeDefinitions,
      onUpdateClass: () => {},
      onClearUnsupported: () => {},
      onUpdateDefinition: () => {},
      onAddDefinition: () => {},
      onDeleteDefinition: () => {},
    }));
    expect(html).toContain('此班已有未受課程類型支援的設定');
    expect(html).toContain('清除未支援的設定');

    const neutral = {
      classes: [{ baseName: '合成課程', subject: '', classTypeId: 'non_care', classType: 'non_care', fixedFiveDays: false, sessions: [] }],
      classTypeDefinitions: [...DEFAULT_CLASS_TYPE_DEFINITIONS], aliases: [], careWindows: CARE_WINDOWS,
    };
    expect(SettingsDraftSchema.safeParse(neutral).success).toBe(true);
    expect(SettingsDraftSchema.safeParse({
      ...neutral,
      classes: [{ ...neutral.classes[0], fixedFiveDays: true }],
    }).success).toBe(false);
  });

  it('carries configured semantics on rename, preserves an existing merge target and detects conflicting merges', () => {
    const source = {
      baseName: '原班', subject: '科目甲', subjectSource: 'manual' as const,
      teacher: null, active: true,
      classTypeId: 'non_care', classType: 'non_care' as const, sessions: [],
      summaryDayRoles: ['homeworkDays' as const], summaryDayRolesStatus: 'configured' as const,
      summaryDayRolesSource: 'manual' as const, erpTierApplicability: 'unset' as const,
      erpTierApplicabilitySource: 'unset' as const,
    };
    const target = { ...source, baseName: '新班', subject: '', subjectSource: 'unset' as const, summaryDayRoles: [] };
    const renamed = carryClassSemanticsOnRename([target], [source], [{ from: '原班', to: '新班' }], new Set());
    expect(renamed[0]).toMatchObject({ subject: '科目甲', summaryDayRoles: ['homeworkDays'], summaryDayRolesSource: 'manual' });

    const existing = { ...source, baseName: '既有目標', subject: '目標科目' };
    const preserved = carryClassSemanticsOnRename([existing], [source], [{ from: '原班', to: '既有目標' }], new Set(['既有目標']));
    expect(preserved[0].subject).toBe('目標科目');
    expect(detectSemanticMergeConflicts([{ mergedName: '合併班', sources: ['原班', '另一班'] }], [
      source, { ...source, baseName: '另一班', subject: '科目乙' },
    ])).toHaveLength(1);
  });

  it('carries seed-derived semantics with the class when a seed class is renamed', () => {
    const seedName = '國小數學-一A';
    const seedSemantics = SEED_CLASS_SEMANTICS.get(seedName)!;
    const source = {
      baseName: seedName, subject: seedSemantics.subject, subjectSource: 'seed' as const,
      teacher: null, active: true, sessions: [], classTypeId: seedSemantics.classTypeId,
      classType: 'non_care' as const, category: 'math' as const, categorySource: 'seed' as const,
      summaryDayRoles: seedSemantics.summaryDayRoles, summaryDayRolesStatus: 'configured' as const,
      summaryDayRolesSource: 'seed' as const,
      erpTierApplicability: seedSemantics.erpTierApplicability,
      erpTierApplicabilitySource: 'seed' as const,
    };
    const renamed = carryClassSemanticsOnRename(
      [{ ...source, baseName: '自訂名稱', subject: '', summaryDayRoles: [] }],
      [source],
      [{ from: seedName, to: '自訂名稱' }],
      new Set()
    );
    expect(renamed[0]).toMatchObject({
      subject: seedSemantics.subject, subjectSource: 'seed',
      summaryDayRoles: seedSemantics.summaryDayRoles, summaryDayRolesSource: 'seed',
      erpTierApplicability: seedSemantics.erpTierApplicability, erpTierApplicabilitySource: 'seed',
    });
  });

  it('requires an explicit clear when a class type no longer supports saved values', () => {
    const type: ClassTypeDefinition = {
      id: 'subject_only',
      label: '只設科目',
      scheduleMode: 'timetable',
      supportedAttributeKeys: ['subject'],
      summaryRoleOptions: [],
    };
    const saved = {
      baseName: '合成班', subject: '保留科目', subjectSource: 'manual' as const,
      teacher: null, active: true,
      sessions: [{ weekday: '三', startMinutes: 600, endMinutes: 660, skipDeduction: true }],
      classTypeId: type.id, classType: 'non_care' as const,
      category: 'math' as const, categorySource: 'manual' as const, fixedFiveDays: true,
      summaryDayRoles: ['mathDays' as const], summaryDayRolesStatus: 'configured' as const,
      summaryDayRolesSource: 'manual' as const,
      erpTierApplicability: 'applicable' as const, erpTierApplicabilitySource: 'manual' as const,
    };
    const cleared = clearUnsupportedClassSemantics(saved, type);

    expect(cleared).toMatchObject({
      subject: '保留科目', subjectSource: 'manual',
      category: 'unset', categorySource: 'unset',
      summaryDayRoles: [], summaryDayRolesStatus: 'unset', summaryDayRolesSource: 'unset',
      erpTierApplicability: 'unset', erpTierApplicabilitySource: 'unset',
      sessions: [{ skipDeduction: false }],
    });
    expect(cleared.fixedFiveDays).toBeUndefined();
    expect(SettingsDraftSchema.parse({
      classes: [cleared],
      classTypeDefinitions: [...DEFAULT_CLASS_TYPE_DEFINITIONS, type],
      aliases: [], careWindows: CARE_WINDOWS,
    }).classes[0].classTypeId).toBe('subject_only');
  });

  it('shows a clear action when saved values are unsupported by the selected class type', () => {
    const definition: ClassTypeDefinition = {
      id: 'subject_only',
      label: '只設科目',
      scheduleMode: 'timetable',
      supportedAttributeKeys: ['subject', 'summaryDayRoles'],
      summaryRoleOptions: ['mathDays'],
    };
    const html = renderToStaticMarkup(React.createElement(ClassSemanticsPanel, {
      classes: [{
        baseName: '合成班', subject: '', teacher: null, active: true, sessions: [],
        classTypeId: definition.id, classType: 'non_care', category: 'math', fixedFiveDays: true,
        summaryDayRoles: ['mathDays', 'homeworkDays'], summaryDayRolesStatus: 'configured',
        erpTierApplicability: 'applicable',
      }],
      definitions: [definition],
      onUpdateClass: () => {},
      onClearUnsupported: () => {},
      onUpdateDefinition: () => {},
      onAddDefinition: () => {},
      onDeleteDefinition: () => {},
    }));

    expect(html).toContain('此班已有未受課程類型支援的設定');
    expect(html).toContain('摘要角色選項：寫功課天數');
    expect(html).toContain('清除未支援的設定');
  });

  it('clears only summary roles removed from a class type option list', () => {
    const definition: ClassTypeDefinition = {
      id: 'math_summary_only',
      label: '數學摘要限定',
      scheduleMode: 'timetable',
      supportedAttributeKeys: ['summaryDayRoles'],
      summaryRoleOptions: ['mathDays'],
    };
    const saved = {
      baseName: '合成班', subject: '', teacher: null, active: true, sessions: [],
      classTypeId: definition.id, classType: 'non_care' as const,
      summaryDayRoles: ['mathDays', 'homeworkDays'] as ['mathDays', 'homeworkDays'],
      summaryDayRolesStatus: 'configured' as const,
      summaryDayRolesSource: 'manual' as const,
    };
    const invalid = {
      classes: [saved], classTypeDefinitions: [...DEFAULT_CLASS_TYPE_DEFINITIONS, definition], aliases: [], careWindows: CARE_WINDOWS,
    };
    expect(SettingsDraftSchema.safeParse(invalid).success).toBe(false);

    const cleared = clearUnsupportedClassSemantics(saved, definition);
    expect(cleared).toMatchObject({
      summaryDayRoles: ['mathDays'],
      summaryDayRolesStatus: 'configured',
      summaryDayRolesSource: 'manual',
    });
    expect(SettingsDraftSchema.safeParse({ ...invalid, classes: [cleared] }).success).toBe(true);
  });

  it('rejects type definitions whose mode has no matching editable control', () => {
    expect(ClassTypeDefinitionSchema.safeParse({
      id: 'care_with_skip', label: '不相容安親', scheduleMode: 'care_window',
      supportedAttributeKeys: ['skipDeduction'], summaryRoleOptions: [],
    }).success).toBe(false);
    expect(ClassTypeDefinitionSchema.safeParse({
      id: 'timetable_fixed', label: '不相容課表', scheduleMode: 'timetable',
      supportedAttributeKeys: ['fixedFiveDays'], summaryRoleOptions: [],
    }).success).toBe(false);
  });
});

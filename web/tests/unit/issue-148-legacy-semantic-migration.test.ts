import { describe, expect, it } from 'vitest';
import type { ClassSetting } from '@/contracts/settings';
import {
  migrateLegacyClassSemantics,
  previewLegacyClassSemanticsMigration,
} from '@/domain/classification/legacy-semantic-migration';
import { projectSummaryDayValues } from '@/application/summary-day-values';
import { buildClassSettingMap } from '@/application/calculate-run';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { resolveClassEnrollment } from '@/domain/classification/class-category';

function legacyClass(baseName: string): ClassSetting {
  return {
    baseName,
    subject: '',
    teacher: null,
    active: true,
    sessions: [],
    classType: 'non_care',
  };
}

describe('issue #148 approved one-time legacy semantic migration', () => {
  it('converts only explicitly selected legacy non-seed classes and preserves #157 category state', () => {
    const source = [
      legacyClass('國小數學-自訂'),
      { ...legacyClass('自訂安親班'), category: 'unset' as const, categorySource: 'unset' as const },
      { ...legacyClass('現代數學班'), summaryDayRoles: [], summaryDayRolesStatus: 'configured' as const, summaryDayRolesSource: 'manual' as const, erpTierApplicability: 'unset' as const, erpTierApplicabilitySource: 'unset' as const },
      legacyClass('國小輔導-一A'),
    ];
    const result = migrateLegacyClassSemantics(source, new Map(['國小數學-自訂', '自訂安親班'].map((baseName) => [baseName, {
      baseName,
      migrateSummaryDayRoles: true,
      migrateErpTierApplicability: true,
    }])));

    expect(result.classes[0]).toMatchObject({
      summaryDayRoles: ['mathDays'],
      summaryDayRolesStatus: 'configured',
      summaryDayRolesSource: 'legacy_migration',
      erpTierApplicability: 'not_applicable',
      erpTierApplicabilitySource: 'legacy_migration',
    });
    expect(result.classes[1]).toMatchObject({
      category: 'unset',
      categorySource: 'unset',
      erpTierApplicability: 'applicable',
      erpTierApplicabilitySource: 'legacy_migration',
    });
    expect(result.classes[2].summaryDayRolesSource).toBe('manual');
    expect(result.classes[3].summaryDayRolesSource).toBeUndefined();
    expect(result.migratedClassCount).toBe(2);
  });

  it('captures the legacy Saturday token condition as bounded metadata', () => {
    const result = migrateLegacyClassSemantics(
      [legacyClass('加強班')],
      new Map([['加強班', { baseName: '加強班', migrateSummaryDayRoles: true, migrateErpTierApplicability: true }]])
    );
    expect(result.classes[0]).toMatchObject({
      summaryDayRoles: ['saturdayTutoringDays'],
      summaryDayRoleConditions: [{ role: 'saturdayTutoringDays', condition: 'raw_token_contains_six' }],
    });

    const rows = [
      { rawToken: '加強班-數學[六]', baseName: '加強班' },
      { rawToken: '加強班-數學[二]', baseName: '加強班' },
    ];
    const classSettings = new Map([['加強班', {
      summaryDayRoles: result.classes[0].summaryDayRoles,
      summaryDayRolesStatus: result.classes[0].summaryDayRolesStatus,
      summaryDayRoleConditions: result.classes[0].summaryDayRoleConditions,
    }]]);
    expect(projectSummaryDayValues(rows, classSettings, undefined, () => undefined).saturdayTutoringDays).toBe(1);
    expect(projectSummaryDayValues([rows[1]], classSettings, undefined, () => undefined).saturdayTutoringDays).toBeNull();
  });

  it('builds an anonymous, read-only recommendation row before the operator creates the migration draft', () => {
    const result = previewLegacyClassSemanticsMigration(
      [legacyClass('私人識別內容-國小數學A')],
      new Map([['私人識別內容-國小數學A', {
        baseName: '私人識別內容-國小數學A',
        migrateSummaryDayRoles: true,
        migrateErpTierApplicability: true,
      }]])
    );

    expect(result).toMatchObject({
      summary: { migratedClassCount: 1, migratedSummaryRoleClassCount: 1, migratedTierApplicabilityClassCount: 1 },
      rows: [{
        anonymousClassLabel: '舊班 1',
        summaryDayRolesBefore: null,
        summaryDayRolesAfter: ['mathDays'],
        erpTierApplicabilityBefore: null,
        erpTierApplicabilityAfter: 'not_applicable',
      }],
    });
    expect(JSON.stringify(result)).not.toContain('私人識別內容');
  });

  it('includes unmatched roster names in the anonymous migration recommendation', () => {
    const result = previewLegacyClassSemanticsMigration([], new Map([['私人安親班', {
      baseName: '私人安親班',
      migrateSummaryDayRoles: true,
      migrateErpTierApplicability: true,
    }]]));

    expect(result.rows).toEqual([{
      anonymousClassLabel: '舊班 1',
      summaryDayRolesBefore: null,
      summaryDayRolesAfter: [],
      summaryDayRoleConditionsAfter: [],
      erpTierApplicabilityBefore: null,
      erpTierApplicabilityAfter: 'applicable',
    }]);
    expect(JSON.stringify(result)).not.toContain('私人安親班');
  });

  it('preserves legacy semantics for a removed seed class without remapping it or assigning a category', () => {
    const migrated = migrateLegacyClassSemantics([], new Map([['國小數學-二B', {
      baseName: '國小數學-二B',
      migrateSummaryDayRoles: true,
      migrateErpTierApplicability: true,
    }]]));
    const classSettings = buildClassSettingMap({ ...buildSeedDraft(), classes: migrated.classes });
    const resolved = resolveClassEnrollment(
      { rawToken: '國小數學-二B[團]', baseName: '國小數學-二B' },
      undefined,
      classSettings
    );

    expect(migrated.classes[0]).toMatchObject({
      semanticOnly: true,
      category: 'unset',
      categorySource: 'unset',
      summaryDayRoles: ['mathDays'],
      erpTierApplicability: 'not_applicable',
    });
    expect(resolved).toMatchObject({ mapped: false, category: 'unset', summaryDayRoles: ['mathDays'], erpTierApplicability: 'not_applicable' });
  });
});

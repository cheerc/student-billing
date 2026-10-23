import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { hashSettingsDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { queryImportStudents } from '@/application/roster-query';
import { parseSingleClassToken } from '@/domain/students/token-parser';
import type { StudentSnapshot } from '@/domain/students';

describe('issue #148 ready import tier preview', () => {
  it('projects and filters tiers from settings while leaving imported enrollment evidence unchanged', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      const now = '2026-10-23T00:00:00.000Z';
      const draft = buildSeedDraft();
      draft.classes.push({
        baseName: '明確目標',
        subject: '',
        subjectSource: 'unset',
        teacher: null,
        active: true,
        sessions: [],
        classTypeId: 'non_care',
        classType: 'non_care',
        category: 'unset',
        categorySource: 'unset',
        summaryDayRoles: [],
        summaryDayRolesStatus: 'configured',
        summaryDayRolesSource: 'manual',
        erpTierApplicability: 'applicable',
        erpTierApplicabilitySource: 'manual',
      });
      draft.aliases.push({ rawBaseName: '原始別名', targetBaseName: '明確目標' });
      const contentJson = JSON.stringify(draft);
      saveSettingsVersion(db, {
        id: 'settings_issue148',
        contentHash: hashSettingsDraft(draft),
        contentJson,
        effectiveFrom: null,
        effectiveTo: null,
        createdAt: now,
        createdFromPreviewId: null,
        revision: 1,
      });

      const students: StudentSnapshot[] = [
        {
          personCode: 'SYNTH-001', name: '合成學生一', branch: null, gradeRaw: '4', grade: 4,
          gradeStatus: 'valid', contact: null, schoolInfo: null, tagsRaw: '', tags: [], notesRaw: '',
          sourceRow: 1, enrollments: [parseSingleClassToken('原始別名[團][4_5]')],
        },
        {
          personCode: 'SYNTH-002', name: '合成學生二', branch: null, gradeRaw: '4', grade: 4,
          gradeStatus: 'valid', contact: null, schoolInfo: null, tagsRaw: '', tags: [], notesRaw: '',
          sourceRow: 2, enrollments: [parseSingleClassToken('未設定班[團][4_5]')],
        },
      ];
      saveImportBatch(db, {
        id: 'imp_issue148', fileName: 'synthetic.xlsx', fileHash: 'synthetic-file',
        contentHash: 'synthetic-content', sheetName: 'Sheet1', headerMap: {}, parserVersion: '1',
        scopeNote: '', rowCount: students.length, status: 'ready', createdAt: now,
      }, students);

      const page = queryImportStudents(db, 'imp_issue148', { limit: 10 });
      expect(page.tierPreviewSource).toBe('latest_settings');
      expect(page.items[0].enrollments[0]).toMatchObject({
        erpBillingTier: null,
        tierParseStatus: 'unavailable',
        previewErpBillingTier: 4.5,
        previewTierParseStatus: 'parsed',
      });
      expect(page.items[1].enrollments[0]).toMatchObject({
        erpBillingTier: null,
        previewErpBillingTier: null,
        previewTierParseStatus: 'unavailable',
      });

      const filtered = queryImportStudents(db, 'imp_issue148', { previewErpBillingTier: 4.5 });
      expect(filtered.items.map((item) => item.personCode)).toEqual(['SYNTH-001']);
      expect(db.prepare('SELECT erp_billing_tier, tier_parse_status FROM student_enrollments ORDER BY person_code').all())
        .toEqual([
          { erp_billing_tier: null, tier_parse_status: 'unavailable' },
          { erp_billing_tier: null, tier_parse_status: 'unavailable' },
        ]);
    } finally {
      db.close();
    }
  });
});

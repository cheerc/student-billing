import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  deriveErpTierApplicability,
  resolveClassEnrollment,
  type ClassSettingLookup,
} from '@/domain/classification/class-category';
import { executeCalculationRun } from '@/application/calculate-run';
import { loadRunClassCategories } from '@/application/applicable-rate';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveCalculationRun, getCalculationRun } from '@/adapters/sqlite/runs-repository';

describe('Issue #177 Phase 1: deriveErpTierApplicability', () => {
  it('derives applicable only when mapped, care, and not fixed 5 days', () => {
    // Care timetable class: applicable
    expect(
      deriveErpTierApplicability({
        mapped: true,
        classType: 'care',
        fixedFiveDays: false,
      })
    ).toBe('applicable');

    // Care class with fixed 5 days: not applicable to tier parsing (defaults to 5)
    expect(
      deriveErpTierApplicability({
        mapped: true,
        classType: 'care',
        fixedFiveDays: true,
      })
    ).toBe('not_applicable');

    // Non-care class: not applicable
    expect(
      deriveErpTierApplicability({
        mapped: true,
        classType: 'non_care',
        fixedFiveDays: false,
      })
    ).toBe('not_applicable');

    // Unmapped care class: not applicable (unmapped emits CLASS_NOT_MAPPED, no tier)
    expect(
      deriveErpTierApplicability({
        mapped: false,
        classType: 'care',
        fixedFiveDays: false,
      })
    ).toBe('not_applicable');

    // Unmapped non-care class: not applicable
    expect(
      deriveErpTierApplicability({
        mapped: false,
        classType: 'non_care',
        fixedFiveDays: false,
      })
    ).toBe('not_applicable');
  });

  it('resolveClassEnrollment exposes classType and derived erpTierApplicability', () => {
    const classSettingMap = new Map<string, ClassSettingLookup>([
      [
        '國小輔導-三年級',
        {
          classType: 'care',
          category: 'care',
          categorySource: 'manual',
          fixedFiveDays: false,
        },
      ],
      [
        '國小輔導-寫功課',
        {
          classType: 'care',
          category: 'care',
          categorySource: 'manual',
          fixedFiveDays: true,
        },
      ],
      [
        '兒童美語-Starter',
        {
          classType: 'non_care',
          category: 'english',
          categorySource: 'manual',
          fixedFiveDays: false,
        },
      ],
    ]);

    const care = resolveClassEnrollment(
      { rawToken: '國小輔導-三年級', baseName: '國小輔導-三年級' },
      undefined,
      classSettingMap
    );
    expect(care.classType).toBe('care');
    expect(care.erpTierApplicability).toBe('applicable');

    const homework = resolveClassEnrollment(
      { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
      undefined,
      classSettingMap
    );
    expect(homework.classType).toBe('care');
    expect(homework.erpTierApplicability).toBe('not_applicable');

    const english = resolveClassEnrollment(
      { rawToken: '兒童美語-Starter', baseName: '兒童美語-Starter' },
      undefined,
      classSettingMap
    );
    expect(english.classType).toBe('non_care');
    expect(english.erpTierApplicability).toBe('not_applicable');

    const unmapped = resolveClassEnrollment(
      { rawToken: '未知班級', baseName: '未知班級' },
      undefined,
      classSettingMap
    );
    expect(unmapped.classType).toBeNull();
    expect(unmapped.erpTierApplicability).toBe('not_applicable');
  });
});

describe('Issue #177 Phase 1: New run calculations retire 6 attendance columns to null', () => {
  it('sets 6 legacy attendance columns to null on new calculation results', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const importId = 'imp_test_1';
    db.prepare(`
      INSERT INTO import_batches (id, file_name, file_hash, content_hash, parser_version, row_count, status, created_at)
      VALUES (?, 'test.xlsx', 'hash', 'content_hash', 'v1', 1, 'ready', '2026-10-27T00:00:00Z')
    `).run(importId);

    db.prepare(`
      INSERT INTO imported_students (id, person_code, import_id, name, grade, grade_raw, grade_status, branch, source_row, tags_raw, notes_raw, created_at)
      VALUES ('stu_1', 'P001', ?, '王小明', 3, '3', 'parsed', '忠孝', 2, '', '', '2026-10-27T00:00:00Z')
    `).run(importId);

    db.prepare(`
      INSERT INTO student_enrollments (id, person_code, import_id, token_index, raw_token, base_name, group_flag, year_prefix, withdrawal_date, erp_billing_tier_raw, erp_billing_tier, tier_parse_status, parse_status, created_at)
      VALUES ('enr_1', 'P001', ?, 0, '國小輔導-三年級[團][3]', '國小輔導-三年級', '團', NULL, NULL, '3', 3, 'parsed', 'ok', '2026-10-27T00:00:00Z')
    `).run(importId);

    const outcome = executeCalculationRun(db, importId, {
      ruleSetVersion: 'erp-tag-v4',
    });

    expect(outcome.results).toHaveLength(1);
    const r = outcome.results[0];

    // Care days are calculated
    expect(r.tutoringDays).toBe(5);

    // The 6 non-care attendance columns must be null
    expect(r.chineseDays).toBeNull();
    expect(r.mathDays).toBeNull();
    expect(r.englishDays).toBeNull();
    expect(r.homeworkDays).toBeNull();
    expect(r.intensiveEnglishDays).toBeNull();
    expect(r.saturdayTutoringDays).toBeNull();

    // classCategories contains classType and resolvedBaseName
    expect(outcome.classCategories).toBeDefined();
    const careCat = outcome.classCategories?.find((c) => c.baseName === '國小輔導-三年級');
    expect(careCat).toBeDefined();
    expect(careCat?.classType).toBe('care');
    expect(careCat?.resolvedBaseName).toBe('國小輔導-三年級');

    // classSemantics is no longer generated
    expect(outcome.classSemantics).toBeUndefined();
  });
});

describe('Issue #177 Phase 1: Migration 0011 & single snapshot persistence', () => {
  it('persists and loads class_type and resolved_base_name in run_class_categories without writing semantics snapshots', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const importId = 'imp_test_2';
    db.prepare(`
      INSERT INTO import_batches (id, file_name, file_hash, content_hash, parser_version, row_count, status, created_at)
      VALUES (?, 'test.xlsx', 'hash', 'content_hash', 'v1', 1, 'ready', '2026-10-27T00:00:00Z')
    `).run(importId);

    const runId = 'run_test_2';
    const runRecord = {
      id: runId,
      importId,
      scheduleVersionId: 'sched_1',
      ruleSetVersion: 'erp-tag-v4',
      numericPolicy: 'round_half_up',
      asOfDate: '2026-10-27',
      status: 'completed' as const,
      issueCounts: {},
      totalStudents: 0,
      createdAt: '2026-10-27T00:00:00Z',
    };

    const categories = [
      {
        baseName: '國小輔導-三年級',
        resolvedBaseName: '國小輔導-三年級',
        classType: 'care' as const,
        category: 'care' as const,
        fixedFiveDays: 0,
        mapped: 1,
        source: 'manual' as const,
      },
      {
        baseName: '兒童美語-Starter',
        resolvedBaseName: '兒童美語-Starter',
        classType: 'non_care' as const,
        category: 'english' as const,
        fixedFiveDays: 0,
        mapped: 1,
        source: 'manual' as const,
      },
    ];

    // saveCalculationRun should succeed without classSemantics
    expect(() => {
      saveCalculationRun(db, runRecord, [], categories);
    }).not.toThrow();

    // Verify run_class_categories table has class_type and resolved_base_name
    const loaded = loadRunClassCategories(db, runId);
    expect(loaded).toHaveLength(2);

    const care = loaded.find((c) => c.base_name === '國小輔導-三年級');
    expect(care).toMatchObject({
      base_name: '國小輔導-三年級',
      resolved_base_name: '國小輔導-三年級',
      class_type: 'care',
      category: 'care',
      fixed_five_days: 0,
      mapped: 1,
    });

    const english = loaded.find((c) => c.base_name === '兒童美語-Starter');
    expect(english).toMatchObject({
      base_name: '兒童美語-Starter',
      resolved_base_name: '兒童美語-Starter',
      class_type: 'non_care',
      category: 'english',
      fixed_five_days: 0,
      mapped: 1,
    });

    // run_semantics_snapshots must remain empty
    const semanticSnapshotCount = db
      .prepare('SELECT COUNT(*) as cnt FROM run_semantics_snapshots WHERE run_id = ?')
      .get(runId) as { cnt: number };
    expect(semanticSnapshotCount.cnt).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import SettingsEditor from '@/components/settings-editor';
import { applicableRateForClass } from '@/application/applicable-rate';
import { resolveTargetRuleSetVersion } from '@/application/rule-set-resolver';
import * as ruleSet from '@/domain/billing/rule-set';
import * as tokenParser from '@/domain/students/token-parser';
import * as classNameReport from '@/application/class-name-match-report';
import { ClassNameReportPanel } from '@/components/settings/class-name-report-panel';

const webRoot = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'migrations') continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('Issue #177 Phase 3: Migration 0012 drops the three retired tables', () => {
  it('fresh database after all migrations has no retired tables or triggers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-p3-mig-'));
    const db = createDatabase(path.join(dir, 'test.sqlite'));
    try {
      runMigrations(db);
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all() as Array<{ name: string }>).map((r) => r.name);
      for (const retired of [
        'run_diagnostics',
        'run_class_semantics',
        'run_semantics_snapshots',
        'run_diagnostics_immutable_update',
        'run_class_semantics_immutable_update',
        'run_semantics_snapshots_immutable_update',
      ]) {
        expect(names, retired).not.toContain(retired);
      }
      expect(names).toContain('run_class_categories');
      const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
      expect(versions).toContain(12);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settings-repository no longer probes the schema with PRAGMA table_info', () => {
    const src = fs.readFileSync(path.join(webRoot, 'src/adapters/sqlite/settings-repository.ts'), 'utf8');
    expect(src).not.toContain('PRAGMA table_info');
  });
});

describe('Issue #177 Phase 3: single current rule set (erp-tag-v4)', () => {
  it('rule-set module exposes only the v4 target and no historical metadata', () => {
    expect((ruleSet as Record<string, unknown>).historicalRuleSetMetadata).toBeUndefined();
    expect(ruleSet.FORMAL_RULE_SET_VERSION_LIST).toEqual(['erp-tag-v4']);
  });

  it('a stale non-v4 active run never blocks a new calculation or demands an upgrade', () => {
    const fakeDb = {
      prepare: (sql: string) => ({
        get: () => (sql.includes('active_state') ? { active_run_id: 'run_old' } : { rule_set_version: 'erp-tag-v3' }),
      }),
    } as never;
    expect(resolveTargetRuleSetVersion(fakeDb)).toBe('erp-tag-v4');
  });

  it('applicable rate never guesses a category from the class name for a legacy version label', () => {
    const rate = applicableRateForClass(
      '國小數學-一A',
      { grade: 1, applicableAnqinBps: 9500, applicableTutoringBps: null, applicableMathBps: 9000, applicableEnglishBps: null },
      { ruleSetVersion: 'erp-tag-v1' }
    );
    expect(rate).toEqual({ status: 'not_configured' });
  });

  it('token parser no longer ships the legacy math/english key extractors', () => {
    expect((tokenParser as Record<string, unknown>).extractLegacyMathKey).toBeUndefined();
    expect((tokenParser as Record<string, unknown>).extractLegacyEnglishKey).toBeUndefined();
  });

  it('settings editor never renders the v4 upgrade banner, whatever the legacy prop says', () => {
    for (const version of ['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'excel-v260922-compat', 'erp-tag-corrupt']) {
      const html = renderToStaticMarkup(
        React.createElement(SettingsEditor, {
          currentRevision: 1,
          initialDraft: buildSeedDraft(),
          currentRuleSetVersion: version,
        } as never)
      );
      expect(html, version).not.toContain('data-upgrade-banner');
      expect(html, version).not.toContain('改用新規則（v4）');
    }
  });
});

describe('Issue #177 Phase 3: previous-roster provenance archaeology is gone', () => {
  it('class-name-match-report exports no provenance resolver', () => {
    const mod = classNameReport as Record<string, unknown>;
    expect(mod.resolvePreviousRosterProvenance).toBeUndefined();
    expect(mod.resolvePreviousRosterImportId).toBeUndefined();
  });

  it('class-name report panel shows system-only classes without any previous-roster column or note', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClassNameReportPanel, {
        report: {
          importId: 'imp_1',
          scope: { kind: 'latest' },
          snapshotStatus: 'ok',
          rosterOnly: [],
          systemOnly: [{ baseName: '國小數學-二A', active: true, aliasCoveredBy: [] }],
          matchedCount: 3,
          aliasCoveredCount: 0,
          rosterOnlyStudents: 0,
        },
      } as never)
    );
    expect(html).toContain('國小數學-二A');
    expect(html).not.toContain('上一份名單');
  });
});

describe('Issue #177 Phase 3: retired code and scripts are removed', () => {
  it.each([
    'src/adapters/sqlite/run-diagnostics-repository.ts',
    'src/contracts/run-diagnostics.ts',
    'src/domain/issues/actionable-issues.ts',
    'src/domain/classification/legacy-class-semantics.ts',
    'src/adapters/xlsx/schedule-seed-reader.ts',
    'scripts/audit-issue-161-diagnostics.ts',
    'scripts/verify-baseline.ts',
    'scripts/e2e-seed-v2-active.ts',
    'tests/e2e/d2d-upgrade-journey.spec.ts',
    'tests/e2e/d2d-upgrade-restore.spec.ts',
  ])('%s no longer exists', (rel) => {
    expect(fs.existsSync(path.join(webRoot, rel)), rel).toBe(false);
  });

  it('package.json drops verify:baseline', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['verify:baseline']).toBeUndefined();
  });

  it('no production source or script references a retired symbol, table or issue code', () => {
    const banned = [
      'historicalRuleSetMetadata',
      'historicalRateCategoryOfClass',
      'usesFrozenLegacyProjection',
      'projectLegacyImportTierEvidence',
      'legacyBodyHash',
      'historical_limited',
      'extractLegacyMathKey',
      'extractLegacyEnglishKey',
      'canUpgrade',
      'upgradeConfirmed',
      'upgradePreviewId',
      'resolvePreviousRosterProvenance',
      'run_diagnostics',
      'run_class_semantics',
      'run_semantics_snapshots',
      'NUMERIC_POLICY_DIFFERENCE',
      'RULESET_POLICY_DIFFERENCE',
      'seed-v2-active',
    ];
    const hits: string[] = [];
    for (const file of [...walk(path.join(webRoot, 'src')), ...walk(path.join(webRoot, 'scripts'))]) {
      const text = fs.readFileSync(file, 'utf8');
      for (const symbol of banned) {
        if (text.includes(symbol)) hits.push(`${path.relative(webRoot, file)} :: ${symbol}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('Issue #177 Phase 3: E2E contract is a single clean stage', () => {
  it('E2E guides no longer describe a seeded stage', () => {
    const e2eGuide = fs.readFileSync(path.join(webRoot, 'tests/e2e/CLAUDE.md'), 'utf8');
    const rootGuide = fs.readFileSync(path.join(webRoot, '..', 'CLAUDE.md'), 'utf8');
    const readme = fs.readFileSync(path.join(webRoot, 'README.md'), 'utf8');
    for (const [name, text] of [['tests/e2e/CLAUDE.md', e2eGuide], ['CLAUDE.md', rootGuide], ['web/README.md', readme]] as const) {
      expect(text, name).not.toContain('seed-v2-active');
      expect(text, name).not.toContain('d2d-upgrade');
    }
  });

  it('e2e runner scripts carry no seeded-stage machinery', () => {
    for (const rel of ['scripts/e2e-full.mjs', 'scripts/e2e-isolated.ts', 'scripts/verify-full-e2e-report.mjs', 'scripts/check-e2e-parity.mjs']) {
      const text = fs.readFileSync(path.join(webRoot, rel), 'utf8');
      expect(text, rel).not.toMatch(/seeded|seedV2|seed-v2|E2E_REQUIRE_V2_SEED|d2d-upgrade/);
    }
  });
});

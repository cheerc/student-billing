import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { AppNav } from '@/components/app-nav';
import { NextRequest } from 'next/server';

const webRoot = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'migrations' || entry.name === '.next') continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('Issue #177 Phase 4: Migration 0013 compacts database to single current state', () => {
  it('0013 deletes non-current runs, batches, older settings versions, previews, and idempotency records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-p4-mig-'));
    const db = createDatabase(path.join(dir, 'test.sqlite'));
    try {
      runMigrations(db);
      const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
      expect(versions).toContain(13);

      const tableCount = (table: string) => (db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number }).cnt;
      expect(tableCount('settings_previews')).toBe(0);
      expect(tableCount('idempotency_records')).toBe(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Issue #177 Phase 4: retired routes and components are completely deleted', () => {
  const deletedFiles = [
    'src/app/history/page.tsx',
    'src/app/history/[runId]/page.tsx',
    'src/components/history/history-list.tsx',
    'src/application/history-view.ts',
    'src/application/run-snapshot.ts',
    'src/components/roster-view.tsx',
    'src/components/student-table.tsx',
    'src/app/api/v1/imports/route.ts',
    'src/app/api/v1/imports/[previewId]/students/route.ts',
    'src/app/api/v1/runs/route.ts',
    'src/app/api/v1/runs/[runId]/students/[personCode]/route.ts',
    'src/app/api/v1/runs/[runId]/issues/route.ts',
    'src/app/api/v1/settings/deductions/route.ts',
  ];

  it.each(deletedFiles)('%s is deleted', (rel) => {
    expect(fs.existsSync(path.join(webRoot, rel)), rel).toBe(false);
  });

  it('AppNav does not contain 匯入紀錄 or link to /history', () => {
    const html = renderToStaticMarkup(React.createElement(AppNav));
    expect(html).not.toContain('匯入紀錄');
    expect(html).not.toContain('/history');
    expect(html).toContain('01');
    expect(html).toContain('02');
    expect(html).toContain('03');
  });
});

describe('Issue #177 Phase 4: GET /api/v1/classes route convergence', () => {
  it('classes route has no subject or seedSubjectMap dependency and returns clean 9-field schema', async () => {
    const src = fs.readFileSync(path.join(webRoot, 'src/app/api/v1/classes/route.ts'), 'utf8');
    expect(src).not.toContain('seedSubjectMap');
    expect(src).not.toContain('loadRunSnapshot');
    expect(src).not.toContain('useRunSnapshot');
  });
});

describe('Issue #177 Phase 4: full repo reverse residual scan has 0 hits', () => {
  it('no production code, scripts or tests contain retired Phase 1-4 symbols', () => {
    const banned = [
      'ClassSemanticsPanel',
      'legacy-semantic-migration',
      'classTypeDefinitions',
      'summaryDayRoles',
      'semanticOnly',
      '__class_semantics',
      'run_diagnostics',
      'historicalRuleSetMetadata',
      'resolvePreviousRosterProvenance',
      'RosterView',
      'StudentTable',
    ];
    const hits: string[] = [];
    for (const file of [...walk(path.join(webRoot, 'src')), ...walk(path.join(webRoot, 'scripts')), ...walk(path.join(webRoot, 'tests'))]) {
      if (file.includes('issue-177-')) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const symbol of banned) {
        if (text.includes(symbol)) hits.push(`${path.relative(webRoot, file)} :: ${symbol}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

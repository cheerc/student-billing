import Database from 'better-sqlite3';
import path from 'node:path';
import type { RunDiagnosticDifference, RunDiagnosticPayload } from '@/contracts/run-diagnostics';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { readRunDiagnostics } from '@/adapters/sqlite/run-diagnostics-repository';

// Keep this audit oracle local: sharing the production comparator could let the
// same omitted field or ordering bug validate itself.
const AUDIT_FIELDS = ['baseDiscountBps', 'anqinDays', 'tutoringDays'] as const;
type AuditField = (typeof AUDIT_FIELDS)[number];

function expectedDifferences(payload: RunDiagnosticPayload, names: Map<string, string>): RunDiagnosticDifference[] {
  const students = [...payload.students].sort((a, b) => a.sourceRow - b.sourceRow ||
    (a.personCode < b.personCode ? -1 : a.personCode > b.personCode ? 1 : 0));
  const differences: RunDiagnosticDifference[] = [];
  for (const student of students) {
    const name = names.get(student.personCode);
    if (name === undefined) continue;
    for (const field of AUDIT_FIELDS) {
      const formalValue = student.formal[field];
      const compatValue = student.compat[field];
      if (formalValue === compatValue) continue;
      differences.push({
        personCode: student.personCode,
        name,
        sourceRow: student.sourceRow,
        field,
        formalValue,
        compatValue,
        category: field === 'baseDiscountBps' ? 'DISCOUNT_DIFFERENCE' : 'CARE_DAYS_DIFFERENCE',
      });
    }
  }
  return differences;
}

function differenceKey(difference: RunDiagnosticDifference): string {
  return JSON.stringify([
    difference.personCode,
    difference.name,
    difference.sourceRow,
    difference.field,
    difference.formalValue,
    difference.compatValue,
    difference.category,
  ]);
}

export interface Issue161AuditSummary {
  totalRuns: number;
  supportedRuns: number;
  unavailableRuns: number;
  corruptedRuns: number;
  projectionCount: number;
  storedDifferenceCount: number;
  expectedDifferenceCount: number;
  differenceSetFailures: number;
  queryOnly: true;
  dataVersionBefore: number;
  dataVersionAfter: number;
}

/** Read-only audit. Output contains aggregate counts only, never run IDs or student data. */
export function auditIssue161Diagnostics(db: Database.Database): Issue161AuditSummary {
  db.pragma('query_only = ON');
  const dataVersionBefore = Number((db.pragma('data_version', { simple: true }) as number) ?? 0);
  const runIds = (db.prepare('SELECT id FROM calculation_runs ORDER BY id').all() as Array<{ id: string }>)
    .map(({ id }) => id);
  let supportedRuns = 0;
  let unavailableRuns = 0;
  let corruptedRuns = 0;
  let projectionCount = 0;
  let storedDifferenceCount = 0;
  let expectedDifferenceCount = 0;
  let differenceSetFailures = 0;

  for (const runId of runIds) {
    let run;
    try {
      run = getCalculationRun(db, runId);
    } catch {
      corruptedRuns += 1;
      continue;
    }
    if (!run) {
      corruptedRuns += 1;
      continue;
    }

    const diagnostic = readRunDiagnostics(db, run);
    if (diagnostic.status === 'version-unavailable' || diagnostic.status === 'content-missing') {
      unavailableRuns += 1;
      continue;
    }
    if (diagnostic.status === 'corrupted') {
      corruptedRuns += 1;
      continue;
    }

    supportedRuns += 1;
    const row = db.prepare('SELECT payload_json FROM run_diagnostics WHERE run_id = ?').get(runId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as RunDiagnosticPayload;
    const names = new Map((db.prepare('SELECT person_code, name FROM student_calculations WHERE run_id = ?').all(runId) as Array<{ person_code: string; name: string }>)
      .map((student) => [student.person_code, student.name]));
    const expected = expectedDifferences(payload, names);

    projectionCount += payload.projectionCount;
    storedDifferenceCount += payload.totalDifferences;
    expectedDifferenceCount += expected.length;
    const expectedKeys = expected.map(differenceKey);
    const storedKeys = payload.differences.map(differenceKey);
    if (expectedKeys.length !== storedKeys.length || expectedKeys.some((key, index) => key !== storedKeys[index])) {
      differenceSetFailures += 1;
    }
  }

  const dataVersionAfter = Number((db.pragma('data_version', { simple: true }) as number) ?? 0);
  return {
    totalRuns: runIds.length,
    supportedRuns,
    unavailableRuns,
    corruptedRuns,
    projectionCount,
    storedDifferenceCount,
    expectedDifferenceCount,
    differenceSetFailures,
    queryOnly: true,
    dataVersionBefore,
    dataVersionAfter,
  };
}

function main(): void {
  const rawDatabasePath = process.argv[2];
  if (!rawDatabasePath || rawDatabasePath === '--help') {
    process.stdout.write('Usage: npm exec tsx scripts/audit-issue-161-diagnostics.ts /absolute/path/to/backup.sqlite\n');
    if (!rawDatabasePath) process.exitCode = 2;
    return;
  }
  if (!path.isAbsolute(rawDatabasePath)) {
    process.stderr.write('Provide an absolute path to a database backup. The default application database is never selected.\n');
    process.exitCode = 2;
    return;
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(path.resolve(rawDatabasePath), { readonly: true, fileMustExist: true });
    const summary = auditIssue161Diagnostics(db);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.corruptedRuns > 0 || summary.differenceSetFailures > 0 || summary.dataVersionBefore !== summary.dataVersionAfter) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Issue #161 read-only audit failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1]?.endsWith('audit-issue-161-diagnostics.ts')) main();

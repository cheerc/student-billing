import { NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { maskSensitiveInfo } from '@/contracts/security';

export async function GET() {
  try {
    const db = getDatabase();
    const active = getCurrentActiveRun(db);

    const rows = db
      .prepare(`
        SELECT r.*, b.file_name
        FROM calculation_runs r
        LEFT JOIN import_batches b ON b.id = r.import_id
        ORDER BY r.created_at DESC
      `)
      .all() as any[];

    const runs = rows.map((r) => ({
      id: r.id,
      importId: r.import_id,
      fileName: r.file_name || '',
      scheduleVersionId: r.schedule_version_id,
      ruleSetVersion: r.rule_set_version,
      numericPolicy: r.numeric_policy,
      asOfDate: r.as_of_date,
      status: r.status,
      issueCounts: JSON.parse(r.issue_counts || '{}'),
      totalStudents: r.total_students,
      createdAt: r.created_at,
      isActive: r.id === active.activeRunId,
    }));

    return NextResponse.json(
      {
        activeRevision: active.revision,
        activeRunId: active.activeRunId,
        totalRuns: runs.length,
        runs,
      },
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message) }, { status: 500 });
  }
}

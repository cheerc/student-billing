import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId: rawRunId } = await context.params;
    const runId = sanitizePathParam(rawRunId, 'runId');

    const db = getDatabase();
    const run = getCalculationRun(db, runId);
    if (!run) {
      return NextResponse.json({ error: `找不到計算 run: ${runId}` }, { status: 404 });
    }

    const url = new URL(request.url);
    const personCode = url.searchParams.get('personCode');
    const classId = url.searchParams.get('classId') || url.searchParams.get('enrollmentKey');
    const issueCode = url.searchParams.get('issueCode');

    const whereClauses: string[] = ['sc.run_id = ?', 'sc.has_issues = 1'];
    const queryArgs: any[] = [runId];

    if (personCode) {
      whereClauses.push('sc.person_code = ?');
      queryArgs.push(personCode);
    }

    if (classId) {
      whereClauses.push(`
        EXISTS (
          SELECT 1 FROM student_enrollments e
          WHERE e.import_id = ? AND e.person_code = sc.person_code AND e.base_name = ?
        )
      `);
      queryArgs.push(run.importId, classId);
    }

    if (issueCode) {
      whereClauses.push(`sc.issues LIKE '%"code":"' || ? || '"%'`);
      queryArgs.push(issueCode);
    }

    const sql = `
      SELECT sc.person_code, sc.name, sc.branch, sc.grade, sc.issues, sc.tier_comparisons, s.source_row
      FROM student_calculations sc
      LEFT JOIN imported_students s ON s.import_id = ? AND s.person_code = sc.person_code
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY sc.person_code ASC
    `;

    const rows = db.prepare(sql).all(run.importId, ...queryArgs) as any[];

    const items: any[] = [];
    for (const r of rows) {
      const studentIssues = JSON.parse(r.issues || '[]');
      const tierComps = JSON.parse(r.tier_comparisons || '[]');

      for (const iss of studentIssues) {
        if (!issueCode || iss.code === issueCode) {
          items.push({
            personCode: r.person_code,
            name: r.name,
            sourceRow: r.source_row,
            branch: r.branch,
            grade: r.grade,
            issueCode: iss.code,
            category: iss.category || null,
            message: iss.message,
            type: 'student_issue',
          });
        }
      }

      for (const comp of tierComps) {
        if (comp.needsReview) {
          for (const cIssue of comp.issues || []) {
            if (!issueCode || cIssue === issueCode) {
              items.push({
                personCode: r.person_code,
                name: r.name,
                sourceRow: r.source_row,
                branch: r.branch,
                grade: r.grade,
                issueCode: cIssue,
                rawToken: comp.rawToken,
                baseName: comp.baseName,
                message: `排課比對待核對: ${comp.rawToken} (${cIssue})`,
                type: 'tier_issue',
              });
            }
          }
        }
      }
    }

    return NextResponse.json(
      {
        runId,
        totalIssues: items.length,
        issueCounts: run.issueCounts,
        items,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCalculationRun, getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

export async function GET(
  _request: NextRequest,
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

    const active = getCurrentActiveRun(db);

    return NextResponse.json(
      {
        ...run,
        isActive: run.id === active.activeRunId,
        activeRevision: active.revision,
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

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getStudentCalculationDetail } from '@/application/query-students';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ runId: string; personCode: string }> }
) {
  try {
    const { runId, personCode } = await context.params;
    const db = getDatabase();
    const detail = getStudentCalculationDetail(db, runId, personCode);

    if (!detail) {
      return NextResponse.json(
        { error: `在 run ${runId} 中找不到學生 ${personCode} 之計算資料` },
        { status: 404 }
      );
    }

    return NextResponse.json(detail, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

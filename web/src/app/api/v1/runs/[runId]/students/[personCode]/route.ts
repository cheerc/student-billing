import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getStudentCalculationDetail } from '@/application/query-students';
import { sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ runId: string; personCode: string }> }
) {
  try {
    const { runId: rawRunId, personCode: rawPersonCode } = await context.params;
    const runId = sanitizePathParam(rawRunId, 'runId');
    const personCode = sanitizePathParam(rawPersonCode, 'personCode');

    const db = getDatabase();
    const detail = getStudentCalculationDetail(db, runId, personCode);

    if (!detail) {
      return NextResponse.json(
        { error: `在 run ${runId} 中找不到學生 ${personCode} 之計算資料` },
        { status: 404 }
      );
    }

    // PII 防護：遮蔽原始備註與標籤中可能包含的手機號碼或通訊資訊
    if (detail.trace?.rawNotes) {
      detail.trace.rawNotes = maskSensitiveInfo(detail.trace.rawNotes);
    }

    return NextResponse.json(detail, { status: 200 });
  } catch (error) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message) }, { status: 500 });
  }
}

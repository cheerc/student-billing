import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getScheduleDeductions } from '@/application/schedule-deductions';
import { SchedulePreviewError } from '@/application/schedule-preview';
import { sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

/**
 * 09 §8.1：班級扣天固定快照。GET，不寫 DB。只接受 runId 查詢參數；未知參數 400。
 */
export async function GET(request: NextRequest) {
  try {
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) {
      if (key !== 'runId') {
        return NextResponse.json({ error: `未知或不支援的查詢參數: 「${key}」`, code: 'INVALID_QUERY' }, { status: 400 });
      }
    }
    const runId = params.has('runId') ? sanitizePathParam(params.get('runId'), 'runId') : undefined;

    const db = getDatabase();
    return NextResponse.json(getScheduleDeductions(db, { runId }), { status: 200 });
  } catch (error) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    if (error instanceof SchedulePreviewError) {
      return NextResponse.json({ error: maskSensitiveInfo(error.message), code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message), code: 'DEDUCTIONS_FAILED' }, { status: 500 });
  }
}

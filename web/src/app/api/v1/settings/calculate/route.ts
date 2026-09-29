import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { calculateSchedulePreview, SchedulePreviewError } from '@/application/schedule-preview';
import { validateSameOrigin, maskSensitiveInfo } from '@/contracts/security';

/** payload 上限：完整 draft（約 90 個時段列）遠小於此，超過即拒絕（09 §8.1）。 */
export const MAX_CALCULATE_PAYLOAD_BYTES = 512 * 1024;

/**
 * 09 §8.1：唯讀計算 read model。純計算，不寫 DB、不建 preview／run；仍驗 same-origin 與 payload 上限。
 */
export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request)) {
      return NextResponse.json(
        { error: '拒絕跨來源寫入請求 (Cross-origin write request forbidden)', code: 'FORBIDDEN_CROSS_ORIGIN' },
        { status: 403 }
      );
    }

    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_CALCULATE_PAYLOAD_BYTES) {
      return NextResponse.json({ error: '請求內容過大', code: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
    }
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_CALCULATE_PAYLOAD_BYTES) {
      return NextResponse.json({ error: '請求內容過大', code: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: '請求內容不是合法 JSON', code: 'INVALID_REQUEST' }, { status: 400 });
    }

    const db = getDatabase();
    return NextResponse.json(calculateSchedulePreview(db, body), { status: 200 });
  } catch (error) {
    if (error instanceof SchedulePreviewError) {
      return NextResponse.json({ error: maskSensitiveInfo(error.message), code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message), code: 'SCHEDULE_PREVIEW_FAILED' }, { status: 500 });
  }
}

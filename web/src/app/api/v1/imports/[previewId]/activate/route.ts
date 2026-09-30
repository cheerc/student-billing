import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { activateImport, ActivateConflictError, ActivateError } from '@/application/activate-import';
import { validateSameOrigin, sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ previewId: string }> }
) {
  try {
    if (!validateSameOrigin(request)) {
      return NextResponse.json(
        { error: '拒絕跨來源寫入請求 (Cross-origin write request forbidden)', code: 'FORBIDDEN_CROSS_ORIGIN' },
        { status: 403 }
      );
    }

    const { previewId: rawPreviewId } = await context.params;
    const previewId = sanitizePathParam(rawPreviewId, 'previewId');

    const body = await request.json().catch(() => ({}));
    // ruleSetVersion 由 server 決定，client 不得指定（含 null；與 settings/calculate 一致）：帶了就 400
    if (typeof body === 'object' && body !== null && 'ruleSetVersion' in body) {
      throw new ActivateError(400, 'ruleSetVersion 由伺服器決定，請勿帶入', 'INVALID_REQUEST');
    }
    // 不轉交 client 的 scheduleVersionId：課表版本由 server 解析最新已儲存設定決定（09 §8.2.1）
    const { expectedRevision, idempotencyKey, asOfDate } = body;

    const db = getDatabase();
    const result = activateImport(db, {
      importId: previewId,
      expectedRevision,
      idempotencyKey,
      asOfDate,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    if (error instanceof ActivateConflictError) {
      return NextResponse.json({ error: maskSensitiveInfo(error.message), code: error.code }, { status: 409 });
    }
    if (error instanceof ActivateError) {
      return NextResponse.json({ error: maskSensitiveInfo(error.message), code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message), code: 'ACTIVATE_FAILED' }, { status: 500 });
  }
}

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
    const { expectedRevision, idempotencyKey, asOfDate, scheduleVersionId } = body;

    const db = getDatabase();
    const result = activateImport(db, {
      importId: previewId,
      expectedRevision,
      idempotencyKey,
      asOfDate,
      scheduleVersionId,
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

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { activateImport, ActivateConflictError, ActivateError } from '@/application/activate-import';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ previewId: string }> }
) {
  try {
    const { previewId } = await context.params;
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
    if (error instanceof ActivateConflictError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    if (error instanceof ActivateError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, code: 'ACTIVATE_FAILED' }, { status: 500 });
  }
}

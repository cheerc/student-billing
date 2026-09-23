import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { previewSettingsChange, SettingsPreviewError } from '@/application/settings-preview';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { importId, draft, expectedRevision } = body;

    if (!importId || typeof importId !== 'string') {
      return NextResponse.json(
        { error: '缺少必要參數 importId', code: 'MISSING_IMPORT_ID' },
        { status: 400 }
      );
    }

    const db = getDatabase();
    const result = previewSettingsChange(db, importId, { draft, expectedRevision });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof SettingsPreviewError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, code: 'SETTINGS_PREVIEW_FAILED' }, { status: 500 });
  }
}

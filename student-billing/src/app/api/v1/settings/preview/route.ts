import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { previewSettingsChange, SettingsPreviewError } from '@/application/settings-preview';
import { validateSameOrigin, maskSensitiveInfo } from '@/contracts/security';

export async function POST(request: NextRequest) {
  try {
    if (!validateSameOrigin(request)) {
      return NextResponse.json(
        { error: '拒絕跨來源寫入請求 (Cross-origin write request forbidden)', code: 'FORBIDDEN_CROSS_ORIGIN' },
        { status: 403 }
      );
    }

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
      return NextResponse.json({ error: maskSensitiveInfo(error.message), code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message), code: 'SETTINGS_PREVIEW_FAILED' }, { status: 500 });
  }
}

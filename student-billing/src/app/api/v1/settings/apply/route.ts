import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { applySettingsPreview, SettingsApplyError } from '@/application/apply-settings';
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

    const db = getDatabase();
    const result = applySettingsPreview(db, body);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof SettingsApplyError) {
      return NextResponse.json({ error: maskSensitiveInfo(error.message), code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message), code: 'SETTINGS_APPLY_FAILED' }, { status: 500 });
  }
}

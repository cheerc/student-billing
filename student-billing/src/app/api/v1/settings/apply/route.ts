import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { applySettingsPreview, SettingsApplyError } from '@/application/apply-settings';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const db = getDatabase();
    const result = applySettingsPreview(db, body);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof SettingsApplyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, code: 'SETTINGS_APPLY_FAILED' }, { status: 500 });
  }
}

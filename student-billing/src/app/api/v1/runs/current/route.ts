import { NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';

export async function GET() {
  try {
    const db = getDatabase();
    const row = db
      .prepare('SELECT active_import_id, active_run_id, revision, updated_at FROM active_state WHERE id = 1')
      .get() as {
        active_import_id: string | null;
        active_run_id: string | null;
        revision: number;
        updated_at: string;
      } | undefined;

    return NextResponse.json({
      revision: row ? row.revision : 0,
      activeImportId: row ? row.active_import_id : null,
      activeRunId: row ? row.active_run_id : null,
      run: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

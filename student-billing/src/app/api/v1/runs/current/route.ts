import { NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';

export async function GET() {
  try {
    const db = getDatabase();
    const active = getCurrentActiveRun(db);

    return NextResponse.json({
      revision: active.revision,
      activeImportId: active.activeImportId,
      activeRunId: active.activeRunId,
      run: active.run,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

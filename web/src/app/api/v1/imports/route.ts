import { NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { maskSensitiveInfo } from '@/contracts/security';

export async function GET() {
  try {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT id, file_name, file_hash, content_hash, sheet_name,
               parser_version, scope_note, row_count, status, created_at
        FROM import_batches
        ORDER BY created_at DESC
      `)
      .all() as any[];

    const items = rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      fileHash: r.file_hash,
      contentHash: r.content_hash,
      sheetName: r.sheet_name,
      parserVersion: r.parser_version,
      scopeNote: r.scope_note,
      rowCount: r.row_count,
      status: r.status,
      createdAt: r.created_at,
    }));

    return NextResponse.json({ total: items.length, items }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { queryImportStudents, RosterQueryError } from '@/application/roster-query';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ previewId: string }> }
) {
  try {
    const { previewId } = await context.params;
    const url = new URL(request.url);

    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((val, key) => {
      queryParams[key] = val;
    });

    const db = getDatabase();
    const result = queryImportStudents(db, previewId, queryParams);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof RosterQueryError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

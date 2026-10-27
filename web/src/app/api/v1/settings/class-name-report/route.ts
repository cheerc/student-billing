import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCalculationRun, getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestReadyBatch } from '@/adapters/sqlite/import-repository';
import {
  ClassNameReportError,
  ClassNameReportScope,
  getClassNameMatchReport,
} from '@/application/class-name-match-report';
import { sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

/**
 * 班名比對報告（D1；03 §5、04 §8 UX44–UX47）。GET，不寫 DB。查詢參數：
 *  - runId：以該 run 當時的設定快照比對；名單預設為該 run 的名單。快照缺失 → 200＋snapshotStatus＝unavailable（無法判定）。
 *  - importId：指定名單批次；未指定時預設現行名單（無現行名單則最新 ready 批次）。
 *  - runId 與 importId 同時指定時，兩者必須指向同一份名單，否則 400 INVALID_QUERY。
 */
export async function GET(request: NextRequest) {
  try {
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) {
      if (key !== 'runId' && key !== 'importId') {
        return NextResponse.json({ error: `未知或不支援的查詢參數: 「${key}」`, code: 'INVALID_QUERY' }, { status: 400 });
      }
    }
    const runId = params.has('runId') ? sanitizePathParam(params.get('runId'), 'runId') : null;
    const requestedImportId = params.has('importId') ? sanitizePathParam(params.get('importId'), 'importId') : null;

    const db = getDatabase();
    let importId: string | null;
    let scope: ClassNameReportScope;

    if (runId) {
      const run = getCalculationRun(db, runId);
      if (!run) {
        return NextResponse.json({ error: `找不到計算 run: ${runId}`, code: 'RUN_NOT_FOUND' }, { status: 404 });
      }
      if (requestedImportId !== null && requestedImportId !== run.importId) {
        return NextResponse.json(
          { error: 'runId 與 importId 指向不同的名單批次，請只帶其中一個，或帶同一份名單的兩者。', code: 'INVALID_QUERY' },
          { status: 400 }
        );
      }
      importId = run.importId;
      scope = { kind: 'run', runId };
    } else {
      importId = requestedImportId ?? getCurrentActiveRun(db).activeImportId ?? getLatestReadyBatch(db)?.id ?? null;
      scope = { kind: 'latest' };
    }

    if (!importId) {
      return NextResponse.json({ error: '尚無任何名單可比對', code: 'IMPORT_NOT_FOUND' }, { status: 404 });
    }

    return NextResponse.json(getClassNameMatchReport(db, { importId, scope }), { status: 200 });
  } catch (error) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    if (error instanceof ClassNameReportError) {
      return NextResponse.json({ error: maskSensitiveInfo(error.message), code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message), code: 'CLASS_NAME_REPORT_FAILED' }, { status: 500 });
  }
}

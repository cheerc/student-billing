import { NextRequest, NextResponse } from 'next/server';
import { generateImportPreview } from '@/application/import-preview';
import { ErpReaderError } from '@/adapters/xlsx/erp-reader';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch, getLatestReadyBatch } from '@/adapters/sqlite/import-repository';
import { computeImportRosterChanges } from '@/application/import-roster-diff';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { validateSameOrigin, maskSensitiveInfo } from '@/contracts/security';

export async function POST(request: Request | NextRequest) {
  try {
    if (!validateSameOrigin(request)) {
      return NextResponse.json(
        { error: '拒絕跨來源寫入請求 (Cross-origin write request forbidden)', code: 'FORBIDDEN_CROSS_ORIGIN' },
        { status: 403 }
      );
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { error: '未提供上傳檔案，請選擇 ERP 學生名單試算表 (XLSX)' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const preview = await generateImportPreview(buffer, file.name);

    // 持久化保存為 ready 批次至 SQLite
    const db = getDatabase();

    // 差異基準＝現行名單：優先 active_state 的 active_import_id，否則最新 ready 批次
    // （須在儲存本批之前取，避免重複上傳時把本批當成基準）
    const active = getCurrentActiveRun(db);
    const baseImportId = active.activeImportId ?? getLatestReadyBatch(db)?.id ?? null;

    const saveResult = saveImportBatch(
      db,
      {
        id: preview.previewId,
        fileName: preview.fileName,
        fileHash: preview.fileHash,
        contentHash: preview.contentHash,
        sheetName: preview.sheetName,
        headerMap: preview.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: preview.scopeNote,
        rowCount: preview.stats.totalStudents,
        status: 'ready',
        createdAt: new Date().toISOString(),
      },
      preview.students
    );

    // 名單差異以「實際保存的批次」整批對比基準名單，並以 before/after 計算結果判定異動
    // （operator 裁決 d-20260929111803466480-4／-5，不是報名 token 指紋）。
    // 重複上傳時 batchId 為既有批次；若它就是基準則不自我比較（baseImportId:null）。
    const rosterDiff = computeImportRosterChanges(db, saveResult.batchId, baseImportId);

    return NextResponse.json(
      {
        ...preview,
        isDuplicate: saveResult.isDuplicate,
        duplicateReason: saveResult.duplicateReason,
        batchId: saveResult.batchId,
        rosterDiff,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof ErpReaderError) {
      return NextResponse.json(
        { error: maskSensitiveInfo(error.message), code: error.code },
        { status: error.statusCode }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: maskSensitiveInfo(`解析試算表失敗: ${message}`), code: 'IMPORT_FAILED' },
      { status: 500 }
    );
  }
}

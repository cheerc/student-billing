import { NextRequest, NextResponse } from 'next/server';
import { generateImportPreview } from '@/application/import-preview';
import { ErpReaderError } from '@/adapters/xlsx/erp-reader';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';

export async function POST(request: Request | NextRequest) {
  try {
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

    return NextResponse.json(
      {
        ...preview,
        isDuplicate: saveResult.isDuplicate,
        duplicateReason: saveResult.duplicateReason,
        batchId: saveResult.batchId,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof ErpReaderError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.statusCode }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `解析試算表失敗: ${message}`, code: 'IMPORT_FAILED' },
      { status: 500 }
    );
  }
}

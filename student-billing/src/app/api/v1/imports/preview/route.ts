import { NextRequest, NextResponse } from 'next/server';
import { generateImportPreview } from '@/application/import-preview';
import { ErpReaderError } from '@/adapters/xlsx/erp-reader';

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

    return NextResponse.json(preview, { status: 200 });
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

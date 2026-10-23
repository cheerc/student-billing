import { NextRequest, NextResponse } from 'next/server';
import { validateSameOrigin } from '@/contracts/security';
import {
  buildScheduleWorkbook,
  parseScheduleWorkbook,
  scheduleImportRowsToGridRows,
  ScheduleTableImportError,
} from '@/adapters/xlsx/schedule-table-io';
import type { ScheduleGridRow } from '@/contracts/settings';

/** 課表匯出／匯入 payload 上限：完整課表約 90 列，遠小於此。 */
export const MAX_SCHEDULE_TABLE_BYTES = 1024 * 1024;

/**
 * 匯出端傳入的每班屬性形狀（包含課程類型、折扣類別與固定 5 天）。
 * #113 follow-up：不計扣天已逐時段化，改由 `rows[]` 每一列自帶 `skipDeduction`，不是班級屬性。
 */
interface ExportClassAttr {
  className: string;
  classType?: 'care' | 'non_care';
  category: 'care' | 'math' | 'english' | 'none' | 'unset';
  fixedFiveDays: boolean;
}

export async function POST(request: NextRequest) {
  if (!validateSameOrigin(request)) {
    return NextResponse.json(
      { error: '拒絕跨來源寫入請求 (Cross-origin write request forbidden)', code: 'FORBIDDEN_CROSS_ORIGIN' },
      { status: 403 }
    );
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SCHEDULE_TABLE_BYTES) {
    return NextResponse.json({ error: '檔案過大', code: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: '請求內容無法解析', code: 'INVALID_REQUEST' }, { status: 400 });
  }

  const mode = formData.get('mode');

  if (mode === 'import') {
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: '請先選擇要匯入的課表 Excel（.xlsx）檔案。', code: 'NO_FILE' },
        { status: 400 }
      );
    }
    if (file.size > MAX_SCHEDULE_TABLE_BYTES) {
      return NextResponse.json({ error: '檔案過大', code: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      const result = await parseScheduleWorkbook(buffer);
      return NextResponse.json(
        { rows: scheduleImportRowsToGridRows(result), classAttrs: result.classAttrs },
        { status: 200 }
      );
    } catch (error) {
      if (error instanceof ScheduleTableImportError) {
        return NextResponse.json(
          { error: error.message, location: error.location, code: 'INVALID_SCHEDULE_TABLE' },
          { status: 400 }
        );
      }
      throw error;
    }
  }

  if (mode === 'export') {
    const payload = formData.get('payload');
    if (typeof payload !== 'string') {
      return NextResponse.json(
        { error: '匯出缺少課表內容。', code: 'INVALID_REQUEST' },
        { status: 400 }
      );
    }

    let rows: ScheduleGridRow[];
    let classAttrs: ExportClassAttr[];
    try {
      const parsed = JSON.parse(payload);
      if (!Array.isArray(parsed?.rows) || !Array.isArray(parsed?.classAttrs)) {
        throw new Error('shape');
      }
      rows = parsed.rows;
      classAttrs = parsed.classAttrs;
    } catch {
      return NextResponse.json(
        { error: '匯出內容格式不正確。', code: 'INVALID_REQUEST' },
        { status: 400 }
      );
    }

    const buffer = await buildScheduleWorkbook(rows, classAttrs);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="schedule.xlsx"',
      },
    });
  }

  return NextResponse.json(
    { error: '請指定匯出或匯入。', code: 'INVALID_REQUEST' },
    { status: 400 }
  );
}

import ExcelJS from 'exceljs';
import crypto from 'crypto';
import fs from 'fs';
import { parseSingleClassToken } from '@/domain/students/token-parser';

export interface ScheduleSessionItem {
  rawName: string;
  baseName: string;
  teacher: string | null;
  weekday: string | null;
  startMinutes: number | null;
  endMinutes: number | null;
}

export interface ClassScheduleItem {
  rawName: string;
  baseName: string;
  source: 'schedule' | 'care_window' | 'empty';
  teacher: string | null;
  sessions: ScheduleSessionItem[];
}

export interface ScheduleSeedManifest {
  sourceHash: string;
  totalSessionRows: number;
  classes: ClassScheduleItem[];
  careWindows: {
    anqin: { startMinutes: number; endMinutes: number; weekdayText: string };
    tutoring: { startMinutes: number; endMinutes: number; weekdayText: string };
  };
}

export function parseTimeToMinutes(val: any): number | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) {
    return val.getUTCHours() * 60 + val.getUTCMinutes();
  }
  if (typeof val === 'number') {
    return Math.round(val * 24 * 60);
  }
  if (typeof val === 'string') {
    const m = val.match(/(\d{1,2}):(\d{2})/);
    if (m) {
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
  }
  return null;
}

const CARE_WINDOW_CLASSES = new Set([
  '國小輔導-一A[團]',
  '國小輔導-一B[團]',
  '國小輔導-二A[團]',
  '國小輔導-二B[團]',
  '國小輔導-三年級[團]',
  '國小輔導-四年級[團]',
  '國小輔導-五年級[團]',
  '國小輔導-六年級[團]',
]);

/**
 * 從指定之計算檔 S 表讀取 A:E 手動時段與兩組 care_windows。
 */
export async function readScheduleSeed(
  input: string | Buffer
): Promise<ScheduleSeedManifest> {
  let buf: Buffer;
  if (typeof input === 'string') {
    buf = fs.readFileSync(input);
  } else {
    buf = input;
  }

  const sourceHash = crypto.createHash('sha256').update(buf).digest('hex');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);

  const ws = wb.getWorksheet('(需要時修改)上課時間設定表-v250922');
  if (!ws) {
    throw new Error('找不到上課時間設定表 worksheet: (需要時修改)上課時間設定表-v250922');
  }

  // 1. 讀取安親與課輔時間窗 (Row 1 & Row 2)
  // Col B: 星期, Col C: 起始時間, Col D: 結束時間
  const anqinWeekday = String(ws.getRow(1).getCell(2).value || '一~五');
  const anqinStart = parseTimeToMinutes(ws.getRow(1).getCell(3).value) ?? 780; // 13:00
  const anqinEnd = parseTimeToMinutes(ws.getRow(1).getCell(4).value) ?? 960; // 16:00

  const tutoringWeekday = String(ws.getRow(2).getCell(2).value || '一~五');
  const tutoringStart = parseTimeToMinutes(ws.getRow(2).getCell(3).value) ?? 990; // 16:30
  const tutoringEnd = parseTimeToMinutes(ws.getRow(2).getCell(4).value) ?? 1170; // 19:30

  // 2. 逐列讀取 session (Row 4 起)
  const classMap = new Map<string, ScheduleSessionItem[]>();
  const classOrder: string[] = [];
  let totalSessionRows = 0;

  for (let r = 4; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cellA = row.getCell(1).value;
    if (!cellA) continue;

    const rawName = String(cellA).trim();
    totalSessionRows++;

    if (!classMap.has(rawName)) {
      classMap.set(rawName, []);
      classOrder.push(rawName);
    }

    const teacher = row.getCell(2).value ? String(row.getCell(2).value).trim() : null;
    const weekday = row.getCell(3).value ? String(row.getCell(3).value).trim() : null;
    const startMinutes = parseTimeToMinutes(row.getCell(4).value);
    const endMinutes = parseTimeToMinutes(row.getCell(5).value);

    const baseName = parseSingleClassToken(rawName).baseName;

    classMap.get(rawName)!.push({
      rawName,
      baseName,
      teacher,
      weekday,
      startMinutes,
      endMinutes,
    });
  }

  // 3. 整理 49 班資訊
  const classes: ClassScheduleItem[] = classOrder.map((rawName) => {
    const sessions = classMap.get(rawName)!;
    const baseName = parseSingleClassToken(rawName).baseName;
    const teacher = sessions[0]?.teacher ?? null;

    let source: 'schedule' | 'care_window' | 'empty' = 'schedule';
    if (CARE_WINDOW_CLASSES.has(rawName)) {
      source = 'care_window';
    } else if (sessions.every((s) => s.startMinutes === null && s.endMinutes === null)) {
      source = 'empty';
    }

    return {
      rawName,
      baseName,
      source,
      teacher,
      sessions,
    };
  });

  return {
    sourceHash,
    totalSessionRows,
    classes,
    careWindows: {
      anqin: {
        startMinutes: anqinStart,
        endMinutes: anqinEnd,
        weekdayText: anqinWeekday,
      },
      tutoring: {
        startMinutes: tutoringStart,
        endMinutes: tutoringEnd,
        weekdayText: tutoringWeekday,
      },
    },
  };
}

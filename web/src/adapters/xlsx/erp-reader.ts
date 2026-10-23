import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  StudentSnapshot,
  parseGrade,
  parseClassTokens,
  projectLegacyImportTierEvidence,
  matchHeaders,
  HeaderMatchResult,
} from '@/domain/students';

export interface ErpReaderOptions {
  fileName?: string;
  targetSheet?: string;
  maxFileSizeBytes?: number;
  maxUncompressedBytes?: number;
}

export interface ErpWorkbookResult {
  fileName: string;
  sheetName: string;
  candidateSheets: string[];
  headerRowIndex: number;
  headers: Record<string, number>;
  extraHeaders: string[];
  totalRows: number;
  studentsWithClass: number;
  studentsWithoutClass: number;
  students: StudentSnapshot[];
  issues: string[];
}

export class ErpReaderError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = 'ErpReaderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const DEFAULT_MAX_UNCOMPRESSED_SIZE = 60 * 1024 * 1024; // 60 MB
const MAX_EXPANSION_RATIO = 50; // 防範 ZIP bomb

/**
 * 將 ExcelJS Cell 內容安全轉換為純文字。
 * 處理 RichText、Date、Number、String，並偵測禁止的 Formula。
 */
function extractCellValue(
  cell: ExcelJS.Cell,
  fieldName: string,
  rowNumber: number
): string {
  if (cell.value === null || cell.value === undefined) {
    return '';
  }

  // I13: 檢查是否包含公式
  if (
    cell.type === ExcelJS.ValueType.Formula ||
    (typeof cell.value === 'object' && 'formula' in cell.value)
  ) {
    throw new ErpReaderError(
      `第 ${rowNumber} 列「${fieldName}」包含公式，系統為安全考量拒絕包含公式之檔案，請先於 Excel 轉為值重新匯出。`,
      'FORMULA_NOT_ALLOWED',
      422
    );
  }

  // 處理 RichText
  if (typeof cell.value === 'object') {
    if ('richText' in cell.value && Array.isArray(cell.value.richText)) {
      return cell.value.richText
        .map((part) => part.text || '')
        .join('')
        .trim()
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    }
    if (cell.value instanceof Date) {
      return cell.value.toISOString().split('T')[0];
    }
    if ('text' in cell.value && typeof cell.value.text === 'string') {
      return cell.value.text
        .trim()
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    }
  }

  return String(cell.value)
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * 讀取並驗證 ERP 學生名單試算表 (XLSX)。
 * 涵蓋安全檢查、工作表辨識、標頭匹配與資料正規化。
 */
export async function readErpWorkbook(
  input: Buffer | Uint8Array,
  options: ErpReaderOptions = {}
): Promise<ErpWorkbookResult> {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const fileName = options.fileName || 'upload.xlsx';

  // 1. 檢查檔案大小限制 (I13)
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  if (buf.length > maxFileSizeBytes) {
    throw new ErpReaderError(
      `上傳檔案大小 (${(buf.length / 1024 / 1024).toFixed(2)} MB) 超過大小限制 (${(maxFileSizeBytes / 1024 / 1024).toFixed(2)} MB)`,
      'FILE_TOO_LARGE',
      413
    );
  }

  // 2. 檢查 ZIP 結構與 ZIP Bomb 防護 (I13)
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (_e) {
    throw new ErpReaderError(
      '檔案非不合法的 XLSX 試算表（非有效 ZIP 壓縮包）',
      'INVALID_XLSX',
      400
    );
  }

  // 驗證核心 XLSX 元件
  if (!zip.file('xl/workbook.xml') || !zip.file('[Content_Types].xml')) {
    throw new ErpReaderError(
      '不合法的 XLSX 檔案格式（缺少必要之 OpenXML 描述檔）',
      'INVALID_XLSX',
      400
    );
  }

  // 檢查展開大小與展開倍率
  let totalUncompressedSize = 0;
  const maxUncompressedBytes = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_SIZE;

  zip.forEach((_relativePath, file) => {
    const fileData = (file as unknown as { _data?: { isEncrypted?: boolean; uncompressedSize?: number } })._data;
    if (fileData?.isEncrypted) {
      throw new ErpReaderError('不支援加密或帶密碼之試算表檔案', 'ENCRYPTED_FILE', 422);
    }
    const uncompressed = fileData?.uncompressedSize || 0;
    totalUncompressedSize += uncompressed;
  });

  if (
    totalUncompressedSize > maxUncompressedBytes ||
    (buf.length > 0 && totalUncompressedSize / buf.length > MAX_EXPANSION_RATIO)
  ) {
    throw new ErpReaderError(
      '檔案解壓縮展開大小超過安全限制（防範 ZIP 炸彈）',
      'ZIP_BOMB_DETECTED',
      422
    );
  }

  // 3. 使用 ExcelJS 載入試算表
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf as unknown as ArrayBuffer);

  // 4. 工作表辨識 (I04)
  const candidateSheets: { sheetName: string; headerMatch: HeaderMatchResult }[] = [];

  for (const ws of workbook.worksheets) {
    // 掃描前 20 列
    const maxScanRows = Math.min(20, ws.rowCount || 20);
    for (let r = 1; r <= maxScanRows; r++) {
      const row = ws.getRow(r);
      const rowValues: (string | null | undefined)[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        rowValues[colNumber] = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
      });

      const match = matchHeaders(rowValues, r);
      if (match.isValid) {
        candidateSheets.push({ sheetName: ws.name, headerMatch: match });
        break; // 該工作表找到標頭列即停止往下找
      }
    }
  }

  let selectedCandidate: { sheetName: string; headerMatch: HeaderMatchResult } | undefined;

  if (options.targetSheet) {
    selectedCandidate = candidateSheets.find((c) => c.sheetName === options.targetSheet);
  }

  if (!selectedCandidate) {
    // 優先選 Sheet1
    selectedCandidate = candidateSheets.find((c) => c.sheetName === 'Sheet1') || candidateSheets[0];
  }

  if (!selectedCandidate) {
    // 若所有工作表前 20 列皆未找到有效標頭，取第一個工作表檢驗詳細缺失原因以拋出明確錯誤
    const firstWs = workbook.worksheets[0];
    if (!firstWs) {
      throw new ErpReaderError('活頁簿中沒有任何工作表', 'EMPTY_WORKBOOK', 400);
    }
    const row1 = firstWs.getRow(1);
    const rowValues: (string | null | undefined)[] = [];
    row1.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      rowValues[colNumber] = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
    });
    const match = matchHeaders(rowValues, 1);
    if (match.duplicateHeaders.length > 0) {
      throw new ErpReaderError(
        `標頭列含有重複標頭: ${match.duplicateHeaders.join(', ')}`,
        'DUPLICATE_HEADERS',
        422
      );
    }
    throw new ErpReaderError(
      `試算表前 20 列未找到完整標頭列，缺少必要標頭: ${match.missingRequired.join(', ')}`,
      'MISSING_REQUIRED_HEADERS',
      422
    );
  }

  const { sheetName, headerMatch } = selectedCandidate;
  const ws = workbook.getWorksheet(sheetName);
  if (!ws) {
    throw new ErpReaderError(`工作表 ${sheetName} 不存在`, 'SHEET_NOT_FOUND', 404);
  }

  // 5. 資料列解析 (I01, I02, I05, I06)
  const students: StudentSnapshot[] = [];
  const seenPersonCodes = new Set<string>();
  const issues: string[] = [];
  let studentsWithClass = 0;
  let studentsWithoutClass = 0;

  const headerIndices = headerMatch.indices;

  const startRow = headerMatch.headerRowIndex + 1;
  const endRow = ws.rowCount;

  for (let r = startRow; r <= endRow; r++) {
    const row = ws.getRow(r);

    // 檢查整列是否完全空白 (I05)
    let hasAnyValue = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== undefined && String(cell.value).trim() !== '') {
        hasAnyValue = true;
      }
    });
    if (!hasAnyValue) {
      continue; // 完全空白列跳過
    }

    // 讀取必要與選用欄位
    const personCode = extractCellValue(row.getCell(headerIndices['人員代碼']), '人員代碼', r);
    const name = extractCellValue(row.getCell(headerIndices['姓名']), '姓名', r);
    const branch = extractCellValue(row.getCell(headerIndices['所屬分校']), '所屬分校', r) || null;
    const classText = extractCellValue(row.getCell(headerIndices['所屬班級']), '所屬班級', r) || null;
    const gradeRaw = extractCellValue(row.getCell(headerIndices['年級']), '年級', r) || null;
    const tagsRaw = extractCellValue(row.getCell(headerIndices['標籤']), '標籤', r) || null;
    const notesRaw = extractCellValue(row.getCell(headerIndices['備註']), '備註', r) || null;

    const contact = headerIndices['聯絡方式'] !== undefined
      ? extractCellValue(row.getCell(headerIndices['聯絡方式']), '聯絡方式', r) || null
      : null;
    const schoolInfo = headerIndices['就學資料'] !== undefined
      ? extractCellValue(row.getCell(headerIndices['就學資料']), '就學資料', r) || null
      : null;

    if (!personCode) {
      issues.push(`第 ${r} 列未填寫人員代碼，已略過。`);
      continue;
    }

    // I06: 檢查人員代碼重複 (同代碼兩列)
    if (seenPersonCodes.has(personCode)) {
      throw new ErpReaderError(
        `第 ${r} 列偵測到重複人員代碼: ${personCode}，批次內人員代碼必須唯一`,
        'DUPLICATE_PERSON_CODE',
        422
      );
    }
    seenPersonCodes.add(personCode);

    // 解析班名 Token
    const enrollments = parseClassTokens(classText).map(projectLegacyImportTierEvidence);
    if (enrollments.length > 0) {
      studentsWithClass++;
    } else {
      studentsWithoutClass++;
    }

    // 解析年級
    const { grade, status: gradeStatus } = parseGrade(gradeRaw);

    // 整理標籤清單
    const tags = tagsRaw
      ? tagsRaw
          .split(/[,;\s]+/)
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [];

    students.push({
      personCode,
      name,
      branch,
      gradeRaw,
      grade,
      gradeStatus,
      contact,
      schoolInfo,
      tagsRaw,
      tags,
      notesRaw,
      enrollments,
      sourceRow: r,
    });
  }

  return {
    fileName,
    sheetName,
    candidateSheets: candidateSheets.map((c) => c.sheetName),
    headerRowIndex: headerMatch.headerRowIndex,
    headers: headerMatch.indices,
    extraHeaders: headerMatch.extraHeaders,
    totalRows: students.length,
    studentsWithClass,
    studentsWithoutClass,
    students,
    issues,
  };
}

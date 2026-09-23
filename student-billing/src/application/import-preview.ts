import crypto from 'crypto';
import { readErpWorkbook, ErpReaderOptions } from '@/adapters/xlsx/erp-reader';
import { StudentSnapshot } from '@/domain/students';

export interface ImportStats {
  totalStudents: number;
  studentsWithClass: number;
  studentsWithoutClass: number;
  withdrawnStudentsCount: number;
  gradeCounts: Record<string, number>;
}

export interface ImportPreviewResult {
  previewId: string;
  fileName: string;
  fileHash: string;
  contentHash: string;
  sheetName: string;
  candidateSheets: string[];
  headerRowIndex: number;
  stats: ImportStats;
  headerMapping: Record<string, number>;
  extraHeaders: string[];
  pendingClasses: string[];
  issues: string[];
  students: StudentSnapshot[];
  scopeNote: string;
}

/**
 * 計算內容雜湊 (contentHash)，依據排序後之正規化資料產生，
 * 供判斷同內容但不同檔名之上傳 (03 §3, I07)。
 */
function computeContentHash(students: StudentSnapshot[]): string {
  const hash = crypto.createHash('sha256');
  const sorted = [...students].sort((a, b) => a.personCode.localeCompare(b.personCode));

  for (const s of sorted) {
    const rawTokens = s.enrollments.map((e) => e.rawToken).join('|');
    const line = `${s.personCode}\t${s.name}\t${s.branch || ''}\t${s.gradeRaw || ''}\t${rawTokens}\t${s.tagsRaw || ''}\t${s.notesRaw || ''}\n`;
    hash.update(line);
  }

  return hash.digest('hex');
}

/**
 * 產生匯入預覽。
 * 執行讀取驗證、去重人數統計、班級標記歸納與 contentHash 計算。
 */
export async function generateImportPreview(
  fileBuffer: Buffer | Uint8Array,
  fileName: string,
  options: ErpReaderOptions = {}
): Promise<ImportPreviewResult> {
  const buf = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
  const fileHash = crypto.createHash('sha256').update(buf).digest('hex');

  const readResult = await readErpWorkbook(buf, { ...options, fileName });

  const contentHash = computeContentHash(readResult.students);
  const previewId = `prev_${fileHash.substring(0, 16)}_${Date.now()}`;

  // 統計離班人數與年級分佈
  let withdrawnStudentsCount = 0;
  const gradeCounts: Record<string, number> = {};
  const pendingBaseNames = new Set<string>();

  for (const s of readResult.students) {
    // 檢查是否有任一班級帶有離班日期
    const hasWithdrawal = s.enrollments.some((e) => e.withdrawalDate !== null);
    if (hasWithdrawal) {
      withdrawnStudentsCount++;
    }

    // 年級計數
    const gradeLabel = s.grade !== null ? `${s.grade}年級` : s.gradeRaw || '未識別';
    gradeCounts[gradeLabel] = (gradeCounts[gradeLabel] || 0) + 1;

    // 收集班名 baseName
    for (const e of s.enrollments) {
      if (e.baseName) {
        pendingBaseNames.add(e.baseName);
      }
    }
  }

  const stats: ImportStats = {
    totalStudents: readResult.totalRows,
    studentsWithClass: readResult.studentsWithClass,
    studentsWithoutClass: readResult.studentsWithoutClass,
    withdrawnStudentsCount,
    gradeCounts,
  };

  const scopeNote = `來源試算表共有 ${readResult.totalRows} 筆學生，其中 ${readResult.studentsWithClass} 人有報名班級，${readResult.studentsWithoutClass} 人無班級。`;

  return {
    previewId,
    fileName: readResult.fileName,
    fileHash,
    contentHash,
    sheetName: readResult.sheetName,
    candidateSheets: readResult.candidateSheets,
    headerRowIndex: readResult.headerRowIndex,
    stats,
    headerMapping: readResult.headers,
    extraHeaders: readResult.extraHeaders,
    pendingClasses: Array.from(pendingBaseNames).sort(),
    issues: readResult.issues,
    students: readResult.students,
    scopeNote,
  };
}

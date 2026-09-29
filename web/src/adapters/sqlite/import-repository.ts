import Database from 'better-sqlite3';
import { StudentSnapshot } from '@/domain/students';

export interface ImportBatchRecord {
  id: string;
  fileName: string;
  fileHash: string;
  contentHash: string;
  sheetName: string;
  headerMap: Record<string, number>;
  parserVersion: string;
  scopeNote: string;
  rowCount: number;
  status: 'uploaded' | 'parsed' | 'ready' | 'calculating' | 'completed';
  createdAt: string;
}

export interface SaveImportBatchResult {
  isDuplicate: boolean;
  duplicateReason?: 'same_file' | 'same_content';
  batchId: string;
}

/**
 * 儲存已驗證之匯入批次及其學生與報名快照至 SQLite。
 * 在單一交易內完成；若已存在相同 file_hash 或 content_hash 則回傳重複提示。
 */
export function saveImportBatch(
  db: Database.Database,
  batch: ImportBatchRecord,
  students: StudentSnapshot[]
): SaveImportBatchResult {
  // 檢查是否已存在相同 file_hash (同檔再上傳)
  const existingFile = db
    .prepare('SELECT id FROM import_batches WHERE file_hash = ? LIMIT 1')
    .get(batch.fileHash) as { id: string } | undefined;

  if (existingFile) {
    return {
      isDuplicate: true,
      duplicateReason: 'same_file',
      batchId: existingFile.id,
    };
  }

  // 檢查是否已存在相同 content_hash (不同檔名同內容)
  const existingContent = db
    .prepare('SELECT id FROM import_batches WHERE content_hash = ? LIMIT 1')
    .get(batch.contentHash) as { id: string } | undefined;

  if (existingContent) {
    return {
      isDuplicate: true,
      duplicateReason: 'same_content',
      batchId: existingContent.id,
    };
  }

  const insertTransaction = db.transaction(() => {
    // 1. 寫入批次表
    const insertBatch = db.prepare(`
      INSERT INTO import_batches (
        id, file_name, file_hash, content_hash, sheet_name, header_map,
        parser_version, scope_note, row_count, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertBatch.run(
      batch.id,
      batch.fileName,
      batch.fileHash,
      batch.contentHash,
      batch.sheetName,
      JSON.stringify(batch.headerMap),
      batch.parserVersion,
      batch.scopeNote,
      batch.rowCount,
      batch.status,
      batch.createdAt
    );

    // 2. 寫入學生快照
    const insertStudent = db.prepare(`
      INSERT INTO imported_students (
        id, import_id, person_code, name, branch, grade_raw, grade,
        grade_status, contact, school_info, tags_raw, notes_raw, source_row, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 3. 寫入報名班級快照
    const insertEnrollment = db.prepare(`
      INSERT INTO student_enrollments (
        id, import_id, person_code, token_index, raw_token, year_prefix,
        base_name, group_flag, modifiers, withdrawal_date, erp_billing_tier_raw,
        erp_billing_tier, tier_parse_status, parse_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();

    for (const s of students) {
      const studentId = `${batch.id}_${s.personCode}`;
      insertStudent.run(
        studentId,
        batch.id,
        s.personCode,
        s.name,
        s.branch,
        s.gradeRaw,
        s.grade,
        s.gradeStatus,
        s.contact,
        s.schoolInfo,
        s.tagsRaw,
        s.notesRaw,
        s.sourceRow,
        now
      );

      s.enrollments.forEach((enr, idx) => {
        const enrollmentId = `${studentId}_${idx}`;
        insertEnrollment.run(
          enrollmentId,
          batch.id,
          s.personCode,
          idx,
          enr.rawToken,
          enr.yearPrefix,
          enr.baseName,
          enr.groupFlag,
          JSON.stringify(enr.modifiers),
          enr.withdrawalDate,
          enr.erpBillingTierRaw,
          enr.erpBillingTier,
          enr.tierParseStatus,
          enr.parseStatus,
          now
        );
      });
    }
  });

  insertTransaction();

  return {
    isDuplicate: false,
    batchId: batch.id,
  };
}

/**
 * 讀回某匯入批次的學生快照（含報名 token），順序依來源列。
 * 名單差異（application/import-roster-diff.ts）與設定影響預覽（settings-preview.ts）共用，
 * 兩處都必須以同一種方式還原 StudentSnapshot，before/after 計算才會一致。
 */
export function loadStudentsForImport(db: Database.Database, importId: string): StudentSnapshot[] {
  const studentRows = db
    .prepare('SELECT * FROM imported_students WHERE import_id = ? ORDER BY source_row ASC')
    .all(importId) as any[];
  const enrollmentRows = db
    .prepare('SELECT * FROM student_enrollments WHERE import_id = ? ORDER BY person_code ASC, token_index ASC')
    .all(importId) as any[];
  const map: Record<string, any[]> = {};
  for (const r of enrollmentRows) {
    (map[r.person_code] ??= []).push({
      rawToken: r.raw_token,
      yearPrefix: r.year_prefix,
      baseName: r.base_name,
      groupFlag: r.group_flag,
      modifiers: r.modifiers ? JSON.parse(r.modifiers) : [],
      withdrawalDate: r.withdrawal_date,
      erpBillingTierRaw: r.erp_billing_tier_raw,
      erpBillingTier: r.erp_billing_tier,
      tierParseStatus: r.tier_parse_status,
      parseStatus: r.parse_status,
    });
  }
  return studentRows.map((row) => ({
    personCode: row.person_code,
    name: row.name,
    branch: row.branch,
    gradeRaw: row.grade_raw,
    grade: row.grade,
    gradeStatus: row.grade_status,
    contact: row.contact,
    schoolInfo: row.school_info,
    tagsRaw: row.tags_raw,
    tags: row.tags_raw ? row.tags_raw.split(/[,;\s]+/).filter(Boolean) : [],
    notesRaw: row.notes_raw,
    enrollments: map[row.person_code] || [],
    sourceRow: row.source_row,
  }));
}

/**
 * 依 ID 取得匯入批次記錄。
 */
export function getImportBatch(
  db: Database.Database,
  id: string
): ImportBatchRecord | null {
  const row = db
    .prepare('SELECT * FROM import_batches WHERE id = ?')
    .get(id) as any;

  if (!row) return null;

  return {
    id: row.id,
    fileName: row.file_name,
    fileHash: row.file_hash,
    contentHash: row.content_hash,
    sheetName: row.sheet_name,
    headerMap: row.header_map ? JSON.parse(row.header_map) : {},
    parserVersion: row.parser_version,
    scopeNote: row.scope_note,
    rowCount: row.row_count,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * 取得最新一筆已就緒 (ready) 之匯入批次。
 */
export function getLatestReadyBatch(
  db: Database.Database
): ImportBatchRecord | null {
  const row = db
    .prepare("SELECT * FROM import_batches WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1")
    .get() as any;

  if (!row) return null;

  return {
    id: row.id,
    fileName: row.file_name,
    fileHash: row.file_hash,
    contentHash: row.content_hash,
    sheetName: row.sheet_name,
    headerMap: row.header_map ? JSON.parse(row.header_map) : {},
    parserVersion: row.parser_version,
    scopeNote: row.scope_note,
    rowCount: row.row_count,
    status: row.status,
    createdAt: row.created_at,
  };
}

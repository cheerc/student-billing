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
 * 新舊名單差異（specs/09 §4）：比較本次上傳的學生與「現行名單」（active_state 的 active_import_id，
 * 無 active run 時取最新 ready 批次）之去重人員代碼與報名 token 集合。
 * 學生比較身分為 person_code ＋ 排序後的報名 token 集合（token 集合相同即為未異動，
 * 避免 token 順序造成假異動）；只回數量，不回學生個資。
 */
export interface RosterDiff {
  /** 基準名單 id；null 表示尚無任何名單可比較 */
  baseImportId: string | null;
  newStudents: number;
  changedStudents: number;
  unchangedStudents: number;
  /** 本次名單未出現的學生數（相對於基準名單） */
  notAppearedStudents: number;
}

/** 某 import_id 下去重人員代碼 → 排序後報名 token 集合之指紋。 */
function rosterFingerprints(db: Database.Database, importId: string): Map<string, string> {
  const studentRows = db
    .prepare('SELECT DISTINCT person_code FROM imported_students WHERE import_id = ?')
    .all(importId) as Array<{ person_code: string }>;
  const tokenRows = db
    .prepare('SELECT person_code, raw_token FROM student_enrollments WHERE import_id = ? ORDER BY person_code ASC, token_index ASC')
    .all(importId) as Array<{ person_code: string; raw_token: string }>;

  const tokens = new Map<string, string[]>();
  for (const r of tokenRows) {
    const arr = tokens.get(r.person_code) ?? [];
    arr.push(r.raw_token);
    tokens.set(r.person_code, arr);
  }

  const out = new Map<string, string>();
  for (const s of studentRows) {
    // 以排序去重後的 token 集合為指紋，token 順序變動不算異動
    const fingerprint = [...new Set(tokens.get(s.person_code) ?? [])].sort().join('|');
    out.set(s.person_code, fingerprint);
  }
  return out;
}

/**
 * 計算本次名單相對於現行名單的差異統計。
 * 尚無現行名單時回傳 baseImportId:null 與全為 null 的統計（由呼叫端決定如何呈現）。
 */
export function computeRosterDiff(
  db: Database.Database,
  newImportId: string,
  baseImportId: string | null
): RosterDiff {
  if (!baseImportId || baseImportId === newImportId) {
    return {
      baseImportId: null,
      newStudents: 0,
      changedStudents: 0,
      unchangedStudents: 0,
      notAppearedStudents: 0,
    };
  }

  const incoming = rosterFingerprints(db, newImportId);
  const baseline = rosterFingerprints(db, baseImportId);

  let newStudents = 0;
  let changedStudents = 0;
  let unchangedStudents = 0;
  for (const [personCode, fingerprint] of incoming) {
    const before = baseline.get(personCode);
    if (before === undefined) {
      newStudents += 1;
    } else if (before === fingerprint) {
      unchangedStudents += 1;
    } else {
      changedStudents += 1;
    }
  }

  let notAppearedStudents = 0;
  for (const personCode of baseline.keys()) {
    if (!incoming.has(personCode)) {
      notAppearedStudents += 1;
    }
  }

  return { baseImportId, newStudents, changedStudents, unchangedStudents, notAppearedStudents };
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { queryRunStudents, getStudentCalculationDetail } from '@/application/query-students';
import { queryImportStudents } from '@/application/roster-query';
import { GET as studentsGET } from '@/app/api/v1/runs/[runId]/students/route';

describe('D3 Task 4+5: 班級全文重組＋分校集合篩選＋列表脫敏 (erp-field-preservation)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let importId: string;
  let runId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pr3-orig-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
    process.env.DATABASE_PATH = tempDbPath;
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    const db = getDatabase();
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const buf = fs.readFileSync(fixturePath);
    const preview = await generateImportPreview(buf, 'fixture.xlsx');
    importId = preview.previewId;
    saveImportBatch(
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
    const act = activateImport(db, {
      importId,
      expectedRevision: 0,
      idempotencyKey: `pr3-setup-${Date.now()}-${Math.random()}`,
    });
    runId = act.runId;
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. [RED Task4] 學生明細應攜帶 classText：enrollments 按 token_index 升冪以換行拼回', async () => {
    const db = getDatabase();
    // 找出一個多報名學生
    const multi = db
      .prepare(
        `SELECT person_code, COUNT(*) c FROM student_enrollments WHERE import_id = ? GROUP BY person_code HAVING c > 1 LIMIT 1`
      )
      .get(importId) as any;
    expect(multi).toBeDefined();

    const res = queryRunStudents(db, runId, { limit: 200 });
    const item = res.items.find((s) => s.personCode === multi.person_code);
    expect(item).toBeDefined();
    // classText 由 enrollments rawToken 依序以 \n 拼回
    const expected = item!.enrollments.map((e) => e.rawToken).join('\n');
    expect((item as any).classText).toBe(expected);
  });

  it('2. [RED Task5] 分校集合篩選：複值分校學生應被任一子分校命中，且不重複計數', async () => {
    const db = getDatabase();
    // 找出一個換行複值分校學生
    const row = db
      .prepare(
        `SELECT person_code, branch FROM imported_students WHERE import_id = ? AND branch LIKE '%' || char(10) || '%' LIMIT 1`
      )
      .get(importId) as any;
    expect(row).toBeDefined();

    const tokens = String(row.branch)
      .split(/[\r\n]+/)
      .map((t: string) => t.trim())
      .filter(Boolean);
    expect(tokens.length).toBeGreaterThan(1);

    // 用其中一個子分校篩選：該生必須命中
    const res = queryRunStudents(db, runId, { branch: tokens[0], limit: 200 });
    const codes = res.items.map((s) => s.personCode);
    expect(codes).toContain(row.person_code);
    // 去重：同一人不應出現兩次
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('3. [RED Task5] 列表脫敏：students 列表不回傳完整電話與備註全文，僅 hasNotes；明細端點按需回完整原文', async () => {
    const req = new NextRequest(
      `http://127.0.0.1:3000/api/v1/runs/${runId}/students?limit=5`
    );
    const res = await studentsGET(req, {
      params: Promise.resolve({ runId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);

    for (const item of body.items) {
      // trace.rawNotes 不得為完整原文（僅 hasNotes 布林）
      expect(item.trace?.rawNotes).toBeUndefined();
      expect(typeof item.trace?.hasNotes).toBe('boolean');
      // N2: 列表 API 不得外洩完整電話 (contact 欄位)
      expect((item as any).contact).toBeUndefined();
    }

    // 明細查完整原文
    const db = getDatabase();
    const code = body.items[0].personCode;
    const detail = getStudentCalculationDetail(db, runId, code);
    expect(detail).toBeDefined();
    expect(detail!.trace).toBeDefined();
  });

  it('4. [RED F1 CRLF] CRLF 換行之分校篩選與班級全文重組應精確匹配與等價', async () => {
    const db = getDatabase();
    // 注入一筆帶有 CRLF (\r\n) 分校與班級的學生資料
    const crlfPersonCode = 'STU_CRLF_TEST';
    db.prepare(`
      INSERT INTO imported_students (
        id, import_id, person_code, name, branch, grade_raw, grade,
        grade_status, contact, school_info, tags_raw, notes_raw, source_row, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${importId}_${crlfPersonCode}`,
      importId,
      crlfPersonCode,
      'CRLF學生',
      '北投分校\r\n士林分校\r\n天母分校',
      '4',
      4,
      'valid',
      '0912345678',
      '國小',
      null,
      '測試CRLF',
      999,
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO student_calculations (
        id, run_id, person_code, name, branch, grade_raw, grade,
        subject_count, base_discount_bps, anqin_days, anqin_display,
        tutoring_days, tutoring_display, english_days, math_days, chinese_days,
        homework_days, intensive_english_days, saturday_tutoring_days,
        applicable_anqin_bps, applicable_tutoring_bps, applicable_english_bps, applicable_math_bps,
        tier_mismatch, tier_comparisons, issues, has_issues, trace, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `calc_${runId}_${crlfPersonCode}`,
      runId,
      crlfPersonCode,
      'CRLF學生',
      '北投分校\r\n士林分校\r\n天母分校',
      '4',
      4,
      1,
      0,
      5,
      '5',
      0,
      '0',
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      '[]',
      '[]',
      0,
      JSON.stringify({ rawNotes: '測試CRLF' }),
      new Date().toISOString()
    );

    // 測試 roster-query 與 query-students 分校集合篩選（子分校應分別命中）
    for (const b of ['北投分校', '士林分校', '天母分校']) {
      // 1. roster-query (預覽名單查詢)
      const rosterRes = queryImportStudents(db, importId, { branch: b });
      const rosterCodes = rosterRes.items.map((s) => s.personCode);
      expect(rosterCodes, `roster-query 篩選 ${b} 應包含 CRLF 學生`).toContain(crlfPersonCode);

      // 2. query-students (正式 run 查詢)
      const runRes = queryRunStudents(db, runId, { branch: b });
      const runCodes = runRes.items.map((s) => s.personCode);
      expect(runCodes, `queryRunStudents 篩選 ${b} 應包含 CRLF 學生`).toContain(crlfPersonCode);
    }

    // 注入 enrollments 測試班級全文重組
    db.prepare(`
      INSERT INTO student_enrollments (
        id, import_id, person_code, token_index, raw_token, year_prefix,
        base_name, group_flag, modifiers, withdrawal_date, erp_billing_tier_raw,
        erp_billing_tier, tier_parse_status, parse_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${importId}_${crlfPersonCode}_0`,
      importId,
      crlfPersonCode,
      0,
      '115國小輔導-四年級A[團][4_5]',
      '115',
      '國小輔導-四年級A',
      '團',
      '["4_5"]',
      null,
      '4_5',
      4.5,
      'parsed',
      'ok',
      new Date().toISOString()
    );
    db.prepare(`
      INSERT INTO student_enrollments (
        id, import_id, person_code, token_index, raw_token, year_prefix,
        base_name, group_flag, modifiers, withdrawal_date, erp_billing_tier_raw,
        erp_billing_tier, tier_parse_status, parse_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${importId}_${crlfPersonCode}_1`,
      importId,
      crlfPersonCode,
      1,
      '國小數學-三A[團]',
      null,
      '國小數學-三A',
      '團',
      '[]',
      null,
      null,
      null,
      'not_applicable',
      'ok',
      new Date().toISOString()
    );

    // 斷言列表與明細端點 classText 乾淨重組為 LF，不含 \r
    const crlfRunRes = queryRunStudents(db, runId, { q: 'CRLF學生' });
    const crlfItem = crlfRunRes.items.find((s) => s.personCode === crlfPersonCode);
    expect(crlfItem).toBeDefined();
    expect(crlfItem!.classText).toBe('115國小輔導-四年級A[團][4_5]\n國小數學-三A[團]');
    expect(crlfItem!.classText).not.toContain('\r');

    const crlfDetail = getStudentCalculationDetail(db, runId, crlfPersonCode);
    expect(crlfDetail).toBeDefined();
    expect(crlfDetail!.classText).toBe('115國小輔導-四年級A[團][4_5]\n國小數學-三A[團]');
    expect(crlfDetail!.classText).not.toContain('\r');

    // 3. 測試真實 Excel 活頁簿匯入帶有 CRLF 的分校與班級
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    ws.addRow([
      'STU_XLSX_CRLF',
      '試算表CRLF生',
      '板橋分校\r\n新莊分校\r\n三重分校',
      '115國小輔導-五年級B[團][5]\r\n兒童美語-EB[團]',
      '5',
      '安親\r\n英文',
      '備註第1行\r\n備註第2行',
    ]);
    const xlsxBuf = await wb.xlsx.writeBuffer();
    const xlsxPreview = await generateImportPreview(Buffer.from(xlsxBuf), 'crlf.xlsx');
    expect(xlsxPreview.students.length).toBe(1);
    const stu = xlsxPreview.students[0];
    // 斷言匯入解析出的 branch 已統一正規化為 LF（無 \r）
    expect(stu.branch).toBe('板橋分校\n新莊分校\n三重分校');
    expect(stu.branch).not.toContain('\r');
    // 斷言班級 enrollments 正確切出 2 筆，無 \r 殘留
    expect(stu.enrollments).toHaveLength(2);
    expect(stu.enrollments[0].rawToken).toBe('115國小輔導-五年級B[團][5]');
    expect(stu.enrollments[1].rawToken).toBe('兒童美語-EB[團]');
    expect(stu.enrollments[0].rawToken).not.toContain('\r');
    expect(stu.enrollments[1].rawToken).not.toContain('\r');

    // 儲存並啟用此批次，驗證端到端查詢
    saveImportBatch(
      db,
      {
        id: xlsxPreview.previewId,
        fileName: xlsxPreview.fileName,
        fileHash: xlsxPreview.fileHash,
        contentHash: xlsxPreview.contentHash,
        sheetName: xlsxPreview.sheetName,
        headerMap: xlsxPreview.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: xlsxPreview.scopeNote,
        rowCount: xlsxPreview.stats.totalStudents,
        status: 'ready',
        createdAt: new Date().toISOString(),
      },
      xlsxPreview.students
    );
    const crlfAct = activateImport(db, {
      importId: xlsxPreview.previewId,
      expectedRevision: 1,
      idempotencyKey: `crlf-act-${Date.now()}`,
    });

    for (const subBranch of ['板橋分校', '新莊分校', '三重分校']) {
      const pRes = queryImportStudents(db, xlsxPreview.previewId, { branch: subBranch });
      expect(pRes.items.map((s) => s.personCode)).toContain('STU_XLSX_CRLF');

      const rRes = queryRunStudents(db, crlfAct.runId, { branch: subBranch });
      expect(rRes.items.map((s) => s.personCode)).toContain('STU_XLSX_CRLF');
    }

    const xlsxDetail = getStudentCalculationDetail(db, crlfAct.runId, 'STU_XLSX_CRLF');
    expect(xlsxDetail).toBeDefined();
    expect(xlsxDetail!.classText).toBe('115國小輔導-五年級B[團][5]\n兒童美語-EB[團]');
    expect(xlsxDetail!.classText).not.toContain('\r');
  });
});

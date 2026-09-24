import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { queryRunStudents } from '@/application/query-students';
import { queryImportStudents } from '@/application/roster-query';
import { GET as studentsGET } from '@/app/api/v1/runs/[runId]/students/route';
import { GET as studentDetailGET } from '@/app/api/v1/runs/[runId]/students/[personCode]/route';

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
    }

    // 明細端點按需回完整原文
    const code = body.items[0].personCode;
    const detailReq = new NextRequest(
      `http://127.0.0.1:3000/api/v1/runs/${runId}/students/${code}`
    );
    const detailRes = await studentDetailGET(detailReq, {
      params: Promise.resolve({ runId, personCode: code }),
    });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    // 明細仍可查到 enrollments（供全文重組）與 trace 結構
    expect(detail.trace).toBeDefined();
  });
});

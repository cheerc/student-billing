import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport, ActivateConflictError } from '@/application/activate-import';
import { executeCalculationRun } from '@/application/calculate-run';
import { queryRunStudents, getStudentCalculationDetail } from '@/application/query-students';
import { saveApprovedLegacyMigrationFixtureSettings } from '../helpers/d1-test-kit';

describe('T04: 計算生命週期、CAS 409 啟用與總表查詢整合測試 (I09, I16, I17)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let db: any;
  let previewId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-activate-test-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
    db = createDatabase(tempDbPath);
    runMigrations(db);

    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const buf = fs.readFileSync(fixturePath);
    const preview = await generateImportPreview(buf, 'fixture.xlsx');
    previewId = preview.previewId;

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
    await saveApprovedLegacyMigrationFixtureSettings(db, 'approved-legacy-migration');
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('首次 revision=0 啟用成功，activeState 更新且 revision 遞增為 1', () => {
    const res = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 'key-001',
    });

    expect(res.status).toBe('completed');
    expect(res.revision).toBe(1);
    expect(res.activeRunId).toBeDefined();

    // 檢查 active_state 表
    const active = db.prepare('SELECT * FROM active_state WHERE id = 1').get() as any;
    expect(active.revision).toBe(1);
    expect(active.active_run_id).toBe(res.activeRunId);
    expect(active.active_import_id).toBe(previewId);
  });

  it('CAS 409 衝突防護：版本不符時拒絕並拋出 409，資料庫維持不變', () => {
    // 先成功啟用一次，版本變為 1
    activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 'key-001',
    });

    // 另一個客戶端傳入舊版本 expectedRevision: 0 嘗試啟用
    expect(() => {
      activateImport(db, {
        importId: previewId,
        expectedRevision: 0,
        idempotencyKey: 'key-002',
      });
    }).toThrowError(ActivateConflictError);

    // 驗證 active_state 仍為版本 1
    const active = db.prepare('SELECT * FROM active_state WHERE id = 1').get() as any;
    expect(active.revision).toBe(1);
  });

  it('冪等性重送：相同 key 與 body 重送應成功回傳原結果', () => {
    const res1 = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 'key-idempotent-1',
    });

    const res2 = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 'key-idempotent-1',
    });

    expect(res2.runId).toBe(res1.runId);
    expect(res2.revision).toBe(res1.revision);
  });

  it('I16 & I17: 5 筆級距 mismatch 驗收與 13 人缺排課 match + hasIssues 同時成立驗證', () => {
    const actRes = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 'key-verify-i17',
    });
    const runId = actRes.runId;

    // 1. 篩選級距 mismatch (tierMismatch=true)
    const mismatchRes = queryRunStudents(db, runId, { tierMismatch: true, limit: 100 });
    expect(mismatchRes.totalStudents).toBe(5);

    // 驗證這 5 筆學生的來源列座標恰為 30, 35, 43, 51, 52
    const sourceRows = mismatchRes.items.map((s) => s.sourceRow).sort((a, b) => a - b);
    expect(sourceRows).toEqual([30, 35, 43, 51, 52]);

    // 2. 驗證 13 名報名「國小數學-一」的學生（全部 tierComparison 為 match）
    // 依 I17 規範：以 tierMismatch=false 篩選時，這 13 人仍須全部出現在 hasIssues 清單中！
    //
    // #157 Ruling 1／3：這 13 人報的「國小數學-一」**不在課表設定內**（seed 只有 國小數學-一A／一B），
    // 因此該班沒有類別（unset）、不是數學候選班，診斷碼由舊制的「缺排課（SCHEDULE_NOT_FOUND）」
    // 改為更準確的「班名未對應課表（CLASS_NOT_MAPPED）」。兩者都讓這 13 人帶 hasIssues，
    // 驗收重點（仍在 hasIssues 清單中、級距為 match）不變。
    const noMismatchWithIssuesRes = queryRunStudents(db, runId, {
      tierMismatch: false,
      hasIssues: true,
      limit: 100,
    });

    // 找出這 13 名報名 國小數學-一[團] 的學生
    const math1Students = noMismatchWithIssuesRes.items.filter((s) =>
      s.enrollments.some((e) => e.rawToken.includes('國小數學-一[團]'))
    );
    expect(math1Students).toHaveLength(13);

    // 驗證這 13 名學生的所有安課 tierComparisons 皆為 match 且帶有 needsReview
    for (const s of math1Students) {
      const detail = getStudentCalculationDetail(db, runId, s.personCode);
      expect(detail).toBeDefined();
      const careComps = detail!.tierComparisons.filter(
        (c) => c.status === 'match' || c.status === 'mismatch'
      );
      expect(careComps.length).toBeGreaterThan(0);
      expect(careComps.every((c) => c.status === 'match')).toBe(true);
      expect(detail!.hasIssues).toBe(true);
    }

    // 3. 驗證問題清單統計
    expect(actRes.issueCounts['DUPLICATE_SUBJECT_ENROLLMENT']).toBe(2);
    expect(actRes.issueCounts['STAFF_FAMILY_NO_DISCOUNT']).toBe(5);
    expect(actRes.issueCounts['CONFLICTING_NOTE_SOURCE']).toBe(1);
    // #157：未對應的班不再被當成數學候選班，因此沒有「缺排課」的 SCHEDULE_NOT_FOUND；
    // 這些班一律以 CLASS_NOT_MAPPED 提示「班名未對應課表」。
    // 實測（同一份 477 人 fixture）：CLASS_NOT_MAPPED 292 筆／191 位學生，SCHEDULE_NOT_FOUND 0 筆。
    expect(actRes.issueCounts['SCHEDULE_NOT_FOUND']).toBeUndefined();
    expect(actRes.issueCounts['CLASS_NOT_MAPPED']).toBe(292);
  });

  // D1 契約改寫（F-1；specs/11 §3 D1、04 §8 UX35）：
  //   舊斷言：同 key 不同 ruleSetVersion（v2 → v1）不互相命中，拒絕「不同的請求內容」。
  //   新斷言：規則版本不再是 client 輸入，冪等雜湊只由 importId／expectedRevision／asOfDate 決定；
  //           同 key 同內容重送回原 run，同 key 不同內容（這裡用不同 asOfDate）拒絕「不同的請求內容」。
  //   原因：ruleSetVersion 已不在 activate 的請求裡，「版本隔離」改由「請求內容不同即拒絕」這條不變式承接。
  it('F2: 同 key 同內容重送回原 run；同 key 不同內容（不同 asOfDate）不得靜默回傳原 run', () => {
    const first = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 'key-f2-isolation',
    });

    // 同 key＋同 body → 回原結果（冪等命中）
    const replay = activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: 'key-f2-isolation',
    });
    expect(replay.runId).toBe(first.runId);

    // 同 key＋不同內容 → 不得靜默回錯的 run，必須拒絕
    expect(() =>
      activateImport(db, {
        importId: previewId,
        expectedRevision: 0,
        idempotencyKey: 'key-f2-isolation',
        asOfDate: '2026-01-01',
      })
    ).toThrowError(/不同的請求內容/);
  });

  it('application-level run executor rejects each historical calculator version without inserting a run', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get() as { n: number }).n;
    for (const version of ['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'excel-v260922-compat']) {
      expect(() => executeCalculationRun(db, previewId, `forbidden_${version}`, { ruleSetVersion: version }))
        .toThrow(/僅支援 erp-tag-v4/);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get() as { n: number }).n).toBe(before);
  });
});

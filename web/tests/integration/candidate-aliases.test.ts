import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import {
  SEED_CLASSES,
  SEED_BASE_NAMES,
  classifyErpBaseNames,
  buildDynamicCandidates,
  type CandidateCounts,
  classifyErpDualTrack,
} from '@/domain/schedules/seed-manifest';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';
import { POST as applyPOST } from '@/app/api/v1/settings/apply/route';

describe('D2 Task 3 → D32-C: 動態候選引擎與雙軌對照整合測試 (candidate-aliases)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let previewId: string;
  let erpBaseNames: string[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pr2-cand-'));
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
    activateImport(db, {
      importId: previewId,
      expectedRevision: 0,
      idempotencyKey: `pr2-setup-${Date.now()}-${Math.random()}`,
    });

    const rows = db
      .prepare('SELECT DISTINCT base_name FROM student_enrollments WHERE import_id = ?')
      .all(previewId) as Array<{ base_name: string }>;
    erpBaseNames = rows.map((r) => r.base_name);
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. [D32-C] 動態候選由當批差集組裝：12 待設定進候選，無寫死數字', () => {
    const dual = classifyErpDualTrack(erpBaseNames, SEED_BASE_NAMES, []);
    // fixture 全量：12 待設定全數進動態候選
    expect(dual.activeView.unmatchedCount).toBe(12);
    expect(dual.candidates.length).toBe(12);
    for (const b of dual.activeView.unmatched) {
      expect(dual.candidates.some((c) => c.rawBaseName === b)).toBe(true);
    }

    // D18 組 reason 不再寫死後果數字；影響由 preview 產生（見本檔測試 5）
    const d18 = dual.candidates.find((c) => c.rawBaseName === '國小數學-一');
    expect(d18).toBeDefined();
    expect(d18?.reason ?? '').not.toMatch(/\d+\s*人/);
    expect(d18?.reason ?? '').not.toMatch(/mismatch/i);

    // D22 三組同樣由差集動態產生（非 hardcode 常數）
    for (const raw of ['國小國語文-小三四', '小六國文加強班', '小六數學加強班']) {
      expect(dual.candidates.some((c) => c.rawBaseName === raw)).toBe(true);
    }
  });

  it('2. [D32-C] 動態候選建議目標凍結為空（人工填寫；不做模糊匹配）', () => {
    const dual = classifyErpDualTrack(erpBaseNames, SEED_BASE_NAMES, []);
    for (const c of dual.candidates) {
      expect(c.suggestedTarget).toBe('');
    }
  });

  it('3. I19 初始盤點錨點 54/42/12/7 維持不變', () => {
    const res = classifyErpBaseNames(erpBaseNames);
    expect(erpBaseNames.length).toBe(54);
    expect(res.matchedCount).toBe(42);
    expect(res.unmatchedCount).toBe(12);
    expect(res.seedNotAppearedCount).toBe(7);
    expect(res.ambiguousCount).toBe(0);

    // 驗證 12 個待設定班級包含 D18 與 D22 目標
    expect(res.unmatched).toContain('國小數學-一');
    expect(res.unmatched).toContain('國小國語文-小三四');
    expect(res.unmatched).toContain('小六國文加強班');
    expect(res.unmatched).toContain('小六數學加強班');
  });

  it('4. [RED F1] classifyErpDualTrack() 雙軌對照中，alias 覆蓋不掩蓋 ERP 實體未出現真相 (01 §4.3)，aliasCovered 另立欄位', () => {
    const dual = classifyErpDualTrack(erpBaseNames);
    expect(dual.seedInventory.matchedCount).toBe(42);
    expect(dual.seedInventory.unmatchedCount).toBe(12);
    expect(dual.seedInventory.seedNotAppearedCount).toBe(7);

    // 當核准 D18 alias 時，activeView 待設定自 12 減少為 11，已對應自 42 增為 43
    // 但 seedNotAppeared 依 01 §4.3 實體原則維持 7 班（一A 本批無 ERP 實體 token，不因 alias 覆蓋而謊報實體出現）
    // aliasCovered 另立欄位獨立展示（一A 恰 1 班）
    const aliases = [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }];
    const dualWithAlias = classifyErpDualTrack(erpBaseNames, SEED_BASE_NAMES, aliases);
    expect(dualWithAlias.activeView.unmatchedCount).toBe(11);
    expect(dualWithAlias.activeView.matchedCount).toBe(43);

    // F1: activeNotAppeared 不應把一A 從未出現清單移除（目前程式碼會移除變成 6）
    expect(dualWithAlias.activeView.seedNotAppearedCount).toBe(7);
    expect(dualWithAlias.activeView.seedNotAppeared).toContain('國小數學-一A');
    expect(dualWithAlias.activeView.aliasCoveredCount).toBe(1);
    expect(dualWithAlias.activeView.aliasCovered).toContain('國小數學-一A');
  });

  it('5. 逐 token 勾選後發起一次整表 dry-run preview 衝擊驗證（D18 13人/-0.5天/5→18，D22 不改天數）', async () => {
    const draft = buildSeedDraft();
    draft.aliases = [
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
      { rawBaseName: '小六國文加強班', targetBaseName: '小六加強班-國文' },
    ];

    const req = new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
      method: 'POST',
      body: JSON.stringify({ importId: previewId, draft, expectedRevision: 1 }),
    });
    const res = await previewPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    // D18 衝擊：13 人各 -0.5 天，mismatch 5 -> 18
    expect(body.affectedStudents).toBe(13);
    expect(body.mismatchBefore).toBe(5);
    expect(body.mismatchAfter).toBe(18);
  });
});

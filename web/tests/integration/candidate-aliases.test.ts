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
  NAMED_CANDIDATES,
  classifyErpDualTrack,
} from '@/domain/schedules/seed-manifest';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';
import { POST as applyPOST } from '@/app/api/v1/settings/apply/route';

describe('D2 Task 3: 具名候選擴充（D18 + D22）與雙軌對照整合測試 (candidate-aliases)', () => {
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

  it('1. [RED] NAMED_CANDIDATES 應包含 D18 與 D22 全部 4 組具名候選', () => {
    expect(NAMED_CANDIDATES).toBeDefined();
    expect(NAMED_CANDIDATES.length).toBe(4);

    // D18 數學一班
    const d18 = NAMED_CANDIDATES.find((c) => c.rawBaseName === '國小數學-一');
    expect(d18).toBeDefined();
    expect(d18?.targetBaseName).toBe('國小數學-一A');

    // D22 國語文小三四
    const d22Lang = NAMED_CANDIDATES.find((c) => c.rawBaseName === '國小國語文-小三四');
    expect(d22Lang).toBeDefined();
    expect(d22Lang?.targetBaseName).toBe('國小國語文-小三小四');

    // D22 小六國文加強班
    const d22Chi = NAMED_CANDIDATES.find((c) => c.rawBaseName === '小六國文加強班');
    expect(d22Chi).toBeDefined();
    expect(d22Chi?.targetBaseName).toBe('小六加強班-國文');

    // D22 小六數學加強班
    const d22Math = NAMED_CANDIDATES.find((c) => c.rawBaseName === '小六數學加強班');
    expect(d22Math).toBeDefined();
    expect(d22Math?.targetBaseName).toBe('小六加強班-數學');
  });

  it('2. 具名候選目標存在性驗證：4 組 targetBaseName 必須全數存在於 SEED 49 班中', () => {
    const seedSet = new Set(SEED_BASE_NAMES);
    for (const c of NAMED_CANDIDATES) {
      expect(seedSet.has(c.targetBaseName)).toBe(true);
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

  it('4. [RED] classifyErpDualTrack() 應能輸出雙軌對照（Seed 基準盤點 + Active 設定視圖）', () => {
    const dual = classifyErpDualTrack(erpBaseNames);
    expect(dual.seedInventory.matchedCount).toBe(42);
    expect(dual.seedInventory.unmatchedCount).toBe(12);
    expect(dual.seedInventory.seedNotAppearedCount).toBe(7);

    // 當有核准 aliases 時，activeView 待設定減少
    const aliases = [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }];
    const dualWithAlias = classifyErpDualTrack(erpBaseNames, SEED_BASE_NAMES, aliases);
    expect(dualWithAlias.activeView.unmatchedCount).toBe(11);
    expect(dualWithAlias.activeView.matchedCount).toBe(43);
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
    // D22 不參與衝堂抽取，不額外增加 affectedStudents
  });
});

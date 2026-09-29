import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { buildSeedDraft, hashSettingsDraft } from '@/adapters/sqlite/settings-repository';
import { SettingsDraft } from '@/contracts/settings';
import { CARE_WINDOWS } from '@/domain/schedules/overlap-calculator';
import { POST as calculatePOST } from '@/app/api/v1/settings/calculate/route';
import { GET as deductionsGET } from '@/app/api/v1/settings/deductions/route';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';

/**
 * 09 §8.1／04 §8 UX08、UX19、UX24（API 部分）：
 * POST /api/v1/settings/calculate（唯讀計算 read model）與 GET /api/v1/settings/deductions（快照讀取）。
 * 兩者都不寫 DB、不建 preview／run，回應不含學生個資；ruleSetVersion 由 server 決定且不得為診斷軌。
 */

const ORIGIN = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };

function calcReq(body: unknown, headers: Record<string, string> = ORIGIN, raw?: string) {
  return new NextRequest('http://127.0.0.1:3000/api/v1/settings/calculate', {
    method: 'POST',
    headers,
    body: raw ?? JSON.stringify(body),
  });
}
const dedReq = (query = '') =>
  new NextRequest(`http://127.0.0.1:3000/api/v1/settings/deductions${query}`, { method: 'GET', headers: ORIGIN });

const ALIAS = { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' };

let filePreview: Awaited<ReturnType<typeof generateImportPreview>>;

beforeAll(async () => {
  const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
  filePreview = await generateImportPreview(buf, 'fixture.xlsx');
});

/** 存一批 ready 名單並以 seed 設定 activate（revision 0→1），回傳 run／import id。 */
function saveReadyAndActivate(db: any): { runId: string; importId: string } {
  const importId = 'imp_rm_a';
  saveImportBatch(
    db,
    {
      id: importId,
      fileName: 'fixture.xlsx',
      fileHash: filePreview.fileHash,
      contentHash: filePreview.contentHash,
      sheetName: filePreview.sheetName,
      headerMap: filePreview.headerMapping,
      parserVersion: '1.0.0',
      scopeNote: filePreview.scopeNote,
      rowCount: filePreview.stats.totalStudents,
      status: 'ready',
      createdAt: new Date().toISOString(),
    },
    filePreview.students
  );
  const act = activateImport(db, { importId, expectedRevision: 0, idempotencyKey: `rm-act-${Math.random()}` });
  return { runId: act.runId, importId };
}

/** 一A 改成單一時段：週一 15:20–16:50（920–1010，安親重疊 40 分、課輔 20 分），並帶一→一A 別名。 */
function draftMathOneA(startMinutes: number, endMinutes: number, weekday = '一'): SettingsDraft {
  const seed = buildSeedDraft();
  return {
    ...seed,
    aliases: [ALIAS],
    classes: seed.classes.map((c) =>
      c.baseName === '國小數學-一A' ? { ...c, sessions: [{ weekday, startMinutes, endMinutes }] } : c
    ),
  };
}

describe('POST /api/v1/settings/calculate（唯讀計算 read model）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-calc-test-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    (global as any).__sqlite_db__ = undefined;
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function tableCounts(db: any): Record<string, number> {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
      (r) => r.name
    );
    return Object.fromEntries(names.map((n) => [n, (db.prepare(`SELECT COUNT(*) AS n FROM ${n}`).get() as { n: number }).n]));
  }

  it('200：回 requestKey／draftHash／ruleSetVersion／windows／rows／classes／issues；空 DB 無 active 時 ruleSetVersion＝erp-tag-v2', async () => {
    getDatabase();
    const draft = draftMathOneA(920, 1010);
    const res = await calculatePOST(calcReq({ draft, requestKey: 'req-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['classes', 'draftHash', 'issues', 'requestKey', 'rows', 'ruleSetVersion', 'windows']);
    expect(body.requestKey).toBe('req-1');
    expect(body.ruleSetVersion).toBe('erp-tag-v2');
    expect(body.windows.anqin).toEqual({ startMinutes: CARE_WINDOWS.anqin.start, endMinutes: CARE_WINDOWS.anqin.end, weekdays: ['一', '二', '三', '四', '五'] });

    const rows = body.rows.filter((r: any) => r.classKey === '國小數學-一A');
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMinutes).toBe(90);
    expect(rows[0].anqin.overlapMinutes).toBe(40);
    expect(rows[0].tutoring.overlapMinutes).toBe(20);
  });

  it('draftHash 與同一份 draft 送 settings/preview 得到的 inputHash 相同（預覽與提交同源）', async () => {
    const db = getDatabase() as any;
    saveReadyAndActivate(db);
    const draft = draftMathOneA(920, 1010);
    const calc = await (await calculatePOST(calcReq({ draft, requestKey: 'k' }))).json();
    const prev = await previewPOST(
      new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
        method: 'POST',
        headers: ORIGIN,
        body: JSON.stringify({ draft, expectedRevision: 1 }),
      })
    );
    expect((await prev.json()).inputHash).toBe(calc.draftHash);
    expect(calc.draftHash).toBe(hashSettingsDraft(draft));
  });

  it('UX08：requestKey 原樣回傳；班名／老師／星期／起／迄任一改動都使 draftHash 改變（client 可據以丟棄晚到的舊回應）', async () => {
    getDatabase();
    const base = draftMathOneA(920, 1010);
    const hashOf = async (d: SettingsDraft, key: string) => {
      const b = await (await calculatePOST(calcReq({ draft: d, requestKey: key }))).json();
      expect(b.requestKey).toBe(key);
      return b.draftHash as string;
    };
    const h0 = await hashOf(base, 'r0');
    expect(await hashOf(base, 'r0b')).toBe(h0); // 同 draft 同 hash

    const edit = (fn: (c: SettingsDraft['classes'][number]) => SettingsDraft['classes'][number]): SettingsDraft => ({
      ...base,
      classes: base.classes.map((c) => (c.baseName === '國小數學-一A' ? fn(c) : c)),
    });
    const variants: SettingsDraft[] = [
      edit((c) => ({ ...c, baseName: '國小數學-一A改' })),
      edit((c) => ({ ...c, teacher: '別的老師' })),
      edit((c) => ({ ...c, sessions: [{ ...c.sessions[0], weekday: '二' }] })),
      edit((c) => ({ ...c, sessions: [{ ...c.sessions[0], startMinutes: 930 }] })),
      edit((c) => ({ ...c, sessions: [{ ...c.sessions[0], endMinutes: 1020 }] })),
    ];
    const hashes = new Set([h0]);
    for (const [i, v] of variants.entries()) hashes.add(await hashOf(v, `v${i}`));
    expect(hashes.size).toBe(variants.length + 1);
  });

  it('UX24：draft.careWindows 與 ruleSet 窗口不同 → 400 INVALID_DRAFT（不靜默忽略）；settings/preview 同樣拒絕', async () => {
    const db = getDatabase() as any;
    saveReadyAndActivate(db);
    const bad: SettingsDraft = { ...buildSeedDraft(), careWindows: { anqin: { startMinutes: 790, endMinutes: 960 }, tutoring: { startMinutes: 990, endMinutes: 1170 } } };
    const res = await calculatePOST(calcReq({ draft: bad, requestKey: 'x' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_DRAFT');

    const prev = await previewPOST(
      new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
        method: 'POST',
        headers: ORIGIN,
        body: JSON.stringify({ draft: bad, expectedRevision: 1 }),
      })
    );
    expect(prev.status).toBe(400);
    expect((await prev.json()).code).toBe('INVALID_DRAFT');
  });

  it('client 不得指定 ruleSetVersion（含診斷軌）：帶了就 400，不採用', async () => {
    getDatabase();
    for (const v of ['excel-v260922-compat', 'erp-tag-v1', 'erp-tag-v2']) {
      const res = await calculatePOST(calcReq({ draft: buildSeedDraft(), requestKey: 'x', ruleSetVersion: v }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('INVALID_REQUEST');
    }
  });

  it('ruleSetVersion 由 server 決定：active run 為正式軌則採其值；active run 為診斷軌 compat 則改採現行正式軌 erp-tag-v2', async () => {
    const db = getDatabase() as any;
    const { runId } = saveReadyAndActivate(db);
    const draft = buildSeedDraft();

    db.prepare('UPDATE calculation_runs SET rule_set_version = ? WHERE id = ?').run('erp-tag-v1', runId);
    let body = await (await calculatePOST(calcReq({ draft, requestKey: 'a' }))).json();
    expect(body.ruleSetVersion).toBe('erp-tag-v1');

    db.prepare('UPDATE calculation_runs SET rule_set_version = ? WHERE id = ?').run('excel-v260922-compat', runId);
    body = await (await calculatePOST(calcReq({ draft, requestKey: 'b' }))).json();
    expect(body.ruleSetVersion).toBe('erp-tag-v2');
  });

  it('輸入驗證：缺 requestKey、非 JSON、班名重複 → 400；超過 payload 上限 → 413；跨來源 → 403', async () => {
    getDatabase();
    const draft = buildSeedDraft();
    expect((await calculatePOST(calcReq({ draft }))).status).toBe(400);
    expect((await calculatePOST(calcReq(null, ORIGIN, 'not json'))).status).toBe(400);

    const dup: SettingsDraft = { ...draft, classes: [...draft.classes, draft.classes[0]] };
    const dupRes = await calculatePOST(calcReq({ draft: dup, requestKey: 'd' }));
    expect(dupRes.status).toBe(400);
    expect((await dupRes.json()).code).toBe('INVALID_DRAFT');

    const huge = calcReq({ draft, requestKey: 'h', padding: 'x'.repeat(600 * 1024) });
    expect((await calculatePOST(huge)).status).toBe(413);

    const cross = await calculatePOST(calcReq({ draft, requestKey: 'c' }, { host: '127.0.0.1:3000', origin: 'http://evil.example' }));
    expect(cross.status).toBe(403);
  });

  it('UX19：連續多次 calculate POST 與 deductions GET，資料庫各表列數與內容、active_state 都不變，且回應不含學生個資', async () => {
    const db = getDatabase() as any;
    const { runId } = saveReadyAndActivate(db);
    const beforeCounts = tableCounts(db);
    const beforeActive = JSON.stringify(db.prepare('SELECT * FROM active_state').all());
    const beforeRuns = JSON.stringify(db.prepare('SELECT * FROM calculation_runs').all());
    const beforeVersions = JSON.stringify(db.prepare('SELECT * FROM settings_versions').all());
    const beforePreviews = JSON.stringify(db.prepare('SELECT * FROM settings_previews').all());

    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      bodies.push(JSON.stringify(await (await calculatePOST(calcReq({ draft: draftMathOneA(920, 1010), requestKey: `k${i}` }))).json()));
      bodies.push(JSON.stringify(await (await deductionsGET(dedReq())).json()));
      bodies.push(JSON.stringify(await (await deductionsGET(dedReq(`?runId=${runId}`))).json()));
    }

    expect(tableCounts(db)).toEqual(beforeCounts);
    expect(JSON.stringify(db.prepare('SELECT * FROM active_state').all())).toBe(beforeActive);
    expect(JSON.stringify(db.prepare('SELECT * FROM calculation_runs').all())).toBe(beforeRuns);
    expect(JSON.stringify(db.prepare('SELECT * FROM settings_versions').all())).toBe(beforeVersions);
    expect(JSON.stringify(db.prepare('SELECT * FROM settings_previews').all())).toBe(beforePreviews);

    // 回應不含任何學生個資：姓名／人員代碼／聯絡資訊皆不出現
    const students = db.prepare('SELECT person_code, name, contact FROM imported_students').all() as Array<{ person_code: string; name: string; contact: string | null }>;
    expect(students.length).toBeGreaterThan(0);
    const all = bodies.join('\n');
    for (const s of students) {
      expect(all).not.toContain(s.person_code);
      if (s.name && s.name.length >= 2) expect(all).not.toContain(s.name);
      if (s.contact) expect(all).not.toContain(s.contact);
    }
  });

});

describe('GET /api/v1/settings/deductions（指定 run 快照／active／已儲存設定）', () => {
  let tempDir: string;
  let db: any;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ded-test-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    (global as any).__sqlite_db__ = undefined;
    db = getDatabase();
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const classOf = (body: any, key: string) => body.classes.find((c: any) => c.classKey === key);

  it('無 active、無已儲存設定：讀 seed 課表（scope＝seed，scheduleVersionId＝seed-v250922），班級數＝seed 49 班', async () => {
    const res = await deductionsGET(dedReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('seed');
    expect(body.runId).toBeNull();
    expect(body.scheduleVersionId).toBe('seed-v250922');
    expect(body.ruleSetVersion).toBe('erp-tag-v2');
    expect(body.classes).toHaveLength(49);
  });

  it('無 active 但有已儲存設定（settings_only）：讀最新已儲存設定（scope＝saved_settings，帶版本 id 與 revision）', async () => {
    const draft = draftMathOneA(920, 1010);
    const prev = previewSettingsChange(db, undefined, { draft, expectedRevision: 0 });
    const applied = applySettingsPreview(db, { previewId: prev.previewId, expectedRevision: 0, idempotencyKey: 'ded-so-1' });
    expect(applied.runId).toBeNull();

    const body = await (await deductionsGET(dedReq())).json();
    expect(body.scope).toBe('saved_settings');
    expect(body.scheduleVersionId).toBe(applied.settingsVersionId);
    expect(body.settingsRevision).toBe(1);
    expect(body.runId).toBeNull();
    const c = classOf(body, '國小數學-一A');
    expect(c.anqin.totalOverlapMinutes).toBe(40);
    expect(c.tutoring.totalOverlapMinutes).toBe(20);
  });

  it('有 active run 且未指定 runId：讀 active run 的課表快照（scope＝active_run）', async () => {
    const { runId } = saveReadyAndActivate(db);
    const body = await (await deductionsGET(dedReq())).json();
    expect(body.scope).toBe('active_run');
    expect(body.runId).toBe(runId);
    expect(body.scheduleVersionId).toBe('seed-v250922');
  });

  it('指定 runId 讀該 run 的固定快照：之後儲存了新課表，舊 run 仍是舊課表結果（不可用最新課表補舊 run）', async () => {
    saveReadyAndActivate(db);
    // run1：課表 X＝週一 15:20–16:50（安親重疊 40）
    const prev1 = previewSettingsChange(db, undefined, { draft: draftMathOneA(920, 1010), expectedRevision: 1 });
    const applied1 = applySettingsPreview(db, { previewId: prev1.previewId, expectedRevision: 1, idempotencyKey: 'ded-r1' });
    // run2：課表 Y＝週一 13:00–16:00（安親重疊 180）
    const prev2 = previewSettingsChange(db, undefined, { draft: draftMathOneA(780, 960), expectedRevision: 2 });
    const applied2 = applySettingsPreview(db, { previewId: prev2.previewId, expectedRevision: 2, idempotencyKey: 'ded-r2' });

    const old = await (await deductionsGET(dedReq(`?runId=${applied1.runId}`))).json();
    expect(old.scope).toBe('run');
    expect(old.runId).toBe(applied1.runId);
    expect(old.scheduleVersionId).toBe(applied1.settingsVersionId);
    expect(classOf(old, '國小數學-一A').anqin.totalOverlapMinutes).toBe(40);

    const current = await (await deductionsGET(dedReq())).json();
    expect(current.scope).toBe('active_run');
    expect(current.runId).toBe(applied2.runId);
    expect(classOf(current, '國小數學-一A').anqin.totalOverlapMinutes).toBe(180);
  });

  it('不存在的 runId → 404；不合法 runId／未知查詢參數 → 400', async () => {
    expect((await deductionsGET(dedReq('?runId=run_does_not_exist'))).status).toBe(404);
    expect((await deductionsGET(dedReq('?runId=../etc/passwd'))).status).toBe(400);
    expect((await deductionsGET(dedReq('?foo=bar'))).status).toBe(400);
  });

  it('run 的課表快照已不存在（資料不足）：409 SNAPSHOT_UNAVAILABLE，不改用最新設定補算', async () => {
    const { runId } = saveReadyAndActivate(db);
    db.prepare('UPDATE calculation_runs SET schedule_version_id = ? WHERE id = ?').run('setv_missing_snapshot', runId);
    const res = await deductionsGET(dedReq(`?runId=${runId}`));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SNAPSHOT_UNAVAILABLE');
  });

  it('診斷軌（compat）run：422 UNSUPPORTED_RULESET，不以正式規則冒充其值', async () => {
    const { runId } = saveReadyAndActivate(db);
    db.prepare('UPDATE calculation_runs SET rule_set_version = ? WHERE id = ?').run('excel-v260922-compat', runId);
    const res = await deductionsGET(dedReq(`?runId=${runId}`));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('UNSUPPORTED_RULESET');
  });
});

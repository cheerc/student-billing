import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { SettingsDraftSchema, classesToGridRows, gridRowsToCalculateClasses, gridRowsToClasses } from '@/contracts/settings';
import { POST as calculatePOST } from '@/app/api/v1/settings/calculate/route';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';

/**
 * 04 §8 UX07（修訂）／09 §3.1「未知與空白星期」（11 §3 A；F01）——calculate 路徑（真實 route 入口）。
 *
 * 現況缺陷（RED 依據）：CalculateSessionSchema.weekday 為 z.string().min(1).max(8)，
 * 使用者把某列星期清空（或輸入超過 8 字）會讓**整個** calculate 回 400；
 * 非空的非法值（如「八」）雖有 row-level unknown_weekday，但畫面沒有呈現（由 UI 測試驗）。
 *
 * 選定 09 §3.1 的路徑 (a)：calculate 接受空白／過長星期，並回該列的問題（單一來源＝domain 的 isUnknownWeekday，
 * 列與班級層級的狀態、問題清單都由 server 一次算出）。提交（settings/preview、apply）維持只收完整合法時段的既有契約。
 *
 * 手算（v2 同星期規則，安親窗 13:00–16:00、課輔窗 16:30–19:30，週一至五；每日 180 分）：
 *   週一 15:20–16:50（920–1010）→ 安親重疊 40 分、課輔重疊 20 分。
 *   星期未知（空白／無法識別）→ v2 fail-closed：重疊 0，但狀態必為 unknown_weekday，不是「無衝堂」。
 *   合法週六 → 與週一至五窗口無交集，重疊 0、狀態 no_overlap。
 */

const ORIGIN = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };

function calcReq(body: unknown) {
  return new NextRequest('http://127.0.0.1:3000/api/v1/settings/calculate', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify(body),
  });
}

const TARGET_CLASS = '兒童美語-Gino';

/** 與 settings-editor 相同的路徑：seed → 平鋪列 → 改某列星期 → gridRowsToCalculateClasses（含 rowId）。 */
function calcDraftWithWeekdays(weekdays: Array<string | undefined>) {
  const seed = buildSeedDraft();
  const rows = classesToGridRows(seed.classes);
  const targetIdx = rows.map((r, i) => (r.className === TARGET_CLASS ? i : -1)).filter((i) => i >= 0);
  targetIdx.forEach((rowIndex, k) => {
    const w = weekdays[k];
    if (w !== undefined) rows[rowIndex] = { ...rows[rowIndex], weekday: w };
  });
  return {
    rows,
    draft: { ...seed, classes: gridRowsToCalculateClasses(rows, seed.classes) },
    targetRowIds: targetIdx.map((i) => rows[i].rowId),
  };
}

describe('UX07（修訂）：calculate 對未知／空白星期回該列問題，不讓整個請求失敗', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unk-wd-'));
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

  it('前置：seed 的 兒童美語-Gino 有 3 個時段（週一／三／五），首列為 15:20–16:50', async () => {
    getDatabase();
    const { rows, targetRowIds } = calcDraftWithWeekdays([]);
    expect(targetRowIds).toHaveLength(3);
    const first = rows.find((r) => r.rowId === targetRowIds[0])!;
    expect([first.weekday, first.startMinutes, first.endMinutes]).toEqual(['一', 920, 1010]);
  });

  it('空白星期（空字串）：200；該列 unknown_weekday（安親／課輔兩側）、重疊 0 不冒充無衝堂；班級狀態需確認；列出 UNKNOWN_WEEKDAY 問題並說明是「沒有填星期」', async () => {
    getDatabase();
    const { draft, targetRowIds } = calcDraftWithWeekdays(['']);
    const res = await calculatePOST(calcReq({ draft, requestKey: 'blank-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestKey).toBe('blank-1');

    const row = body.rows.find((r: any) => r.rowId === targetRowIds[0]);
    expect(row.weekday).toBe('');
    expect(row.anqin.status).toBe('unknown_weekday');
    expect(row.tutoring.status).toBe('unknown_weekday');
    expect(row.anqin.overlapMinutes).toBe(0);
    expect(row.tutoring.overlapMinutes).toBe(0);

    const cls = body.classes.find((c: any) => c.classKey === TARGET_CLASS);
    expect(cls.anqin.status).toBe('unknown_weekday');
    expect(cls.tutoring.status).toBe('unknown_weekday');

    const issue = body.issues.find((i: any) => i.code === 'UNKNOWN_WEEKDAY' && i.rowId === targetRowIds[0]);
    expect(issue).toBeDefined();
    expect(issue.message).toContain('沒有填星期');
    expect(issue.message).not.toMatch(/v2|UNKNOWN_WEEKDAY|unknown_weekday/); // 使用者可見的原因不外露工程字
    expect(typeof body.draftHash).toBe('string');
    expect(body.draftHash.length).toBeGreaterThan(0);
  });

  it('非空非法值「八」：200；該列 unknown_weekday，原因寫出輸入的值；同班其他合法時段不受影響（仍 calculated）', async () => {
    getDatabase();
    const { draft, targetRowIds } = calcDraftWithWeekdays(['八']);
    const res = await calculatePOST(calcReq({ draft, requestKey: 'bad-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();

    const bad = body.rows.find((r: any) => r.rowId === targetRowIds[0]);
    expect(bad.anqin.status).toBe('unknown_weekday');
    expect(bad.tutoring.status).toBe('unknown_weekday');
    expect(bad.anqin.overlapMinutes).toBe(0);

    const ok = body.rows.find((r: any) => r.rowId === targetRowIds[1]);
    expect(ok.anqin.status).not.toBe('unknown_weekday');

    const issue = body.issues.find((i: any) => i.code === 'UNKNOWN_WEEKDAY' && i.rowId === targetRowIds[0]);
    expect(issue.message).toContain('「八」');
    // 班級層級：任一列星期未知即需確認，不被其他合法列掩蓋
    const cls = body.classes.find((c: any) => c.classKey === TARGET_CLASS);
    expect(cls.anqin.status).toBe('unknown_weekday');
    expect(cls.tutoring.status).toBe('unknown_weekday');
  });

  it('超過 8 個字元的非法星期：同樣是該列問題（200），不是整個 calculate 400', async () => {
    getDatabase();
    const { draft, targetRowIds } = calcDraftWithWeekdays(['一二三四五六日一二']);
    const res = await calculatePOST(calcReq({ draft, requestKey: 'long-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.rows.find((r: any) => r.rowId === targetRowIds[0]);
    expect(row.anqin.status).toBe('unknown_weekday');
    expect(body.issues.some((i: any) => i.code === 'UNKNOWN_WEEKDAY' && i.rowId === targetRowIds[0])).toBe(true);
  });

  it('只有空白星期列的班級：班級狀態 unknown_weekday，扣天以 0 計（fail-closed）但不是 no_overlap', async () => {
    getDatabase();
    const seed = buildSeedDraft();
    const rows = classesToGridRows(seed.classes).map((r) =>
      r.className === '國小數學-一A' ? { ...r, weekday: '' } : r
    );
    const draft = { ...seed, classes: gridRowsToCalculateClasses(rows, seed.classes) };
    const res = await calculatePOST(calcReq({ draft, requestKey: 'blank-cls' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const cls = body.classes.find((c: any) => c.classKey === '國小數學-一A');
    expect(cls.anqin.status).toBe('unknown_weekday');
    expect(cls.anqin.rounded).toBe(0);
    expect(cls.tutoring.status).toBe('unknown_weekday');
  });

  it('回歸：合法週六仍為 0 且是 no_overlap（已驗證無衝堂），不出現 UNKNOWN_WEEKDAY', async () => {
    getDatabase();
    const { draft, targetRowIds } = calcDraftWithWeekdays(['六']);
    const res = await calculatePOST(calcReq({ draft, requestKey: 'sat-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.rows.find((r: any) => r.rowId === targetRowIds[0]);
    expect(row.anqin.overlapMinutes).toBe(0);
    expect(row.anqin.status).toBe('no_overlap');
    expect(row.tutoring.status).toBe('no_overlap');
    expect(body.issues.some((i: any) => i.code === 'UNKNOWN_WEEKDAY' && i.rowId === targetRowIds[0])).toBe(false);
  });

  it('回歸：純唯讀——calculate 不寫任何表（含空白星期案例）', async () => {
    const db = getDatabase() as any;
    const count = () =>
      Object.fromEntries(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(
          (t) => [t.name, (db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number }).n]
        )
      );
    const before = count();
    const { draft } = calcDraftWithWeekdays(['']);
    expect((await calculatePOST(calcReq({ draft, requestKey: 'ro-1' }))).status).toBe(200);
    expect(count()).toEqual(before);
  });
});

describe('UX07（修訂）：提交端契約不放寬——空白星期仍被 settings/preview 拒絕', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unk-wd-sub-'));
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

  it('SettingsDraftSchema 拒絕空白星期與超過 8 字元的星期（存檔契約不變）', () => {
    const seed = buildSeedDraft();
    const withWeekday = (weekday: string) => ({
      ...seed,
      classes: seed.classes.map((c, i) =>
        i === 0 ? { ...c, sessions: [{ weekday, startMinutes: 900, endMinutes: 960 }] } : c
      ),
    });
    expect(SettingsDraftSchema.safeParse(withWeekday('')).success).toBe(false);
    expect(SettingsDraftSchema.safeParse(withWeekday('一二三四五六日一二')).success).toBe(false);
    expect(SettingsDraftSchema.safeParse(withWeekday('八')).success).toBe(true); // 非空非法值維持可存（run 端 fail-closed＋UNKNOWN_WEEKDAY 問題）
  });

  it('POST /settings/preview：帶空白星期的完整時段列 → 400，不建立 preview', async () => {
    const db = getDatabase() as any;
    const seed = buildSeedDraft();
    const rows = classesToGridRows(seed.classes).map((r, i) => (i === 0 ? { ...r, weekday: '' } : r));
    // 存檔路徑（gridRowsToClasses）只丟起迄不完整的列；空白星期的完整列會原樣帶進 draft
    const saveDraft = { ...seed, classes: gridRowsToClasses(rows, seed.classes) };
    const res = await previewPOST(
      new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
        method: 'POST',
        headers: ORIGIN,
        body: JSON.stringify({ draft: saveDraft, expectedRevision: 0 }),
      })
    );
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM settings_previews').get() as { n: number }).n).toBe(0);
  });
});

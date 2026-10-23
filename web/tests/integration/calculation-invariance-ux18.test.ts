import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { buildSchedulePreview } from '@/application/schedule-preview';
import { buildSeedDraft, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { StudentSnapshot } from '@/domain/students';
import { POST as calculatePOST } from '@/app/api/v1/settings/calculate/route';
import { GET as deductionsGET } from '@/app/api/v1/settings/deductions/route';
import golden from '../fixtures/ux18-seed-deductions-golden.json';

/**
 * 04 §8 UX18（regression）：v4 的同一 input 在 seed 與等價 full-seed override 路徑輸出相同。
 *
 * golden（tests/fixtures/ux18-seed-deductions-golden.json）由 dd9f08d 版 overlap-calculator（其後至本 PR 未改）
 * ＋ schedule-seed.json 直接算出，未經 R1b 的 read model、draft 轉換與 billing-calculator，是「改動前」的獨立基準。
 * 以「全量 seed 預設草稿」（40 個有完整時段的班）為 input，逐班對照：
 *   ① 固定 historical D24/D30 characterization ② calculate API ③ deductions API（seed scope）④ 學生 run：無 override
 *   與新路徑（override＝全量 seed 草稿）天數逐班相同（classMapFor／override 調整不得造成靜默漂移）。
 * 這是特徵化測試（characterization）：在 R1b 之前就成立，目的是釘住不變量，故不是 RED 測試。
 */

type Version = 'v1' | 'v2';
type Golden = Record<
  string,
  Record<string, { anqin: { totalOverlapMinutes: number; raw: number; rounded: number }; tutoring: { totalOverlapMinutes: number; raw: number; rounded: number } }>
>;
const G = golden as unknown as Golden;
const ruleSetOf = (v: Version) => (v === 'v1' ? 'erp-tag-v1' : 'erp-tag-v2');
const ORIGIN = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };

const near = (actual: number | null | undefined, expected: number, label: string) => {
  expect(actual, label).not.toBeNull();
  expect(Math.abs((actual as number) - expected), label).toBeLessThan(1e-12);
};

describe('UX18：全量 seed 預設草稿的計算值與改動前 golden 逐班相同', () => {
  it('前提：golden 涵蓋 40 個有完整時段的 seed 班（v1／v2 各一份）', () => {
    expect(Object.keys(G.v2)).toHaveLength(40);
    expect(Object.keys(G.v1)).toHaveLength(40);
  });

  it('獨立手算 pin（不取自 golden 產生流程）：國小數學-一A＝週四 15:00–16:30（安親 60 分）＋週六 10:30–12:00', () => {
    // 60÷180＝0.333… → D24 落在 [0.3,0.8) → 實扣 0.5；週六在 v2 不與週一至五窗口比對，v1 純時刻亦不與 13:00–16:00 相交
    for (const v of ['v1', 'v2'] as const) {
      expect(G[v]['國小數學-一A'].anqin.totalOverlapMinutes, v).toBe(60);
      expect(G[v]['國小數學-一A'].anqin.rounded, v).toBe(-0.5);
      expect(G[v]['國小數學-一A'].tutoring.totalOverlapMinutes, v).toBe(0);
    }
    // 國小數學-三A＝週一 16:30–18:00＋週三 18:00–19:30：課輔 90+90＝180 分＝正好 1 天 → 實扣 1
    for (const v of ['v1', 'v2'] as const) {
      expect(G[v]['國小數學-三A'].tutoring.totalOverlapMinutes, v).toBe(180);
      expect(G[v]['國小數學-三A'].tutoring.rounded, v).toBe(-1);
      expect(G[v]['國小數學-三A'].anqin.totalOverlapMinutes, v).toBe(0);
    }
  });

  it('D30 v1／v2 差異被釘住：小六加強班-自然（週六 15:00–17:00）v2 為 0，v1 純時刻比對為安親 60／課輔 30 分', () => {
    expect(G.v2['小六加強班-自然'].anqin.totalOverlapMinutes).toBe(0);
    expect(G.v2['小六加強班-自然'].tutoring.totalOverlapMinutes).toBe(0);
    expect(G.v1['小六加強班-自然'].anqin.totalOverlapMinutes).toBe(60);
    expect(G.v1['小六加強班-自然'].tutoring.totalOverlapMinutes).toBe(30);
  });

  for (const v of ['v2', 'v1'] as const) {
    it(`① 讀模型核心（${ruleSetOf(v)}）：每個 golden 班的重疊分鐘、未取整 raw、D24 實扣皆相同`, () => {
      const preview = buildSchedulePreview(buildSeedDraft(), ruleSetOf(v));
      const byKey = new Map(preview.classes.map((c) => [c.classKey, c]));
      for (const [name, exp] of Object.entries(G[v])) {
        const c = byKey.get(name);
        expect(c, `${name} 存在於讀模型`).toBeDefined();
        for (const t of ['anqin', 'tutoring'] as const) {
          expect(c![t].totalOverlapMinutes, `${v} ${name} ${t} 分鐘`).toBe(exp[t].totalOverlapMinutes);
          near(c![t].raw, exp[t].raw, `${v} ${name} ${t} raw`);
          expect(c![t].rounded, `${v} ${name} ${t} 實扣`).toBe(exp[t].rounded);
        }
      }
      // golden 以外的 seed 班（共用窗口班等）沒有計算值
      const extra = preview.classes.filter((c) => !(c.classKey in G[v]));
      expect(extra.length).toBe(49 - 40);
      for (const c of extra) {
        expect(c.anqin.totalOverlapMinutes, c.classKey).toBe(0);
        expect(c.anqin.rounded, c.classKey).toBe(0);
        expect(c.tutoring.rounded, c.classKey).toBe(0);
      }
    });
  }

  it('④ v4 學生計算：無 override（seed）與等價全量 seed override 天數逐班相同', () => {
    const mk = (baseName: string, grade: number): StudentSnapshot => ({
      personCode: `T-${baseName}-${grade}`,
      name: '合成',
      branch: '本校',
      gradeRaw: `小${grade}`,
      grade,
      gradeStatus: 'valid',
      contact: null,
      schoolInfo: null,
      tagsRaw: '',
      tags: [],
      notesRaw: '',
      enrollments: [
        {
          rawToken: `${baseName}[團]`,
          yearPrefix: null,
          baseName,
          groupFlag: '團',
          modifiers: [],
          withdrawalDate: null,
          erpBillingTierRaw: null,
          erpBillingTier: null,
          tierParseStatus: 'not_applicable',
          parseStatus: 'ok',
        },
      ],
      sourceRow: 1,
    });
    const override = draftToScheduleOverride(buildSeedDraft());
    let compared = 0;
    for (const name of Object.keys(G.v2).filter((n) => /國小數學|兒童美語/.test(n))) {
      for (const grade of [1, 3]) {
        const student = mk(name, grade);
        const seedPath = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' });
        const overridePath = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4', scheduleOverride: override });
        expect(overridePath.careDays, `${name} 小${grade}`).toEqual(seedPath.careDays);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(60);
  });
});

describe('UX18：API 路徑（calculate／deductions）對全量 seed 草稿的值與 golden 相同', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ux18-test-'));
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

  function expectMatchesGolden(classes: any[], label: string) {
    const byKey = new Map(classes.map((c) => [c.classKey, c]));
    for (const [name, exp] of Object.entries(G.v2)) {
      const c = byKey.get(name);
      expect(c, `${label} ${name}`).toBeDefined();
      for (const t of ['anqin', 'tutoring'] as const) {
        expect(c[t].totalOverlapMinutes, `${label} ${name} ${t} 分鐘`).toBe(exp[t].totalOverlapMinutes);
        near(c[t].raw, exp[t].raw, `${label} ${name} ${t} raw`);
        expect(c[t].rounded, `${label} ${name} ${t} 實扣`).toBe(exp[t].rounded);
      }
    }
  }

  it('POST /settings/calculate（全量 seed 草稿；D2b Q11 起空 DB 為 v3，逐堂值仍等 v2 golden）', async () => {
    const res = await calculatePOST(
      new NextRequest('http://127.0.0.1:3000/api/v1/settings/calculate', {
        method: 'POST',
        headers: ORIGIN,
        body: JSON.stringify({ requestKey: 'ux18', draft: buildSeedDraft() }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // 規則版本改為目標正式軌 v4（Q11 空 DB 預設；#112 起目標版本），但逐堂計算值是 D24／D30 層，v4 未改動 → golden 仍成立
    expect(body.ruleSetVersion).toBe('erp-tag-v4');
    expectMatchesGolden(body.classes, 'calculate');
  });

  it('GET /settings/deductions（無 active、無已儲存設定＝seed scope，v2）＝ golden', async () => {
    const res = await deductionsGET(
      new NextRequest('http://127.0.0.1:3000/api/v1/settings/deductions', { method: 'GET', headers: ORIGIN })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('seed');
    expectMatchesGolden(body.classes, 'deductions');
  });
});

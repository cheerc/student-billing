import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import type { StudentSnapshot } from '@/domain/students/types';
import type { CalculationRunRecord, StudentCalculationRecord } from '@/adapters/sqlite/runs-repository';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';

/**
 * D2d B（RED）：八項總表的 englishDays／mathDays 在重複同類時必須取**選中班**。
 *
 * D40 Q10-A：「維持現狀（名稱判斷與 seed 場次數），只在重複同類時改取選中班。」
 * 現行 calculate-run.ts:218-231 用 `enrollments.find(...)`（**首班**）的 seed 場次數。
 *
 * ── 鑑別案例（純 seed 路徑，不傳 scheduleOverride）─────────────────
 * 學生年級 4（課輔側），依報名順序報兩班兒童美語。seed 實測（以產品
 * `calculateClassDeductionD24` 計算，D24：先加總再取整；課輔特例重疊≥120
 * 且 1110<end<1170 → 每堂 −1）：
 *   ① 兒童美語-Gino（首班）：3 堂，課輔窗口（990–1170）重疊 20/30/20 分
 *        → raw −0.389 → |frac| 0.389 ∈[0.3,0.8) → rounded −0.5，sessions 3
 *   ② 兒童美語-Chevady：2 堂各 120 分重疊、end 1130∈(1110,1170) → 課輔特例
 *        → raw −2 → rounded −2，sessions 2
 *
 * v2 首班語意 → 選 Gino（扣 0.5）→ 天數 max(3, 5−0.5) = 4.5；englishDays = 3
 * v3 取正量最多 → 選 Chevady（扣 2.0）→ 天數 max(3, 5−2) = 3.0；englishDays 應 = 2
 *
 * 現行實作 v3 的 englishDays 仍取首班 → 3，與應有值 2 不同。
 * 本檔以 production 呼叫鏈（executeCalculationRun + saveCalculationRun）觀察。
 */

function makeStudent(personCode: string, baseNames: string[], grade: number): StudentSnapshot {
  return {
    personCode,
    name: '合成學生',
    branch: null,
    grade,
    gradeRaw: String(grade),
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: baseNames.map((b) => ({
      baseName: b,
      rawToken: b,
      yearPrefix: null,
      groupFlag: null,
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable' as const,
      parseStatus: 'ok' as const,
    })),
  };
}

describe('D2d B: 八項總表重複同類取選中班（Q10-A）', () => {
  // 注意：不得傳空 scheduleOverride。`classMapFor`（billing-calculator.ts:48-50）
  // 只要 scheduleOverride 存在就改用 NO_SEED_CLASSES、完全棄用 seed，
  // 空 Map 會讓所有班變 schedule_not_found（已實測：v2/v3 都得 5 天）。
  // 本案例要用**純 seed 路徑**（不傳 override），englishDays 才讀得到 seed 場次數。
  const SEED_PATH = { aliasMap: new Map(), classSettings: new Map() } as const;

  it('calculator 的 v3 結果必須輸出選中班（selection）供下游共用', () => {
    const student = makeStudent('S-EN-DUP', ['兒童美語-Gino', '兒童美語-Chevady'], 4);
    const v3 = calculateStudentBilling(student, {
      ...SEED_PATH,
      ruleSetVersion: 'erp-tag-v3',
    });

    // 前置手算（以產品 overlap-calculator 實算確認）：
    //   兒童美語-Gino（首班）：3 堂，課輔窗口（990–1170）重疊 20/30/20 分 → raw −0.389 → D24 rounded −0.5
    //   兒童美語-Chevady：2 堂各 120 分重疊且 end 1130∈(1110,1170) → 課輔特例 −1 兩次 → rounded −2
    // v2 首班語意 → Gino 扣 0.5 → max(3, 5−0.5) = 4.5；v3 取正量最多 → Chevady 扣 2 → max(3, 5−2) = 3
    expect(v3.careDays.tutoring.days).toBe(3);

    // 預期契約（S §7.5 第 6 點）：calculator 輸出 selection
    const selection = (v3 as unknown as { selection?: Record<string, unknown> }).selection;
    expect(selection).toBeDefined();
    expect(selection!.english).toMatchObject({ selectedBaseName: '兒童美語-Chevady' });
  });

  it('production 呼叫鏈：v3 run 的 englishDays 應為選中班場次數 2（現行為首班 3）', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      saveImportBatch(
        db,
        {
          id: 'imp_en',
          fileName: 'f.xlsx',
          fileHash: 'h',
          contentHash: 'c',
          sheetName: 'Sheet1',
          headerMap: {},
          parserVersion: '1.0.0',
          scopeNote: '',
          rowCount: 1,
          status: 'ready',
          createdAt: new Date().toISOString(),
        },
        [
          {
            personCode: 'S-EN-DUP',
            name: '合成學生',
            grade: 4,
            gradeRaw: '4',
            gradeStatus: 'valid',
            branch: '本部',
            contact: null,
            schoolInfo: null,
            tagsRaw: '',
            tags: [],
            notesRaw: '',
            sourceRow: 1,
            enrollments: ['兒童美語-Gino', '兒童美語-Chevady'].map((b) => ({
              rawToken: b,
              yearPrefix: null,
              baseName: b,
              groupFlag: null,
              modifiers: [],
              withdrawalDate: null,
              erpBillingTierRaw: null,
              erpBillingTier: null,
              tierParseStatus: 'not_applicable',
              parseStatus: 'ok',
            })),
          },
        ] as never
      );

      const res: { run: CalculationRunRecord; results: StudentCalculationRecord[] } = executeCalculationRun(
        db,
        'imp_en',
        'run_d2d_b',
        { ruleSetVersion: 'erp-tag-v3' }
      );
      saveCalculationRun(db, res.run, res.results, res.classCategories);

      const rec = res.results.find((r) => r.personCode === 'S-EN-DUP')!;
      // 預期：englishDays = Chevady 的 2（選中班）；現行實作為首班 Gino 的 3
      expect(rec.englishDays).toBe(2);
    } finally {
      db.close();
    }
  });
});

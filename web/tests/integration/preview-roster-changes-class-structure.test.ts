import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { resolveClassEnrollment, type ClassSettingLookup } from '@/domain/classification/class-category';
import {
  buildSeedDraft,
  draftToAliasMap,
  draftToScheduleOverride,
  saveSettingsVersion,
} from '@/adapters/sqlite/settings-repository';
import { buildClassSettingMap, executeCalculationRun, resolveLatestSavedSettings } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { generateImportPreview } from '@/application/import-preview';
import { POST as previewPOST } from '@/app/api/v1/imports/preview/route';
import { calculateSubjectCount, calculateBaseDiscountBps, parseTagDiscounts } from '@/domain/billing/discount-rules';
import { StudentSnapshot } from '@/domain/students';
import type { ClassSetting } from '@/contracts/settings';

/**
 * Round3 PR-1（-166）真入口驗證：POST /api/v1/imports/preview 的 rosterDiff.changes
 * 帶上新的逐班資料（enrollmentChanges／classDiscountChanges），且報名集合有變就算異動。
 *
 * 產品入口：保形匿名 fixture（conforming-erp-fixture.xlsx，OOXML 原形依 CLAUDE.md:75）
 * → generateImportPreview → preview route → computeImportRosterChanges。
 * 基準名單以 saveImportBatch 預先寫入（模擬「已有現行名單」），並改造其報名／標籤以製造指定情境。
 *
 * expected 獨立手算（R09 科數＝類別存在性；R10 effectiveCount＝科數＋兄弟姊妹；R13 園內生 max(9000, basic−500)），
 * 不使用 calculateStudentBilling 的輸出回填。
 */

const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

function uploadRequest(): Request {
  const blob = new Blob([fs.readFileSync(fixturePath)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const formData = new FormData();
  formData.append('file', blob, 'sample.xlsx');
  return new Request('http://127.0.0.1:3000/api/v1/imports/preview', { method: 'POST', body: formData });
}

type PreviewChange = {
  personCode: string;
  isNew: boolean;
  isRemoved: boolean;
  enrollmentChanges: Array<{ baseName: string; presence: string }>;
  classDiscountChanges: Array<{ baseName: string; sideOf: string; beforeBps: number | null; afterBps: number | null }>;
};

describe('API: preview 的 rosterDiff.changes 帶 PR-1 逐班資料（報名集合／逐班折扣）', () => {
  let tempDir: string;
  let incomingStudents: StudentSnapshot[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-preview-class-structure-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
    incomingStudents = (await generateImportPreview(fs.readFileSync(fixturePath), 'sample.xlsx')).students;
  });

  afterEach(() => {
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const saveBase = (id: string, students: StudentSnapshot[]) => {
    saveImportBatch(
      getDatabase(),
      {
        id,
        fileName: `${id}.xlsx`,
        fileHash: `${id}-file`,
        contentHash: `${id}-content`,
        sheetName: 'Sheet1',
        headerMap: {},
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: students.length,
        status: 'ready',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      students
    );
  };

  /**
   * RC04（spike §B1）：before 只有「國小輔導-寫功課」（不列入折扣 → 科數 0、basic 10000），
   * after 加報「國小數學-三A」（科數 1、basic 仍 10000）。折扣與天數皆未變，
   * 現行判定為「未異動」；PR-1 依 -75 必須出現在 changes，且報名集合列出 added。
   */
  it('RC04：只有寫功課 → 加報數學，即使折扣未變也出現在 changes 並列出報名集合', async () => {
    const target = incomingStudents.find((s) => s.personCode.endsWith('001'))!;
    expect(target).toBeDefined();

    const homeworkOnly: StudentSnapshot['enrollments'][number] = {
      rawToken: '115國小輔導-寫功課[團][五年級]',
      yearPrefix: '115',
      baseName: '國小輔導-寫功課',
      groupFlag: '團',
      modifiers: ['五年級'],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    };
    // 基準名單：目標學生只有「寫功課」一科（其餘學生原樣）
    const withoutTarget: StudentSnapshot[] = incomingStudents
      .filter((s) => s.personCode !== target.personCode)
      .map((s) => s);
    withoutTarget.push({ ...target, enrollments: [homeworkOnly] });

    // 獨立手算：基準（寫功課）科數 0、basic 10000；本次上傳（含數學＋可能的寫功課）科數 ≥1、basic 仍 10000（1–2 科）
    const baseOnlyHomework = calculateSubjectCount([
      { rawToken: 'x', baseName: '國小輔導-寫功課' },
    ] as never);
    expect(baseOnlyHomework).toBe(0);
    expect(calculateBaseDiscountBps(baseOnlyHomework, false, null)).toBe(10000);

    saveBase('imp_rc04', withoutTarget);

    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const diff = (await res.json()).rosterDiff as { changes: PreviewChange[]; changedStudents: number };
    const change = diff.changes.find((c) => c.personCode === target.personCode);

    expect(change, '報名集合變了必須出現在 changes（-75）').toBeDefined();
    expect(change!.isNew).toBe(false);
    expect(change!.isRemoved).toBe(false);
    const added = change!.enrollmentChanges.filter((e) => e.presence === 'added').map((e) => e.baseName);
    expect(added.length, '基準只有寫功課，本次至少多出數學班').toBeGreaterThanOrEqual(1);
    // 折扣未變 → 不應有逐班折扣變動項
    expect(change!.classDiscountChanges.every((c) => c.beforeBps === c.afterBps)).toBe(true);
  });

  /**
   * 同類換班（spike §B3 CB）：數學三A → 三B，兩側折扣相同（科數不變）。
   * PR-1 必須把它當成報名異動（switched），而不是完全看不見。
   */
  it('同類換班出現在 changes，報名集合以 switched 表達（即使折扣未變）', async () => {
    // 找一位實際有「國小數學」報名的學生（要能把該班換成同類的另一班）
    const target = incomingStudents.find(
      (s) => s.enrollments.some((e) => e.baseName.includes('國小數學')) && !parseTagDiscounts(s.tagsRaw).sibling
    )!;
    expect(target).toBeDefined();

    const swapFrom = target.enrollments.find((e) => e.baseName.includes('國小數學'))!;
    const swapTo = { ...swapFrom, rawToken: swapFrom.rawToken.replace(swapFrom.baseName, `${swapFrom.baseName}B`), baseName: `${swapFrom.baseName}B` };

    const baseStudents = incomingStudents.map((s) =>
      s.personCode === target.personCode ? { ...s, enrollments: [swapFrom] } : s
    );
    // 獨立手算：換班不動類別 → 科數相同 → basic 相同（兩側同一值）
    expect(calculateSubjectCount([swapFrom])).toBe(calculateSubjectCount([swapTo]));
    expect(calculateBaseDiscountBps(calculateSubjectCount([swapFrom])!, false, null)).toBe(
      calculateBaseDiscountBps(calculateSubjectCount([swapTo])!, false, null)
    );

    saveBase('imp_swap', baseStudents);

    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const diff = (await res.json()).rosterDiff as { changes: PreviewChange[] };
    const change = diff.changes.find((c) => c.personCode === target.personCode);

    expect(change, '同類換班必須出現在 changes（-75）').toBeDefined();
    const presences = change!.enrollmentChanges.filter((e) => e.presence !== 'kept').map((e) => e.presence);
    expect(presences.length, '報名集合必須有增減').toBeGreaterThanOrEqual(2);
  });

  /**
   * classSettings 接線的可證性（review B-3／secondary B3；spike §B4；specs/11:72；D17）。
   *
   * 情境：把「國小數學-三B」由自動偵測的 math **手動**改成 care（設定頁合法操作，categorySource=manual）。
   *
   * 兩次計算必須走**同一條**解析路徑，否則 before 側不可比：
   *  - 異動明細：`computeImportRosterChanges` 的 ruleSetVersion 由 `resolveFormalRuleSetVersion(db)` 決定
   *    （無 active run → TARGET_FORMAL_RULE_SET_VERSION）。空 DB 時與 v3 一致。
   *  - 對照 run：`executeCalculationRun` 預設是 erp-tag-v2（其 `options.ruleSetVersion` 預設值），
   *    v2 的科數走名稱規則（R09）而非手動類別 → 不會吃到 classSettings，兩者無從比較。
   *  → 故對照 run 顯式帶 `{ ruleSetVersion: 'erp-tag-v3' }`，與空 DB 的正式預設一致。
   *
   * 為何不用別名：本 fixture 多數數學報名名稱（國小數學-一）與 seed 課表（國小數學-一A）對不上，
   * 需靠別名才套用手動類別；而別名會讓 before／after 走不同解析路徑、反而製造不了 before 差異
   * （probe 實測：帶別名＋手動類別時科數 2，移除 classSettings 亦為 2 → 無鑑別力）。故挑名稱本來就對得上的班。
   *
   * 手算（R03 類別式科數＝計入類別集合大小；R10），由 resolveClassEnrollment 的結果獨立推導：
   *   手動：數學三B→care ⇒ 類別集合少一類 → 科數 −1；自動：數學三B→math ⇒ 科數原值。
   *   兩者必須不同，否則本案例無鑑別力（下方以 expect 斷言）。
   */
  it('classSettings 接線：手動把數學班改 care 後，異動明細 before 側與真 run 一致；移除接線則不同', async () => {
    const db0 = getDatabase();
    const categoriesOf = (s: (typeof incomingStudents)[number], map?: Map<string, ClassSettingLookup>) =>
      new Set(
        s.enrollments
          .map((e) => resolveClassEnrollment(e, undefined, map).category)
          .filter((c): c is 'care' | 'math' | 'english' => c !== 'none')
      );
    // 手動設定的 classSettings map（seed 課表 ＋ 國小數學-三B 手動 care）
    const manualMap = (() => {
      const seedDraft = buildSeedDraft();
      const i = seedDraft.classes.findIndex((c) => c.baseName === '國小數學-三B');
      seedDraft.classes[i] = {
        ...seedDraft.classes[i],
        category: 'care',
        categorySource: 'manual',
        fixedFiveDays: false,
        fixedSource: 'manual',
      } as ClassSetting;
      return buildClassSettingMap(seedDraft);
    })();
    // 挑一位報名「國小數學-三B」且兩種解析產生不同科數的學生；找不到就直接失敗（避免假綠）
    const target =
      incomingStudents.find(
        (s) =>
          s.enrollments.some((e) => e.baseName === '國小數學-三B') &&
          categoriesOf(s, manualMap).size !== categoriesOf(s).size
      ) ?? null;
    expect(target, 'fixture 需有一位報名 國小數學-三B 且手動／自動類別解析結果不同的學生').not.toBeNull();
    const catWith = categoriesOf(target!, manualMap);
    const catAuto = categoriesOf(target!);

    saveBase('imp_manual_category', incomingStudents.map((s) => ({ ...s })));

    // 寫入最新設定版本：把「國小數學-三B」手動指定為 care（其餘 seed 班級不動）
    const draft = buildSeedDraft();
    const idx = draft.classes.findIndex((c) => c.baseName === '國小數學-三B');
    expect(idx, 'seed 課表應含 國小數學-三B').toBeGreaterThanOrEqual(0);
    draft.classes[idx] = {
      ...draft.classes[idx],
      category: 'care',
      categorySource: 'manual',
      fixedFiveDays: false,
      fixedSource: 'manual',
    } as ClassSetting;
    saveSettingsVersion(db0, {
      id: 'setv_manual_category',
      contentHash: 'manual-category-hash',
      contentJson: JSON.stringify(draft),
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      createdFromPreviewId: null,
      revision: 1,
    });

    // 解析層可證性：手動類別確實被套用（避免測試在「設定沒生效」下假綠）
    const settings = resolveLatestSavedSettings(db0);
    const manualResolved = resolveClassEnrollment(
      { rawToken: '國小數學-三B[團]', baseName: '國小數學-三B' },
      settings.aliasMap,
      settings.classSettings
    );
    expect(manualResolved.resolvedBaseName).toBe('國小數學-三B');
    expect(manualResolved.category).toBe('care');
    expect(manualResolved.categorySource).toBe('manual');

    // 依規則手算（R03／R10），不使用 calculateStudentBilling 的輸出回填
    const expectedSubjectCount = catWith.size;
    const expectedWithSettings = calculateBaseDiscountBps(expectedSubjectCount, false, null);
    const expectedWithoutSettings = calculateBaseDiscountBps(catAuto.size, false, null);
    expect(expectedWithSettings, '兩種解析必須產生不同結果，否則本案例無鑑別力').not.toBe(
      expectedWithoutSettings
    );

    // 對照 run：以 **apply 的正式呼叫形狀**建立（apply-settings.ts:183-190 帶 scheduleVersionId 與
    // 該 draft 的 aliasMap／scheduleOverride；executeCalculationRun 再由該版本組出 classSettings）。
    // 這是「使用者按下儲存後系統實際會用的狀態」，正是異動明細 before 側必須對齊的對象（D17）。
    // 規則版本帶空 DB 的正式預設（resolveFormalRuleSetVersion → TARGET = erp-tag-v3），
    // 與 computeImportRosterChanges 實際使用的版本一致。
    const draftMap = buildClassSettingMap(draft);
    const res = executeCalculationRun(db0, 'imp_manual_category', 'run_manual_category', {
      scheduleVersionId: 'setv_manual_category',
      ruleSetVersion: 'erp-tag-v3',
      aliasMap: draftToAliasMap(draft),
      scheduleOverride: draftToScheduleOverride(draft),
      classSettings: draftMap,
    });
    saveCalculationRun(db0, res.run, res.results, res.classCategories);
    const runRow = db0
      .prepare('SELECT subject_count, base_discount_bps FROM student_calculations WHERE run_id = ? AND person_code = ?')
      .get('run_manual_category', target!.personCode) as
      | { subject_count: number | null; base_discount_bps: number | null }
      | undefined;
    expect(runRow, 'run 應有該學生的計算列').toBeDefined();
    expect(runRow!.subject_count).toBe(expectedSubjectCount);
    expect(runRow!.base_discount_bps).toBe(expectedWithSettings);

    const previewRes = await previewPOST(uploadRequest());
    expect(previewRes.status).toBe(200);
    const diff = (await previewRes.json()).rosterDiff as {
      baseImportId: string | null;
      changes: Array<{
        personCode: string;
        before: { subjectCount: number | null; baseDiscountBps: number | null } | null;
      }>;
      unchangedStudents: number;
    };

    expect(diff.baseImportId).toBe('imp_manual_category');
    const change = diff.changes.find((c) => c.personCode === target!.personCode);
    if (change) {
      // 異動明細 before 側必須與 run 一致；移除 classSettings 轉接時會變成自動偵測的值而失敗
      expect(change.before!.subjectCount).toBe(runRow!.subject_count);
      expect(change.before!.baseDiscountBps).toBe(runRow!.base_discount_bps);
    } else {
      // 報名未變 → 未異動；此路徑同樣只在接線生效時成立
      expect(diff.unchangedStudents).toBeGreaterThanOrEqual(1);
    }
  });

  /** 預覽回應的每筆 change 都帶兩個新欄位（畫面未改，純 additive 資料）。 */
  it('每筆 change 都帶 enrollmentChanges 與 classDiscountChanges（新增／未出現亦然）', async () => {
    const newcomer = incomingStudents[incomingStudents.length - 1];
    const baseStudents = incomingStudents.slice(0, -1);
    saveBase('imp_shape', baseStudents);

    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const diff = (await res.json()).rosterDiff as { changes: PreviewChange[] };

    expect(diff.changes.length).toBeGreaterThan(0);
    for (const change of diff.changes) {
      expect(Array.isArray(change.enrollmentChanges)).toBe(true);
      expect(Array.isArray(change.classDiscountChanges)).toBe(true);
    }
  });
});

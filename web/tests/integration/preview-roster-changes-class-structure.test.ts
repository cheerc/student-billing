import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDatabase } from '@/adapters/sqlite';
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
import { computeImportRosterChanges } from '@/application/import-roster-diff';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { resolveFormalRuleSetVersion } from '@/application/rule-set-resolver';
import { POST as previewPOST } from '@/app/api/v1/imports/preview/route';
import { calculateSubjectCountByCategory, calculateBaseDiscountBps, parseTagDiscounts } from '@/domain/billing/discount-rules';
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
    const baseOnlyHomework = calculateSubjectCountByCategory([
      resolveClassEnrollment({ rawToken: 'x', baseName: '國小輔導-寫功課' }, undefined, buildClassSettingMap(buildSeedDraft())).category,
    ]);
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
    // 以 seed 類別表選出已映射為 math 的報名；v4 不再由班名推導類別。
    const seedClassSettings = buildClassSettingMap(buildSeedDraft());
    const target = incomingStudents.find(
      (s) => s.enrollments.some(
        (e) => resolveClassEnrollment(e, undefined, seedClassSettings).category === 'math'
      ) && !parseTagDiscounts(s.tagsRaw).sibling
    )!;
    expect(target).toBeDefined();

    const swapFrom = target.enrollments.find((e) => e.baseName.includes('國小數學'))!;
    const alternateMathClass = buildSeedDraft().classes.find(
      (c) => c.baseName !== swapFrom.baseName &&
        resolveClassEnrollment({ rawToken: c.baseName, baseName: c.baseName }, undefined, seedClassSettings).category === 'math'
    )?.baseName;
    expect(alternateMathClass).toBeDefined();
    const swapTo = {
      ...swapFrom,
      rawToken: swapFrom.rawToken.replace(swapFrom.baseName, alternateMathClass!),
      baseName: alternateMathClass!,
    };

    const baseStudents = incomingStudents.map((s) =>
      s.personCode === target.personCode ? { ...s, enrollments: [swapFrom] } : s
    );
    // 獨立手算：換班不動類別 → 科數相同 → basic 相同（兩側同一值）
    const beforeCount = calculateSubjectCountByCategory([
      resolveClassEnrollment(swapFrom, undefined, seedClassSettings).category,
    ]);
    const afterCount = calculateSubjectCountByCategory([
      resolveClassEnrollment(swapTo, undefined, seedClassSettings).category,
    ]);
    expect(beforeCount).toBe(afterCount);
    expect(calculateBaseDiscountBps(beforeCount!, false, null)).toBe(
      calculateBaseDiscountBps(afterCount!, false, null)
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
   *   手動：數學三B→care ⇒ 類別集合少一類 → 科數 −1；對照（不帶 classSettings）數學三B→未設定 ⇒ 不計入。
   *   兩者必須不同，否則本案例無鑑別力（下方以 expect 斷言）。
   *
   * #157 Ruling 1：類別不再由班名推導，因此「不帶 classSettings」不再等於「依班名判定」，
   * 而是「全部未設定」。對照組因此仍能與手動組產生差異，但差異的成因必須改寫為
   * 「使用者有沒有指定」，不得再寫成「自動偵測」。
   */
  it('classSettings 接線：手動把數學班改 care 後，異動明細 before 側與真 run 一致；移除接線則不同', async () => {
    const db0 = getDatabase();
    const categoriesOf = (s: (typeof incomingStudents)[number], map?: Map<string, ClassSettingLookup>) =>
      new Set(
        s.enrollments
          .map((e) => resolveClassEnrollment(e, undefined, map).category)
          // #157：none（使用者指定不列入）與 unset（尚未指定）都不計入科數
          .filter((c): c is 'care' | 'math' | 'english' => c !== 'none' && c !== 'unset')
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
    expect(target, 'fixture 需有一位報名 國小數學-三B 且「有指定／未指定」解析結果不同的學生').not.toBeNull();
    const catWith = categoriesOf(target!, manualMap);
    const catUnset = categoriesOf(target!);

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
    const expectedWithoutSettings = calculateBaseDiscountBps(catUnset.size, false, null);
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
      ruleSetVersion: 'erp-tag-v4',
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

  /**
   * classSettings 接線的**直接可證性**（M3 變異會命中）。
   *
   * 設計：把「國小數學-三B」**手動**設為 `none`（不列入折扣，設定頁合法操作）。
   *   - 帶 classSettings：報名 {輔導(care), 數學三B(none), 英文(english)} → 計入 {care, english} → 2 → 9500
   *     （「數學三B 被手動排除」→ 少了 math 這一類 → 科數下降）
   *   - 不帶 classSettings（自動偵測）：數學三B → math → 計入 {care, math, english} → 3 → 9000
   * 兩者必不同 → 案例有鑑別力。
   *
   * 本次上傳的名單讓該生退掉數學三B → 入口的 before 側必須是「帶 classSettings」的值（2／9500）；
   * 移除 import-roster-diff.ts 的接線後入口會退化成「不帶」（3／9000）→ 斷言失敗。
   */
  it('classSettings 接線：產品入口的 before 側等於帶 classSettings 的計算，且與不帶者不同', async () => {
    const db0 = getDatabase();
    // 寫入把「國小數學-三B」手動設為 none（不列入折扣）的設定版本
    const draft = buildSeedDraft();
    const i = draft.classes.findIndex((c) => c.baseName === '國小數學-三B');
    expect(i, 'seed 課表應含 國小數學-三B').toBeGreaterThanOrEqual(0);
    draft.classes[i] = {
      ...draft.classes[i],
      category: 'none',
      categorySource: 'manual',
      fixedFiveDays: false,
      fixedSource: 'manual',
    } as ClassSetting;
    saveSettingsVersion(db0, {
      id: 'setv_wiring',
      contentHash: 'wiring-hash',
      contentJson: JSON.stringify(draft),
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      createdFromPreviewId: null,
      revision: 1,
    });

    // 目標學生：報名輔導 ＋ 國小數學-三B ＋ 英文（fixture 的實際組合）
    const target =
      incomingStudents.find(
        (s) =>
          s.enrollments.some((e) => e.baseName === '國小數學-三B') &&
          s.enrollments.some((e) => e.baseName.includes('國小輔導')) &&
          s.enrollments.some((e) => e.baseName.includes('兒童美語'))
      ) ?? null;
    expect(target, 'fixture 需有一位「輔導＋國小數學-三B＋英文」的學生').not.toBeNull();

    // 手算（R03 計入類別集合 ＋ R10）：不取用實作輸出
    const settings = resolveLatestSavedSettings(db0);
    const version = resolveFormalRuleSetVersion(db0);
    const categoriesOf = (map?: Map<string, ClassSettingLookup>) =>
      new Set(
        target!.enrollments
          .map((e) => resolveClassEnrollment(e, settings.aliasMap, map).category)
          // #157：none（使用者指定不列入）與 unset（尚未指定）都不計入科數
          .filter((c): c is 'care' | 'math' | 'english' => c !== 'none' && c !== 'unset')
      );
    const catWith = categoriesOf(settings.classSettings);
    const catUnset = categoriesOf();
    expect(catWith.size, '手動排除數學班後計入類別應為 2').toBe(2);
    // #157 Ruling 1：不帶 classSettings＝全部未設定 → 三個班都不計入 → 0。
    expect(catUnset.size, '未指定類別時三班都不計入 → 0').toBe(0);
    const expectedWith = calculateBaseDiscountBps(catWith.size, false, null);
    const expectedUnset = calculateBaseDiscountBps(catUnset.size, false, null);
    expect(expectedWith).not.toBe(expectedUnset);

    // 基準名單：本次上傳的名單，但把該生的「國小數學-三B」退掉 → 該生出現在 changes，before 側可讀
    const targetCode = target!.personCode;
    saveBase('imp_wiring_next', incomingStudents.map((s) => ({
      ...s,
      enrollments:
        s.personCode === targetCode
          ? s.enrollments.filter((e) => e.baseName !== '國小數學-三B')
          : [...s.enrollments],
    })));

    const previewRes = await previewPOST(uploadRequest());
    expect(previewRes.status).toBe(200);
    const diff = (await previewRes.json()).rosterDiff as {
      changes: Array<{
        personCode: string;
        before: { subjectCount: number | null; baseDiscountBps: number | null } | null;
      }>;
    };
    const change = diff.changes.find((c) => c.personCode === targetCode);
    expect(change, '該生應出現在 changes（報名集合有變）').toBeDefined();

    // 入口的 before 側必須等於「帶 classSettings」的結果，且不等於「不帶」的結果
    expect(change!.before!.subjectCount).toBe(catWith.size);
    expect(change!.before!.baseDiscountBps).toBe(expectedWith);
    expect(change!.before!.baseDiscountBps).not.toBe(expectedUnset);
  });

  /**
   * classSettings 接線的**直接可證性**（review B-3／secondary B3；Lead r1 補完指引）。
   *
   * 斷言對象是**產品呼叫鏈本身**：`computeImportRosterChanges`（接線就在 `import-roster-diff.ts` 內）。
   * 用純合成名單，不依賴 fixture、seed 班名或 apply/run 路徑：
   *
   *  1. `settings_versions` 寫一份 draft，其中「國小數學-四A」手動指定為 `care`（`categorySource: 'manual'`）。
   *     `buildClassSettingMap` 以 `baseName` 為 key（`calculate-run.ts:27-38`），`resolveClassEnrollment`
   *     以 `aliasMap` 解析後的 `resolvedBaseName` 取值（`class-category.ts:69-70`）——本案例無別名，
   *     故名冊 `baseName` 即 key。
   *  2. before 名單：該生報「國小數學-四A」＋「國小輔導-一A」。
   *  3. after 名單：加報「兒童美語-EP」→ 該生出現在 changes，可讀其 before 側。
   *
   * 手算（R03 類別式科數＝計入類別集合大小；R10）：
   *   - **帶 classSettings**：數學四A→manual care、輔導→care ⇒ {care} ⇒ 科數 1 ⇒ effectiveCount 1 ⇒ **10000**
   *   - **不帶 classSettings**：數學四A→名稱偵測 math、輔導→care ⇒ {care, math} ⇒ 科數 2 ⇒ effectiveCount 2 ⇒ **9500**
   *
   * 兩者必不同 → 案例有鑑別力。移除 `import-roster-diff.ts` 的接線後，本斷言即失敗。
   */
  it('classSettings 接線：產品呼叫鏈的 before 側等於帶 classSettings 的計算，且與不帶者不同', () => {
    const db = getDatabase();
    const makeStudent = (personCode: string, baseNames: string[]): StudentSnapshot => ({
      personCode,
      name: personCode,
      branch: '合成測試分校',
      gradeRaw: '3',
      grade: 3,
      gradeStatus: 'valid',
      contact: null,
      schoolInfo: null,
      tagsRaw: '',
      tags: [],
      notesRaw: '',
      enrollments: baseNames.map((bn) => ({
        rawToken: `${bn}[團]`,
        yearPrefix: '115',
        baseName: bn,
        groupFlag: '團',
        modifiers: [],
        withdrawalDate: null,
        erpBillingTierRaw: null,
        erpBillingTier: null,
        tierParseStatus: 'not_applicable' as const,
        parseStatus: 'ok' as const,
      })),
      sourceRow: 1,
    });

    const targetCode = 'SYN-CLASS-SETTINGS';
    saveBase('imp_cs_before', [
      makeStudent(targetCode, ['國小數學-四A', '國小輔導-一A']),
    ]);
    saveBase('imp_cs_after', [
      makeStudent(targetCode, ['國小數學-四A', '國小輔導-一A', '兒童美語-EP']),
    ]);

    // 手動把「國小數學-四A」指定為 care（測試資料，不改 seed）
    const draft = buildSeedDraft();
    const idx = draft.classes.findIndex((c) => c.baseName === '國小數學-四A');
    expect(idx, 'seed 課表應含 國小數學-四A').toBeGreaterThanOrEqual(0);
    draft.classes[idx] = {
      ...draft.classes[idx],
      category: 'care',
      categorySource: 'manual',
      fixedFiveDays: false,
      fixedSource: 'manual',
    } as ClassSetting;
    saveSettingsVersion(db, {
      id: 'setv_manual_math_care',
      contentHash: 'manual-math-care-hash',
      contentJson: JSON.stringify(draft),
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      createdFromPreviewId: null,
      revision: 1,
    });

    // 解析層可證性：手動類別確實被套用（避免測試在「設定沒生效」下假綠）
    const settings = resolveLatestSavedSettings(db);
    const manualResolved = resolveClassEnrollment(
      { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
      settings.aliasMap,
      settings.classSettings
    );
    expect(manualResolved.category).toBe('care');
    expect(manualResolved.categorySource).toBe('manual');

    // 手算（R03／R10），不使用實作輸出回填
    const expectedWith = { subjectCount: 1, baseDiscountBps: calculateBaseDiscountBps(1, false, null) };
    const expectedWithout = { subjectCount: 2, baseDiscountBps: calculateBaseDiscountBps(2, false, null) };
    expect(expectedWith.baseDiscountBps).toBe(10000);
    expect(expectedWithout.baseDiscountBps).toBe(9500);

    // 產品呼叫鏈（接線就在其中）
    const diff = computeImportRosterChanges(db, 'imp_cs_after', 'imp_cs_before');
    const change = diff.changes.find((c) => c.personCode === targetCode);
    expect(change, '加報英文班 → 該生必須出現在 changes').toBeDefined();
    expect(change!.before!.subjectCount).toBe(expectedWith.subjectCount);
    expect(change!.before!.baseDiscountBps).toBe(expectedWith.baseDiscountBps);
    // 對照：不帶 classSettings 時的規則推導值（接線若被移除即變成這個）
    expect(expectedWith).not.toEqual(expectedWithout);
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

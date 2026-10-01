import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/adapters/sqlite/migrator';
import { saveImportBatch } from '../src/adapters/sqlite/import-repository';
import { executeCalculationRun } from '../src/application/calculate-run';
import { saveCalculationRun } from '../src/adapters/sqlite/runs-repository';
import ExcelJS from 'exceljs';

/**
 * D2d E：建立「既有 v2 DB」的前置狀態，供升級旅程的瀏覽器層 journey 使用。
 *
 * 背景：課表設定頁的升級勾選只在使用者有 **v2 active run** 時出現
 * （`settings/page.tsx:93` 取 `active.run?.ruleSetVersion`），而 activate 的規則版本
 * 由 server 決定（`activate-import.ts:121` `resolveFormalRuleSetVersion`；無 active run
 * 時得 v3），因此**沒有任何公開 API 能在 E2E 中建立 v2 active run**。
 *
 * 依 decision（Lead 裁定 (d)）：這是「升級前的舊資料」情境前置，不是案例間清理，
 * 故允許在 server 啟動前直接準備隔離 DB；不在 web/src 的產品路徑加測試專用分支。
 *
 * 寫入方式：
 *  - v2 run 本體：以既有 application／adapter 函式建立
 *    （`executeCalculationRun` ＋ `saveCalculationRun`），與 activate 走同一條計算鏈；
 *  - active 指標：`active_state` 沒有對應的 adapter 寫入函式（既有寫入點分散在
 *    `activate-import.ts`／`apply-settings.ts` 內部），故**只以 SQL 寫那一列**。
 *    這是本檔唯一的直接 SQL，已在 PR 與報告中揭露。
 *
 * 用法（由隔離執行器於 server 啟動前呼叫）：
 *   npx tsx scripts/e2e-seed-v2-active.ts <DATABASE_PATH> <FIXTURE.xlsx>
 *
 * 邊界：不讀 `data/`、不動使用者 DB（呼叫端負責傳入臨時目錄下的隔離路徑）；
 * 不建立 alias、不改使用者設定；只建立「一名年級 4、報名兩班數學」的最小 v2 現況。
 */

/** 一名年級 4 學生，重複報名兩班數學：v2 取首班、v3 取扣天最多 → 天數不同（4.5 vs 4）。 */
const GRADE = 4;
const ENROLLMENTS = ['國小數學-四A', '國小數學-四B'];
const IMPORT_ID = 'd2d_v2_fixture';
const RUN_ID = 'd2d_v2_run';
const SETTINGS_VERSION_ID = 'd2d_v2_settings';

async function main(): Promise<void> {
  const [databasePath, fixturePath] = process.argv.slice(2);
  if (!databasePath || !fixturePath) {
    throw new Error('用法：tsx scripts/e2e-seed-v2-active.ts <DATABASE_PATH> <FIXTURE.xlsx>');
  }
  if (!path.isAbsolute(databasePath)) {
    throw new Error(`DATABASE_PATH 必須是絕對路徑，收到 ${databasePath}`);
  }

  const db = new Database(databasePath);
  try {
    runMigrations(db);

    // 匯入合成名單（走正式 importer，確保 student_enrollments 的 token_index 順序）
    const buffer = fs.readFileSync(fixturePath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    const headerRow = sheet.getRow(1);
    const headers = new Map<string, number>();
    headerRow.eachCell((cell, col) => headers.set(String(cell.value ?? '').trim(), col));

    const required = ['人員代碼', '姓名', '所屬班級', '年級'];
    for (const h of required) {
      if (!headers.has(h)) throw new Error(`fixture 缺必要標頭：${h}`);
    }

    const rows: any[] = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const classNames = String(row.getCell(headers.get('所屬班級')!).value ?? '')
        .split(/[,、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (classNames.length === 0) continue;
      rows.push({
        personCode: String(row.getCell(headers.get('人員代碼')!).value ?? ''),
        name: String(row.getCell(headers.get('姓名')!).value ?? ''),
        grade: GRADE,
        gradeRaw: '四年級',
        gradeStatus: 'valid',
        branch: null,
        contact: null,
        schoolInfo: null,
        tagsRaw: '',
        tags: [],
        notesRaw: '',
        sourceRow: rows.length + 1,
        enrollments: classNames.map((baseName) => ({
          rawToken: baseName,
          yearPrefix: null,
          baseName,
          groupFlag: null,
          modifiers: [],
          withdrawalDate: null,
          erpBillingTierRaw: null,
          erpBillingTier: null,
          tierParseStatus: 'not_applicable',
          parseStatus: 'ok',
        })),
      });
    }

    // 只取第一列重複報名兩班數學的學生，構成最小且可判別的 v2 現況
    const withDuplicateMath = rows.find((s) => {
      const math = s.enrollments.filter((e: any) => e.baseName.includes('國小數學'));
      return new Set(math.map((e: any) => e.baseName)).size >= 2;
    });
    if (!withDuplicateMath) {
      throw new Error('fixture 中找不到重複報名兩班數學的學生，無法建立可判別的 v2 現況');
    }
    // 精確收斂為 ENROLLMENTS 兩班，讓「首班 vs 選中班」可判別
    withDuplicateMath.enrollments = ENROLLMENTS.map((baseName) => ({
      rawToken: baseName,
      yearPrefix: null,
      baseName,
      groupFlag: null,
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    }));

    const now = new Date().toISOString();
    saveImportBatch(
      db,
      {
        id: IMPORT_ID,
        fileName: 'd2d-e2e-v2.xlsx',
        fileHash: 'd2d-e2e-v2',
        contentHash: 'd2d-e2e-v2',
        sheetName: sheet.name,
        headerMap: Object.fromEntries(headers),
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: 1,
        status: 'ready',
        createdAt: now,
      },
      [withDuplicateMath] as never
    );

    // v2 run：以既有 application／adapter 函式建立，與 activate 同一條計算鏈
    const res = executeCalculationRun(db, IMPORT_ID, RUN_ID, { ruleSetVersion: 'erp-tag-v2' });
    saveCalculationRun(db, res.run, res.results, res.classCategories);

    // active 指標：無 adapter 可寫，只以 SQL 寫這一列（已於 PR／報告揭露）
    db.prepare(
      'UPDATE active_state SET active_run_id = ?, active_import_id = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
    ).run(RUN_ID, IMPORT_ID, now);

    const active = db.prepare('SELECT active_run_id FROM active_state WHERE id = 1').get() as {
      active_run_id: string;
    };
    const run = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(RUN_ID) as {
      rule_set_version: string;
    };
    console.log(
      `E2E 前置完成：active_run_id=${active.active_run_id} rule_set_version=${run.rule_set_version} 學生=${withDuplicateMath.personCode}`
    );
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('E2E v2 前置失敗：', e);
  process.exit(1);
});

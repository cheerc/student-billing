import Database from 'better-sqlite3';
import { loadStudentsForImport } from '@/adapters/sqlite/import-repository';
import { computeRosterChanges, RosterChange } from './roster-changes';
import { resolveLatestSavedSettings } from './calculate-run';
import { resolveFormalRuleSetVersion } from './rule-set-resolver';

/**
 * 匯入預覽的名單差異（specs/09 §4）：本次上傳的名單相對於「現行名單」的新增／異動／本次未出現。
 *
 * operator 裁決（d-20260929111803466480-4／-5）：「異動」以 before/after **計算結果**判定
 * （折扣與安親／課輔扣除天數），不再用 person_code ＋ 報名 token 指紋代理。
 * before 與 after 都以「目前最新已儲存設定」（課表、別名）與同一個正式軌 ruleSetVersion 計算，
 * 所以兩者之間唯一的差別是名單本身；課表設定的影響由設定預覽（settings-preview）負責，不在此處。
 */
export interface ImportRosterDiff {
  /** 基準（現行）名單 id；null 表示尚無任何名單可比較，統計欄位此時不適用。 */
  baseImportId: string | null;
  newStudents: number;
  /** 兩邊都有、且折扣／適用率／天數任一在 before/after 計算結果不同的人數。 */
  changedStudents: number;
  unchangedStudents: number;
  /** 本次名單未出現的學生數（相對於基準名單）。 */
  notAppearedStudents: number;
  /** 逐人明細：新增、異動、未出現（未異動者不列）。 */
  changes: RosterChange[];
}

const EMPTY: ImportRosterDiff = {
  baseImportId: null,
  newStudents: 0,
  changedStudents: 0,
  unchangedStudents: 0,
  notAppearedStudents: 0,
  changes: [],
};

/**
 * 整批計算本次名單（newImportId）相對於基準名單（baseImportId）的差異。
 * 基準為 null，或基準就是本批（重傳同檔判重回傳既有批次）時不自我比較，回傳 baseImportId:null 與全 0。
 */
export function computeImportRosterChanges(
  db: Database.Database,
  newImportId: string,
  baseImportId: string | null
): ImportRosterDiff {
  if (!baseImportId || baseImportId === newImportId) {
    return { ...EMPTY, changes: [] };
  }

  const before = loadStudentsForImport(db, baseImportId);
  const after = loadStudentsForImport(db, newImportId);

  const settings = resolveLatestSavedSettings(db);
  const ctx = {
    aliasMap: settings.aliasMap,
    scheduleOverride: settings.scheduleOverride,
    // D2a／spike §B4：帶 classSettings，讓異動明細的 before 側與真正建 run 的類別解析**同源**
    // （specs/11 §3 B1-D「共用同一套類別解析」；D17 照實呈現）。未帶時會退回自動偵測，
    // 使用者看到的「前」狀態就會與按下之後系統實際會用的狀態不同。
    classSettings: settings.classSettings,
    ruleSetVersion: resolveFormalRuleSetVersion(db),
  };

  const result = computeRosterChanges(before, after, ctx, ctx);
  return {
    baseImportId,
    newStudents: result.stats.newCount,
    changedStudents: result.stats.changedCount,
    unchangedStudents: result.stats.unchangedCount,
    notAppearedStudents: result.stats.removedCount,
    changes: result.changes,
  };
}

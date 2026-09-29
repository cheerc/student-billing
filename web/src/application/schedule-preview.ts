import Database from 'better-sqlite3';
import {
  CalculateDraft,
  CalculateDraftSchema,
  SettingsDraft,
  SettingsDraftSchema,
  isCompleteTimeRange,
} from '@/contracts/settings';
import { draftToScheduleOverride, hashSettingsDraft } from '@/adapters/sqlite/settings-repository';
import {
  CARE_WINDOWS,
  CARE_WINDOW_WEEKDAYS,
  RuleSetOptions,
  calculateClassDeductionD24,
  calculateSessionDeduction,
  isUnknownWeekday,
} from '@/domain/schedules/overlap-calculator';
import seedData from '@/domain/schedules/schedule-seed.json';

/**
 * 唯讀計算 read model（09 §8.1／04 §8 UX05–UX08、UX19、UX24）。
 *
 * 重用 overlap-calculator 與「run 計算所用的同一個」draftToScheduleOverride 轉換，不在別處複製公式：
 * 逐堂預覽、班級扣天與學生 run 對空時段／停用／整班移除班級因此同源（UX23）。
 * 純計算：不寫 DB、不建 preview／run。窗口一律取 ruleSet（overlap-calculator 的 CARE_WINDOWS），
 * 不讀 draft.careWindows（窗口固定，D33）。
 *
 * 輸入是 CalculateDraft（編輯中的 draft）：session 可為不完整列（起／迄 null 或迄 ≤ 起）並帶 client 的 rowId。
 * 不完整列回 null＋missing_time＋SCHEDULE_INCOMPLETE，班級標 incomplete；班級扣天與 draftHash 一律以
 * 「存檔等價 draft」（toSaveEquivalentDraft：去掉不完整列與 rowId，同 gridRowsToClasses 存檔的結果）計算，
 * 所以預覽數字等於這份設定存檔後 run 的數字。
 */

/** 正式軌 ruleSetVersion（診斷軌 excel-v260922-compat 不作正式值，根 CLAUDE.md §2）。 */
export type FormalRuleSetVersion = 'erp-tag-v1' | 'erp-tag-v2';
const FORMAL_RULE_SET_VERSIONS: ReadonlySet<string> = new Set<FormalRuleSetVersion>(['erp-tag-v1', 'erp-tag-v2']);
/** 現行正式軌。 */
export const CURRENT_FORMAL_RULE_SET_VERSION: FormalRuleSetVersion = 'erp-tag-v2';

/** 單堂／班級某一類照顧（安親／課輔）的狀態：警告類與「已驗證無衝堂」分開。 */
export type CareStatus =
  | 'calculated' // 有重疊，已計算
  | 'no_overlap' // 星期合法且已驗證與窗口無交集（含合法週六）
  | 'unknown_weekday' // 星期缺失或無法識別：v2 fail-closed 為 0，但不是「無衝堂」
  | 'missing_time' // 列：起訖不完整（缺起／缺迄／迄≤起）；班級（無任何列）：沒有時段（待補）
  | 'incomplete' // 班級層：含不完整列。扣天只統計完整列，不顯示成 calculated
  | 'shared_window' // seed 的共用窗口班（care_window），本身沒有 session，不捏造
  | 'inactive'; // 班級停用，不計算

export interface WindowView {
  startMinutes: number;
  endMinutes: number;
  weekdays: string[];
}

export interface SchedulePreviewWindows {
  anqin: WindowView;
  tutoring: WindowView;
}

export interface PreviewRowGroup {
  /** 重疊分鐘；無時段／停用／共用窗口為 null（未計算），未知星期為 0（fail-closed，狀態另標）。 */
  overlapMinutes: number | null;
  /** 未取整扣天（domain 負值；UI 以正量顯示）；同上 null 語意。 */
  rawDeduction: number | null;
  status: CareStatus;
}

export interface PreviewRow {
  /** client 帶的 rowId 原樣回傳；未帶才補 `班名#序號`（空班佔位列為 `班名#placeholder`）。 */
  rowId: string;
  classKey: string;
  teacher: string | null;
  weekday: string | null;
  startMinutes: number | null;
  endMinutes: number | null;
  durationMinutes: number | null;
  anqin: PreviewRowGroup;
  tutoring: PreviewRowGroup;
}

export interface PreviewClassGroup {
  totalOverlapMinutes: number;
  /** 各堂未取整扣天加總（domain 負值） */
  raw: number;
  /** D24 同班先合計再取整後的實扣（負值；0 表示不扣） */
  rounded: number;
  status: CareStatus;
}

export interface PreviewClass {
  classKey: string;
  teacher: string | null;
  active: boolean;
  rowIds: string[];
  anqin: PreviewClassGroup;
  tutoring: PreviewClassGroup;
}

export interface PreviewIssue {
  code: 'SCHEDULE_EMPTY' | 'SCHEDULE_INCOMPLETE' | 'UNKNOWN_WEEKDAY';
  classKey: string;
  rowId: string | null;
  message: string;
}

export interface SchedulePreviewCore {
  ruleSetVersion: FormalRuleSetVersion;
  windows: SchedulePreviewWindows;
  rows: PreviewRow[];
  classes: PreviewClass[];
  issues: PreviewIssue[];
}

export interface CalculatePreviewResponse extends SchedulePreviewCore {
  requestKey: string;
  draftHash: string;
}

export class SchedulePreviewError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, message: string, code = 'SCHEDULE_PREVIEW_FAILED') {
    super(message);
    this.name = 'SchedulePreviewError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** ruleSet 窗口（唯讀）。 */
export const CARE_WINDOWS_VIEW: SchedulePreviewWindows = {
  anqin: {
    startMinutes: CARE_WINDOWS.anqin.start,
    endMinutes: CARE_WINDOWS.anqin.end,
    weekdays: [...CARE_WINDOW_WEEKDAYS],
  },
  tutoring: {
    startMinutes: CARE_WINDOWS.tutoring.start,
    endMinutes: CARE_WINDOWS.tutoring.end,
    weekdays: [...CARE_WINDOW_WEEKDAYS],
  },
};

/** seed 內的共用窗口班（source=care_window）：沒有自己的 session，不捏造。 */
const SHARED_WINDOW_CLASSES: ReadonlySet<string> = new Set(
  (seedData.classes as Array<{ baseName: string; source: string }>)
    .filter((c) => c.source === 'care_window')
    .map((c) => c.baseName)
);

/**
 * draft.careWindows 是否等於 ruleSet 窗口。窗口固定（D33）：draft 仍必帶 careWindows（schema 必填），
 * 但只允許 ruleSet 值；不符由呼叫端回 400 INVALID_DRAFT，不靜默忽略。
 */
export function careWindowsMatchRuleSet(draft: Pick<SettingsDraft, 'careWindows'>): boolean {
  return (
    draft.careWindows.anqin.startMinutes === CARE_WINDOWS.anqin.start &&
    draft.careWindows.anqin.endMinutes === CARE_WINDOWS.anqin.end &&
    draft.careWindows.tutoring.startMinutes === CARE_WINDOWS.tutoring.start &&
    draft.careWindows.tutoring.endMinutes === CARE_WINDOWS.tutoring.end
  );
}

export const CARE_WINDOWS_MISMATCH_MESSAGE =
  'careWindows 與系統固定窗口不同：安親（週一至五 13:00–16:00）與課輔（週一至五 16:30–19:30）窗口固定不可編輯，請帶系統窗口值。';

/**
 * 由 server 決定的正式軌 ruleSetVersion（09 §8.1）：有 active run 且其版本為正式軌則採其值；
 * 否則（無 active run，或 active run 為診斷軌 compat）採現行正式軌 erp-tag-v2。client 不得指定。
 */
export function resolveFormalRuleSetVersion(db: Database.Database): FormalRuleSetVersion {
  const active = db.prepare('SELECT active_run_id FROM active_state WHERE id = 1').get() as
    | { active_run_id: string | null }
    | undefined;
  if (active?.active_run_id) {
    const run = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(active.active_run_id) as
      | { rule_set_version: string }
      | undefined;
    if (run && FORMAL_RULE_SET_VERSIONS.has(run.rule_set_version)) {
      return run.rule_set_version as FormalRuleSetVersion;
    }
  }
  return CURRENT_FORMAL_RULE_SET_VERSION;
}

export function isFormalRuleSetVersion(v: string): v is FormalRuleSetVersion {
  return FORMAL_RULE_SET_VERSIONS.has(v);
}

const normZero = (n: number): number => (n === 0 ? 0 : n);

/**
 * 存檔等價 draft：去掉不完整列（起／迄缺，或迄 ≤ 起）與 rowId，其餘同輸入。
 * 這正是同一份編輯狀態經 gridRowsToClasses 存檔（settings/preview → apply）會得到的班級：
 * 班級扣天與 draftHash 都以它為準，預覽數字因此等於存檔後 run 的數字，
 * draftHash 也等於同一份設定送 settings/preview 的 inputHash（不完整列與 rowId 不入 hash）。
 * 只做物件轉換、不重新驗證（輸入已通過 CalculateDraftSchema，或來自已存檔的完整 draft）。
 */
export function toSaveEquivalentDraft(draft: CalculateDraft): SettingsDraft {
  return {
    ...draft,
    classes: draft.classes.map((c) => ({
      ...c,
      sessions: c.sessions.filter(isCompleteTimeRange).map((s) => ({
        weekday: s.weekday,
        startMinutes: s.startMinutes,
        endMinutes: s.endMinutes,
      })),
    })),
  };
}

function incompleteReason(s: { startMinutes: number | null; endMinutes: number | null }): string {
  if (s.startMinutes === null && s.endMinutes === null) return '缺起訖時間';
  if (s.startMinutes === null) return '缺起始時間';
  if (s.endMinutes === null) return '缺結束時間';
  return '結束時間須晚於起始時間';
}

function aggregateStatus(a: {
  active: boolean;
  shared: boolean;
  completeCount: number;
  incompleteCount: number;
  anyUnknownWeekday: boolean;
  totalOverlapMinutes: number;
}): CareStatus {
  if (!a.active) return 'inactive';
  // 沒有任何完整時段：無列（待補）或只有 seed 共用窗口班自己的 null 時間列
  if (a.completeCount === 0 && (a.incompleteCount === 0 || a.shared)) return a.shared ? 'shared_window' : 'missing_time';
  if (a.incompleteCount > 0) return 'incomplete';
  if (a.anyUnknownWeekday) return 'unknown_weekday';
  return a.totalOverlapMinutes > 0 ? 'calculated' : 'no_overlap';
}

/**
 * 純計算核心：由 draft 與 ruleSetVersion 產生逐堂列、班級扣天與問題清單。
 * 每個 draft 班級、每一個輸入列都有結果（不漏掉不能計算的班／列）；班級不在 draft 內不會出現（run 端落 schedule_not_found）。
 */
export function buildSchedulePreview(draft: CalculateDraft, ruleSetVersion: FormalRuleSetVersion): SchedulePreviewCore {
  const options: RuleSetOptions = { sameWeekdayOnly: ruleSetVersion === 'erp-tag-v2' };
  // 與 run 計算（apply／activate）同一個轉換，且輸入是存檔等價 draft：停用、空 sessions 皆為空覆寫（不扣天，09 §8.2.4）
  const override = draftToScheduleOverride(toSaveEquivalentDraft(draft));

  const rows: PreviewRow[] = [];
  const classes: PreviewClass[] = [];
  const issues: PreviewIssue[] = [];

  for (const c of draft.classes) {
    const shared = SHARED_WINDOW_CLASSES.has(c.baseName);
    const calcSessions = override.get(c.baseName) ?? [];
    const rowIds: string[] = [];
    let anyUnknownWeekday = false;
    let completeCount = 0;
    let incompleteCount = 0;

    if (c.sessions.length === 0) {
      // 空時段列仍回 null 佔位（不捏造 session）；停用班不列缺時間問題
      const rowId = `${c.baseName}#placeholder`;
      const status: CareStatus = !c.active ? 'inactive' : shared ? 'shared_window' : 'missing_time';
      const group: PreviewRowGroup = { overlapMinutes: null, rawDeduction: null, status };
      rows.push({
        rowId,
        classKey: c.baseName,
        teacher: c.teacher,
        weekday: null,
        startMinutes: null,
        endMinutes: null,
        durationMinutes: null,
        anqin: { ...group },
        tutoring: { ...group },
      });
      rowIds.push(rowId);
      if (c.active && !shared) {
        issues.push({
          code: 'SCHEDULE_EMPTY',
          classKey: c.baseName,
          rowId,
          message: `班級「${c.baseName}」目前沒有任何時段：學生不扣天並列入問題，請補上時段。`,
        });
      }
    } else {
      c.sessions.forEach((s, i) => {
        // client 的 rowId（對應 grid 列）原樣回傳；沒帶才補序號，供沒有 grid 的呼叫端使用
        const rowId = s.rowId ?? `${c.baseName}#${i}`;
        rowIds.push(rowId);

        if (!isCompleteTimeRange(s)) {
          // 不完整列：不計算、不捏造分鐘數；起迄如實回傳讓畫面標出缺哪一格
          incompleteCount += 1;
          const status: CareStatus = !c.active ? 'inactive' : shared ? 'shared_window' : 'missing_time';
          const group: PreviewRowGroup = { overlapMinutes: null, rawDeduction: null, status };
          rows.push({
            rowId,
            classKey: c.baseName,
            teacher: c.teacher,
            weekday: s.weekday,
            startMinutes: s.startMinutes,
            endMinutes: s.endMinutes,
            durationMinutes: null,
            anqin: { ...group },
            tutoring: { ...group },
          });
          if (c.active && !shared) {
            issues.push({
              code: 'SCHEDULE_INCOMPLETE',
              classKey: c.baseName,
              rowId,
              message: `班級「${c.baseName}」的時段（星期${s.weekday}）尚未填完整：${incompleteReason(s)}。此列不計算，存檔時也不會產生這個時段。`,
            });
          }
          return;
        }

        completeCount += 1;
        const unknown = options.sameWeekdayOnly === true && isUnknownWeekday(s.weekday);
        if (unknown && c.active) {
          anyUnknownWeekday = true;
          issues.push({
            code: 'UNKNOWN_WEEKDAY',
            classKey: c.baseName,
            rowId,
            message: `班級「${c.baseName}」有時段星期為「${s.weekday}」，無法識別：v2 同星期規則下該時段衝堂計為 0，請核對星期。`,
          });
        }
        const group = (type: 'anqin' | 'tutoring'): PreviewRowGroup => {
          if (!c.active) return { overlapMinutes: null, rawDeduction: null, status: 'inactive' };
          const ded = calculateSessionDeduction(s.startMinutes, s.endMinutes, type, options, s.weekday);
          const status: CareStatus = unknown ? 'unknown_weekday' : ded.overlapMinutes > 0 ? 'calculated' : 'no_overlap';
          return { overlapMinutes: ded.overlapMinutes, rawDeduction: normZero(ded.rawDeduction), status };
        };
        rows.push({
          rowId,
          classKey: c.baseName,
          teacher: c.teacher,
          weekday: s.weekday,
          startMinutes: s.startMinutes,
          endMinutes: s.endMinutes,
          durationMinutes: s.endMinutes - s.startMinutes,
          anqin: group('anqin'),
          tutoring: group('tutoring'),
        });
      });
    }

    const classGroup = (type: 'anqin' | 'tutoring'): PreviewClassGroup => {
      // 只統計完整列：calcSessions 來自存檔等價 draft，與存檔後 run 的輸入相同
      const res =
        c.active && calcSessions.length > 0
          ? calculateClassDeductionD24(calcSessions, type, options)
          : { totalOverlapMinutes: 0, raw: 0, rounded: 0 };
      return {
        totalOverlapMinutes: res.totalOverlapMinutes,
        raw: normZero(res.raw),
        rounded: normZero(res.rounded),
        status: aggregateStatus({
          active: c.active,
          shared,
          completeCount,
          incompleteCount,
          anyUnknownWeekday,
          totalOverlapMinutes: res.totalOverlapMinutes,
        }),
      };
    };

    classes.push({
      classKey: c.baseName,
      teacher: c.teacher,
      active: c.active,
      rowIds,
      anqin: classGroup('anqin'),
      tutoring: classGroup('tutoring'),
    });
  }

  return { ruleSetVersion, windows: CARE_WINDOWS_VIEW, rows, classes, issues };
}

const MAX_REQUEST_KEY_LENGTH = 128;

/**
 * POST /api/v1/settings/calculate 的應用層：驗證輸入並回傳 read model。
 * 只讀 DB 取得 active run 的 ruleSetVersion（不寫入、不建 preview／run）。
 */
export function calculateSchedulePreview(db: Database.Database, rawBody: unknown): CalculatePreviewResponse {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    throw new SchedulePreviewError(400, '請求內容必須是 JSON 物件', 'INVALID_REQUEST');
  }
  const body = rawBody as Record<string, unknown>;
  // ruleSetVersion 由 server 決定，client 不得指定（尤其不得指定診斷軌）
  if ('ruleSetVersion' in body) {
    throw new SchedulePreviewError(400, 'ruleSetVersion 由伺服器決定，請勿帶入', 'INVALID_REQUEST');
  }
  const requestKey = body.requestKey;
  if (typeof requestKey !== 'string' || requestKey.length === 0 || requestKey.length > MAX_REQUEST_KEY_LENGTH) {
    throw new SchedulePreviewError(400, `requestKey 必須是 1–${MAX_REQUEST_KEY_LENGTH} 字元的字串`, 'INVALID_REQUEST');
  }

  // 編輯中的 draft：允許不完整列（起／迄 null 或迄 ≤ 起）與 client rowId；其餘欄位驗證同 SettingsDraftSchema
  const parsed = CalculateDraftSchema.safeParse(body.draft);
  if (!parsed.success) {
    throw new SchedulePreviewError(400, `設定草稿格式錯誤：${parsed.error.message}`, 'INVALID_DRAFT');
  }
  const draft = parsed.data;
  if (!careWindowsMatchRuleSet(draft)) {
    throw new SchedulePreviewError(400, CARE_WINDOWS_MISMATCH_MESSAGE, 'INVALID_DRAFT');
  }
  const names = new Set<string>();
  for (const c of draft.classes) {
    if (names.has(c.baseName)) {
      throw new SchedulePreviewError(400, `班級名稱重複：「${c.baseName}」`, 'INVALID_DRAFT');
    }
    names.add(c.baseName);
  }

  const core = buildSchedulePreview(draft, resolveFormalRuleSetVersion(db));

  // rowId 必須唯一，結果才能一對一掛回畫面的列（含 client 給的與 server 補的撞名）
  const seenRowIds = new Set<string>();
  for (const r of core.rows) {
    if (seenRowIds.has(r.rowId)) {
      throw new SchedulePreviewError(400, `rowId 重複：「${r.rowId}」`, 'INVALID_DRAFT');
    }
    seenRowIds.add(r.rowId);
  }

  // draftHash＝存檔等價 draft 的 hash（經 SettingsDraftSchema 正規化，與 settings/preview 的 inputHash 同一算法同一輸入）
  const draftHash = hashSettingsDraft(SettingsDraftSchema.parse(toSaveEquivalentDraft(draft)));
  return { requestKey, draftHash, ...core };
}

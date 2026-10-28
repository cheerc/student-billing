import Database from 'better-sqlite3';
import {
  CalculateDraft,
  CalculateDraftSchema,
  ClassType,
  SettingsDraft,
  SettingsDraftSchema,
  isCompleteTimeRange,
  isSavableWeekday,
  splitSavableSessions,
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
import { resolveClassAttributes } from '@/domain/classification/class-attributes';
import type { CareStatus } from './care-status';
import { FormalRuleSetVersion, TARGET_FORMAL_RULE_SET_VERSION } from '@/domain/billing/rule-set';

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

export type { CareStatus };

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
    classes: draft.classes.map((c) => {
      const resolvedType: ClassType =
        c.classType === 'non_care' ? 'other' : (c.classType ?? 'other');
      const { sessions, incompleteSessions } = splitSavableSessions(
        resolvedType,
        c.sessions
      );
      return {
        ...c,
        sessions,
        ...(incompleteSessions !== undefined ? { incompleteSessions } : {}),
      };
    }),
  };
}

function incompleteReason(s: { startMinutes: number | null; endMinutes: number | null }): string {
  if (s.startMinutes === null && s.endMinutes === null) return '缺起訖時間';
  if (s.startMinutes === null) return '缺起始時間';
  if (s.endMinutes === null) return '缺結束時間';
  return '結束時間須晚於起始時間';
}

/**
 * 星期無法識別（含空白）的原因說明：寫出輸入的值，並明說「不代表沒有衝堂」（09 §3.1）。
 * 空白星期單獨說「沒有填星期」，讓使用者知道是漏填而不是填錯。
 */
export function unknownWeekdayMessage(classKey: string, weekday: string): string {
  const consequence = '該時段的衝堂以 0 計，不代表沒有衝堂';
  if (weekday.trim() === '') {
    return `班級「${classKey}」有一個時段沒有填星期，無法識別：${consequence}，請填上星期（一到日）。`;
  }
  return `班級「${classKey}」有時段星期為「${weekday}」，無法識別：${consequence}，請把星期改成一到日。`;
}

function aggregateStatus(a: {
  active: boolean;
  shared: boolean;
  unscheduled: boolean;
  /** #113：班級勾選「不計扣天」→ 重疊分鐘刻意為 0，狀態要如實說明是政策而非算不出來。 */
  skipDeduction: boolean;
  completeCount: number;
  incompleteCount: number;
  anyUnknownWeekday: boolean;
  totalOverlapMinutes: number;
}): CareStatus {
  if (!a.active) return 'inactive';
  // specs/14 §3.7：安親課輔班專門狀態
  if (a.shared) return 'shared_window';
  // D61 Phase 2：不排課班級專門狀態
  if (a.unscheduled) return 'unscheduled';
  if (a.completeCount === 0 && a.incompleteCount === 0) return 'missing_time';
  if (a.incompleteCount > 0) return 'incomplete';
  if (a.anyUnknownWeekday) return 'unknown_weekday';
  // #113：不計扣天排在 calculated 之前（無重疊 = 2 < 不計扣天 = 3 → 兩側任一為不計扣天即顯示不計扣天）。
  // 該班確實可能與窗口重疊，只是政策不扣天；顯示成「無重疊」會讓核對者誤以為時段不衝突。
  if (a.skipDeduction) return 'no_deduction';
  return a.totalOverlapMinutes > 0 ? 'calculated' : 'no_overlap';
}

/**
 * 純計算核心：由 draft 與 ruleSetVersion 產生逐堂列、班級扣天與問題清單。
 * 每個 draft 班級、每一個輸入列都有結果（不漏掉不能計算的班／列）；班級不在 draft 內不會出現（run 端落 schedule_not_found）。
 */
export function buildSchedulePreview(draft: CalculateDraft, ruleSetVersion: FormalRuleSetVersion): SchedulePreviewCore {
  const options: RuleSetOptions = { sameWeekdayOnly: true };
  // 與 run 計算（apply／activate）同一個轉換，且輸入是存檔等價 draft：停用、空 sessions 皆為空覆寫（不扣天，09 §8.2.4）
  const override = draftToScheduleOverride(toSaveEquivalentDraft(draft));

  const rows: PreviewRow[] = [];
  const classes: PreviewClass[] = [];
  const issues: PreviewIssue[] = [];

  for (const c of draft.classes) {
    // specs/14 §3.7 & D61：專門狀態改依班級設定之課程類型判定
    // 經 resolveClassAttributes 正規化後判定，相容舊草稿未帶 classType 屬性
    const resolvedType = resolveClassAttributes(c.baseName, c).classType;
    const shared = resolvedType === 'care';
    const unscheduled = resolvedType === 'unscheduled';
    const calcSessions = override.get(c.baseName) ?? [];
    // #113 follow-up（逐時段）：只有未勾選的時段才納入扣天。
    // 勾選者時段仍保留（不是 schedule_empty），只是不扣天。
    const deductibleSessions = calcSessions.filter((s) => s.skipDeduction !== true);
    // 該班是否「整班都勾選不計扣天」（逐時段版的班級層歸零條件）
    const allSessionsSkipped = calcSessions.length > 0 && deductibleSessions.length === 0;
    const rowIds: string[] = [];
    let anyUnknownWeekday = false;
    let completeCount = 0;
    let incompleteCount = 0;

    if (c.sessions.length === 0) {
      // 空時段列仍回 null 佔位（不捏造 session）；停用班、共用窗口班與不排課班不列缺時間問題
      const rowId = `${c.baseName}#placeholder`;
      const status: CareStatus = !c.active
        ? 'inactive'
        : shared
          ? 'shared_window'
          : unscheduled
            ? 'unscheduled'
            : 'missing_time';
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
      if (c.active && !shared && !unscheduled) {
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
          const status: CareStatus = !c.active
            ? 'inactive'
            : shared
              ? 'shared_window'
              : unscheduled
                ? 'unscheduled'
                : 'missing_time';
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
          if (c.active && !shared && !unscheduled) {
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
            message: unknownWeekdayMessage(c.baseName, s.weekday),
          });
        }
        const group = (type: 'anqin' | 'tutoring'): PreviewRowGroup => {
          if (!c.active) return { overlapMinutes: null, rawDeduction: null, status: 'inactive' };
          const ded = calculateSessionDeduction(s.startMinutes, s.endMinutes, type, options, s.weekday);
          // #113 follow-up（逐時段）：這一列勾了「不計扣天」→ **逐堂**仍回實測的重疊分鐘與未取整扣天，
          // 但扣天歸零並標上 no_deduction。
          const rowSkips = s.skipDeduction === true;
          const status: CareStatus = unknown
            ? 'unknown_weekday'
            : rowSkips
              ? 'no_deduction'
              : ded.overlapMinutes > 0
                ? 'calculated'
                : 'no_overlap';
          return {
            overlapMinutes: ded.overlapMinutes,
            rawDeduction: rowSkips ? 0 : normZero(ded.rawDeduction),
            status,
          };
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
      // 只統計未勾選「不計扣天」的完整列：calcSessions 來自存檔等價 draft，與存檔後 run 的輸入相同。
      const res =
        c.active && deductibleSessions.length > 0
          ? calculateClassDeductionD24(deductibleSessions, type, options)
          : { totalOverlapMinutes: 0, raw: 0, rounded: 0 };
      return {
        totalOverlapMinutes: res.totalOverlapMinutes,
        raw: normZero(res.raw),
        rounded: normZero(res.rounded),
        status: aggregateStatus({
          active: c.active,
          shared,
          unscheduled,
          // 逐時段版的班級層「不計扣天」＝ 該班**每一列**都勾選；只勾部分時段則照實計算未勾選的那些。
          skipDeduction: allSessionsSkipped,
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
  // ruleSetVersion 由 server 決定，client 不得指定；一律使用單一現行規則 erp-tag-v4。
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

  const core = buildSchedulePreview(draft, TARGET_FORMAL_RULE_SET_VERSION);

  // rowId 必須唯一，結果才能一對一掛回畫面的列（含 client 給的與 server 補的撞名）
  const seenRowIds = new Set<string>();
  for (const r of core.rows) {
    if (seenRowIds.has(r.rowId)) {
      throw new SchedulePreviewError(400, `rowId 重複：「${r.rowId}」`, 'INVALID_DRAFT');
    }
    seenRowIds.add(r.rowId);
  }

  // draftHash 使用與 settings/preview 的 inputHash 相同算法，輸入先去掉不完整時段、rowId 與不可存檔的星期列。
  // 含空白或過長星期的原草稿仍會被 settings/preview 拒絕；此 hash 對應移除這些列後的草稿，
  // 不代表原草稿可提交，也不取代 row-level 狀態與問題。
  const savable = toSaveEquivalentDraft(draft);
  const draftHash = hashSettingsDraft(
    SettingsDraftSchema.parse({
      ...savable,
      classes: savable.classes.map((c) => ({ ...c, sessions: c.sessions.filter((s) => isSavableWeekday(s.weekday)) })),
    })
  );
  return { requestKey, draftHash, ...core };
}

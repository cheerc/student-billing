'use client';

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  SettingsDraft,
  ClassSetting,
  ScheduleGridRow,
  classesToGridRows,
  gridRowsToClasses,
  gridRowsToCalculateClasses,
  timeStringToMinutes,
  minutesToTimeString,
  buildSeedGridRows,
  detectSplitClasses,
  SettingsBaseline,
  isSettingsDirty,
  type ClassAttributeSetting,
  type ClassType,
} from '@/contracts/settings';
import { DynamicCandidate, buildDynamicCandidates, type CandidateCounts } from '@/domain/schedules/seed-manifest';
import { CalculatePreviewResponse } from '@/application/schedule-preview';
import type { ClassNameMatchReport } from '@/application/class-name-match-report';
import { WindowSummary } from '@/components/settings/window-summary';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { ImpactDialog, SettingsPreviewData } from '@/components/settings/impact-dialog';
import { LeaveConfirmDialog } from '@/components/settings/leave-confirm-dialog';
import { MappingPanel } from '@/components/settings/mapping-panel';
import {
  attributesFromDraftClasses,
  attributesFromBaselineClasses,
  carryAttributesOnRename,
  detectClassLifecycle,
  detectMergeConflicts,
  resolveClassAttributes,
  toSavedClassAttributes,
  CATEGORY_LABELS,
  type ClassAttributesView,
} from '@/domain/classification/class-attributes';
import type { ClassCategory } from '@/domain/classification/class-category';
import { TabList, tabPanelProps } from '@/components/ui/tabs';
import { useUnsavedChangesGuard } from '@/components/ui/use-unsaved-changes-guard';
import { formatDateTime } from '@/lib/datetime';
import {
  describeSettingsApplyError,
  describeSettingsPreviewError,
  failureFromException,
  readRawFailure,
  type UserFacingError,
} from '@/lib/user-messages';
import { isFormalRuleSetVersion, TARGET_FORMAL_RULE_SET_VERSION } from '@/domain/billing/rule-set';

interface SettingsEditorProps {
  importId: string | null;
  currentRevision: number;
  initialDraft: SettingsDraft;
  unmatched?: string[];
  /** 班名比對報告（D1）；由 server 依 ?import= 的名單（預設現行名單）產生 */
  classNameReport?: ClassNameMatchReport | null;
  /** 班名比對報告所檢視的名單（server 的 reviewImportId）：儲存後就地刷新要看同一份名單，而不是編輯器儲存所依據的現行名單 */
  reportImportId?: string | null;
  matchedCount?: number;
  candidates?: DynamicCandidate[];
  lastAppliedRevision?: number;
  lastAppliedAt?: string | null;
  hasActiveImport?: boolean;
  /** 網址 tab 參數決定開啟的頁籤（預設課表） */
  initialTab?: 'schedule' | 'mapping';
  /** 「編輯此班課表」帶入的班級（班名）：課表頁定位並列出該班全部時段（F04） */
  focusClass?: string | null;
  /** 報告重新取得失敗後的自動重試間隔（測試注入用；預設為約 1s、3s） */
  reportRefreshRetryDelaysMs?: number[];
  /**
   * D2b 4（Q11）：現行 run 的規則版本。v2 時顯示「改用新規則」升級動作（明確確認，不靜默切換）。
   * #112：目標正式軌改為 erp-tag-v4（固定 5 天與課程學費折扣解耦）。
   * null＝尚無啟用的 run（空 DB，該 run 建立時即為目標版本 v3，無需升級動作）。
   */
  currentRuleSetVersion?: string | null;
}

/** 計算失敗時的說明（不外露狀態碼或工程字）；ScheduleGrid 會補上「不代表沒有衝堂」。 */
const CALCULATE_FAILED_MESSAGE = '無法計算重疊與扣除天數，請稍後再試。';

/**
 * 報告重新取得失敗時的單行標示（UX46／operator 裁決 d-20261002162913018695-69）。
 * 只說做什麼、怎麼恢復，不解釋原因，也不勸告重新匯入。
 */
const REPORT_REFRESH_FAILED_MESSAGE = '無法取得最新的班名比對報告。';

/**
 * 自動重試間隔（毫秒）：第一次失敗後約 1s、第二次失敗後約 3s，之後交給使用者按鈕。
 * 測試可縮短（prop 注入）；單元測試以 0 等待，E2E 用真實間隔（總計 4s，不改用真 sleep 拉長）。
 */
export const REPORT_REFRESH_RETRY_DELAYS_MS = [1000, 3000];

/** 報告刷新失敗後的復原階段：retrying＝自動重試中（不顯示錯誤畫面、候選表鎖定）；reload＝請按［重新載入］；reloadPage＝請按［重新整理頁面］。 */
type ReportRecoveryStage = 'retrying' | 'reload' | 'reloadPage';

/** 有效屬性 → isSettingsDirty 的 ClassAttributeSetting 形狀（className 為 key）。 */
function toClassAttributeSetting(a: ClassAttributesView & { className?: string }): ClassAttributeSetting {
  return {
    className: a.className ?? '',
    classType: a.classType,
    category: a.category,
    categorySource: a.categorySource,
    fixedFiveDays: a.fixedFiveDays,
  };
}

/**
 * 把手動覆寫寫進 draft 的班級（存檔／預覽都用它）。
 * specs/14 §3.10：classType 與 fixedFiveDays 隨班保存，不再有 fixedSource。
 */
function applyManualAttrsToClasses<T extends { baseName: string; classType?: 'care' | 'non_care' }>(
  classes: Array<T & Record<string, unknown>>,
  manualAttrs: Map<string, ClassAttributesView>
): Array<T & Record<string, unknown>> {
  return classes.map((c) => {
    const clean = { ...c };
    delete clean.category;
    delete clean.categorySource;
    delete clean.fixedFiveDays;
    delete clean.fixedSource;
    // #113 follow-up：不計扣天已逐時段化（sessions[].skipDeduction），不再是班級欄位。
    // 舊快照的班級層旗標一律剝除，不被寫回 draft（否則會與逐列旗標分岔成兩個來源）。
    delete clean.skipDeduction;
    delete clean.skipDeductionSource;
    const m = manualAttrs.get(c.baseName);
    return {
      ...clean,
      classType: m?.classType ?? c.classType,
      ...(m?.categorySource === 'manual'
        ? { category: m.category, categorySource: m.categorySource }
        : {}),
      ...(m?.fixedFiveDays !== undefined
        ? { fixedFiveDays: m.fixedFiveDays }
        : {}),
    };
  });
}

/** 兩份「班名 → 手動屬性」是否逐欄不同（dirty 的一部分）。 */
function mapsDiffer(
  a: Map<string, ClassAttributesView>,
  b: Map<string, ClassAttributesView>
): boolean {
  if (a.size !== b.size) return true;
  for (const [k, av] of a) {
    const bv = b.get(k);
    if (!bv) return true;
    if (
      av.classType !== bv.classType ||
      av.category !== bv.category ||
      av.categorySource !== bv.categorySource ||
      av.fixedFiveDays !== bv.fixedFiveDays
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 重新取得報告的單次嘗試與重試遞迴（模組層函式，不在 component scope，因此可安全地自我遞迴）。
 *
 * 序列守衛 `seqRef` 與 calculate 的 requestKey guard 同一目的：晚到的舊回應不得覆蓋較新的結果。
 * `delaysMs[attempt]` 存在即代表還有重試間隔可等待；間隔用完則交給使用者（`onGiveUp`）。
 *
 * 逾時器登錄在 `timers`（元件持有）：卸載時 cleanup 逐一 clearTimeout 並作廢序列（seq++），
 * 因此卸載後既不會再發 GET、也不會 setState（review N2）。
 */
async function fetchReportWithRetry(params: {
  seq: number;
  attempt: number;
  url: string;
  delaysMs: number[];
  seqRef: { current: number };
  timers: Set<ReturnType<typeof setTimeout>>;
  onSuccess: (report: ClassNameMatchReport) => void;
  onRecovering: () => void;
  /** 自動重試用盡後的階段：使用者按過［重新載入］→ 只剩［重新整理頁面］；否則提供［重新載入］。 */
  onGiveUp: (manualRetry: boolean) => void;
  /** 本序列是否由使用者的［重新載入］按鈕啟動（決定放棄後的按鈕階段） */
  manualRetry?: boolean;
}): Promise<void> {
  const { seq, attempt, url, delaysMs, seqRef, timers, onSuccess, onRecovering, onGiveUp, manualRetry = false } = params;
  try {
    const response = await fetch(url);
    if (seq !== seqRef.current) return;
    if (!response.ok) throw new Error('REPORT_REFRESH_FAILED');
    const updated = (await response.json()) as ClassNameMatchReport;
    if (seq !== seqRef.current) return;
    onSuccess(updated);
  } catch {
    if (seq !== seqRef.current) return;
    const delay = delaysMs[attempt];
    if (delay !== undefined) {
      onRecovering();
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (seq !== seqRef.current) return;
        void fetchReportWithRetry({ ...params, attempt: attempt + 1 });
      }, delay);
      timers.add(timer);
      return;
    }
    onGiveUp(manualRetry);
  }
}

export default function SettingsEditor({
  importId,
  currentRevision,
  initialDraft,
  unmatched = [],
  classNameReport = null,
  reportImportId = null,
  matchedCount = 0,
  candidates: initialCandidates = [],
  lastAppliedRevision,
  lastAppliedAt,
  hasActiveImport = false,
  initialTab = 'schedule',
  focusClass = null,
  currentRuleSetVersion = null,
  reportRefreshRetryDelaysMs = REPORT_REFRESH_RETRY_DELAYS_MS,
}: SettingsEditorProps) {
  const [activeTab, setActiveTab] = useState<'schedule' | 'mapping'>(initialTab);
  const [draft, setDraft] = useState<SettingsDraft>(initialDraft);

  // 初始化平鋪排課時段列（對齊 S 表 89 筆）
  const initialRows = useMemo(() => {
    const fromClasses = classesToGridRows(initialDraft.classes);
    if (fromClasses.length > 0) return fromClasses;
    return buildSeedGridRows();
  }, [initialDraft]);

  const [rows, setRows] = useState<ScheduleGridRow[]>(initialRows);

  /**
   * 手動指定的班級屬性（類別／固定 5 天）以「班名 → 四個欄位」存放。
   * 未列在此 map 的班＝使用者尚未指定＝`unset`（**不再依班名推導**，#157 Ruling 1）；
   * 手動值在整班改名時隨班帶走，未指定者改名後仍是未指定。
   */
  const [manualAttrs, setManualAttrs] = useState<Map<string, ClassAttributesView>>(() => {
    const map = new Map<string, ClassAttributesView>();
    for (const c of initialDraft.classes) {
      if (c.classType !== undefined || c.categorySource === 'manual' || c.fixedFiveDays !== undefined) {
        map.set(c.baseName, resolveClassAttributes(c.baseName, c));
      }
    }
    return map;
  });

  // D31: 基準狀態與未儲存 (dirty) 追蹤
  const [baseline, setBaseline] = useState<SettingsBaseline>(() => ({
    rows: initialRows,
    aliases: initialDraft.aliases,
  }));
  const [baselineManualAttrs, setBaselineManualAttrs] = useState<Map<string, ClassAttributesView>>(() => {
    const map = new Map<string, ClassAttributesView>();
    for (const c of initialDraft.classes) {
      if (c.classType !== undefined || c.categorySource === 'manual' || c.fixedFiveDays !== undefined) {
        map.set(c.baseName, resolveClassAttributes(c.baseName, c));
      }
    }
    return map;
  });

  // 即時計算狀態
  const [calculateResult, setCalculateResult] = useState<CalculatePreviewResponse | null>(null);
  // 產生 calculateResult 時所依據的列：列之後被改動即代表該列舊結果失效（ScheduleGrid 顯示「—」，09 §3.1）
  const [calculateInputRows, setCalculateInputRows] = useState<ScheduleGridRow[] | null>(null);
  // 最近一次計算失敗的說明：失敗時不留舊結果，也不顯示成「沒有重疊」
  const [calculateError, setCalculateError] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const reqSeqRef = useRef(0);
  const latestReqKeyRef = useRef<string>('');

  // D2b 4（Q11）：是否已明確確認要改用新規則（v4）。未確認時一切照現行版本走，既有 v2 DB 不動。
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false);
  // D2d r3／F-2：`currentRuleSetVersion` 是 server-render prop，session 內不更新，
  // 套用成功後 `canUpgrade` 仍為 true → banner 仍在、isDirty 仍 true、離頁仍被攔截。
  // 改用**本地 state 追蹤「目前生效的版本」**（初始取 server prop）；套用成功後設為
  // **apply 記錄的** `targetRuleSetVersion`——apply 的結果才是權威，不主動猜目標版本。
  // 缺值時保守不變（`?? prev`），不製造未知狀態。
  const [appliedRuleSetVersion, setAppliedRuleSetVersion] = useState<string | null>(currentRuleSetVersion);
  const canUpgrade =
    appliedRuleSetVersion !== null &&
    isFormalRuleSetVersion(appliedRuleSetVersion) &&
    appliedRuleSetVersion !== TARGET_FORMAL_RULE_SET_VERSION;
  const isUpgrading = canUpgrade && upgradeConfirmed;

  // 儲存確認視窗狀態
  const [isImpactDialogOpen, setIsImpactDialogOpen] = useState(false);
  const [preview, setPreview] = useState<SettingsPreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [dialogError, setDialogError] = useState<UserFacingError | null>(null);

  // F3：班名比對報告 client state，儲存成功後即時刷新最新 persisted 報告，避免畫面停留於舊資料
  const [persistedReportOverride, setPersistedReportOverride] = useState<ClassNameMatchReport | null>(null);
  const [prevReportProp, setPrevReportProp] = useState<ClassNameMatchReport | null>(classNameReport);
  // 重新取得報告失敗時的復原階段：retrying（自動重試中，候選表鎖定且不顯示錯誤畫面）／reload／reloadPage
  const [reportRecovery, setReportRecovery] = useState<ReportRecoveryStage | null>(null);
  if (prevReportProp !== classNameReport) {
    setPrevReportProp(classNameReport);
    setPersistedReportOverride(null);
    setReportRecovery(null);
  }
  const report = persistedReportOverride ?? classNameReport;
  const reportRefreshSeq = useRef(0);
  /** 重試計時器集合：卸載時統一清除（見下方 cleanup） */
  const reportRetryTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  /** 候選表是否鎖定：報告重新取得進行中或失敗未恢復時，候選不得依過期報告操作 */
  const reportStaleError = reportRecovery === null ? null : REPORT_REFRESH_FAILED_MESSAGE;

  /**
   * N09／R3-F02（issue #55；UX70）：待確認候選清單與班名比對報告（report.rosterOnly）同步。
   *
   * `report` 本身即「**最後一次成功取得**的報告」：重新取得失敗時
   * `setPersistedReportOverride` 不會被呼叫，故 `persistedReportOverride` 仍持有
   * 前一次成功值，`report` 就是 last-known。因此候選一律由 `report.rosterOnly` 重建，
   * 同時滿足兩種 stale 情境：
   *   - 已成功刷新過（`report` 為 last-known）→ 候選維持最後已知，不回退頁面初始值；
   *   - 從未成功刷新過（`report` 為 SSR `classNameReport`）→ 候選即該頁最後已知（SSR 初值）。
   * 只有 `rosterOnly` 為 null（快照不可用）時才回退 `initialCandidates`（空陣列）。
   *
   * 排序、去重學生數、Token 筆數與 D32-C 理由字串由既有純函式 `buildDynamicCandidates`
   * 單一產生：不在此重寫 reason 常數、不直接 typecast report。
   */
  const candidates = useMemo<DynamicCandidate[]>(() => {
    if (!report?.rosterOnly) return initialCandidates;
    const unmatched = report.rosterOnly.map((r) => r.baseName);
    const counts: CandidateCounts = new Map(
      report.rosterOnly.map((r) => [r.baseName, { studentCount: r.students, tokenCount: r.tokens }])
    );
    return buildDynamicCandidates(unmatched, counts);
  }, [report, initialCandidates]);

  // 儲存成功後就地更新版本與儲存時間（不必重新整理）：下一次確認變更要帶最新版本，狀態列顯示最新儲存時間
  const [revision, setRevision] = useState(currentRevision);
  const [savedAt, setSavedAt] = useState<string | null>(lastAppliedAt ?? null);

  // Toast 通知
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * 啟動一次報告刷新序列（UX46；operator 裁決 d-20261002162913018695-69）。
   *
   * - 失敗自動重試 2 次（約 1s、3s，由 `reportRefreshRetryDelaysMs` 注入）；皆失敗才請使用者按一顆
   *   復原按鈕。重試中不顯示任何錯誤畫面，但候選表鎖定：報告仍是過期值，允許操作等於依過期結果
   *   確認班名。
   * - `reportRefreshSeq` 是唯一的序列權威：每次 apply／［重新載入］都遞增，舊序列的回應與逾時器因此失效，
   *   晚到的舊回應不得覆蓋較新的結果（與 calculate 的 requestKey guard 同一目的）。
   * - ［重新載入］只重新 GET 報告；［重新整理頁面］才整頁 reload。不自動 reload、不跳確認視窗。
   */
  const startReportRefresh = useCallback((manualRetry = false) => {
    if (!reportImportId) return;
    const seq = ++reportRefreshSeq.current;
    // 從序列啟動起候選就是過期的（報告仍是儲存前的值），故立刻鎖定；
    // 成功才解鎖，失敗則依階段顯示一顆復原按鈕（operator 裁決 d-…-69）。
    setReportRecovery('retrying');
    // fire-and-forget: 序列在元件存續期間自持；逾時器登錄在 reportRetryTimers，
    // 由下方 cleanup 在卸載時清除並作廢序列，故卸載後不再 GET、不 setState（review N2）。
    void fetchReportWithRetry({
      seq,
      attempt: 0,
      url: `/api/v1/settings/class-name-report?importId=${encodeURIComponent(reportImportId)}`,
      // R4-F01（operator 裁決 d-20261004044745983486-3）：［重新載入］＝恰好一次 GET、
      // 不帶自動重試；再失敗即轉［重新整理頁面］。自動重試只發生在「儲存後」那條序列。
      // 傳空 delaysMs 即「沒有重試間隔可等待」，fetchReportWithRetry 會直接走 onGiveUp。
      delaysMs: manualRetry ? [] : reportRefreshRetryDelaysMs,
      seqRef: reportRefreshSeq,
      timers: reportRetryTimers.current,
      manualRetry,
      onSuccess: (updated) => {
        setPersistedReportOverride(updated);
        setReportRecovery(null);
      },
      onRecovering: () => setReportRecovery('retrying'),
      onGiveUp: (manual) => setReportRecovery(manual ? 'reloadPage' : 'reload'),
    });
  }, [reportImportId, reportRefreshRetryDelaysMs]);

  // 卸載清理：作廢進行中的序列（seq++ 使所有遞迴短路）並清除待觸發的重試計時器。
  useEffect(() => {
    const timers = reportRetryTimers.current;
    return () => {
      reportRefreshSeq.current += 1;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const showToast = useCallback((msg: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastMessage(msg);
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 3000);
  }, []);

  // 班級改散警告 (D28)
  const splitWarnings = useMemo(() => {
    return detectSplitClasses(baseline.rows, rows);
  }, [baseline.rows, rows]);


  /**
   * D2b 5（Q9）：以 rowId 追蹤班名變化，分辨整班改名／拆班／同名合併／新班。
   * 整班改名時手動值跟著走（D37：手動後改名不再重偵測）；同名合併且設定不同時阻擋儲存。
   */
  const classLifecycle = useMemo(() => {
    return detectClassLifecycle(baseline.rows, rows);
  }, [baseline.rows, rows]);



  /**
   * 合併衝突的判定必須用各來源班的**有效**屬性（使用者的指定優先，未指定者為 unset），
   * 只拿「指定值」會讓兩班中有一班未指定時被誤判為不衝突。
   */
  const mergeConflicts = useMemo(() => {
    if (classLifecycle.merges.length === 0) return [];
    const effective = new Map<string, ClassAttributesView>();
    for (const c of classLifecycle.merges) {
      for (const source of c.sources) {
        effective.set(source, baselineManualAttrs.get(source) ?? resolveClassAttributes(source));
      }
    }
    return detectMergeConflicts(classLifecycle.merges, effective);
  }, [classLifecycle, baselineManualAttrs]);

  /**
   * 整班改名帶走手動值（D37：手動後改名不再重偵測，所以 manual 必須跟著走）。
   *
   * 直接在「計算出的生命週期」上做純轉換（`manualAttrs` 本身就是 state，因此是純函式，
   * 可安全地放進 useMemo）：每次 rows 變動都從 `manualAttrs` 重算目標名的值，
   * 不依賴任何「已處理過」的紀錄，因此中途插入其他編輯（再次手動指定）也不會漏掉或重複搬移。
   */
  const manualAttrsAfterRename = useMemo(() => {
    const renames = classLifecycle.renames;
    if (renames.length === 0) return manualAttrs;
    const inheritableBaseline = new Map(baselineManualAttrs);
    // D2d C（04 §8 UX72）：baseline 的**班名集合**（含未指定類別的班），
    // 讓 carryAttributesOnRename 能分辨「改名成不存在的新名」（使用者的指定跟著走）與
    // 「併入 baseline 已存在的班 Z」（以 Z 為準，不帶入 X 的指定）。
    const baselineNames = new Set(baseline.rows.map((r) => r.className.trim()).filter(Boolean));
    return carryAttributesOnRename(renames, manualAttrs, inheritableBaseline, baselineNames);
  }, [classLifecycle, manualAttrs, baselineManualAttrs, baseline.rows]);

  // 顯示與寫入都用「改名後」的手動值。
  const effectiveManualAttrs = manualAttrsAfterRename;

  /**
   * 只有「使用者的指定」需要獨立計入 dirty：未指定的類別與固定 5 天沒有值可比較，
   * 班名本身已由 rows／baseline 的逐列比對涵蓋，若把未指定者的值也帶進去，
   * 會讓「沒有任何指定」的空 baseline 與整份班級清單永遠長度不同 → 永遠 dirty。
   */
  const manualAttrSettings = useMemo(
    () =>
      [...effectiveManualAttrs.entries()].map(([className, a]) => toClassAttributeSetting({ ...a, className })),
    [effectiveManualAttrs]
  );

  // D2d E（04 §8 UX61；Q11）：只勾「改用新規則」、不改任何課表設定，也算有未儲存的變更。
  // 否則「確認變更」按鈕（disabled={!isDirty || …}）永遠停用，使用者為了開預覽
  // 不得不先做一次無關的課表修改——升級功能等於不可用。
  // 只在「本次 session 從未升級的 v2 現況」算升級：勾選後取消勾選會回到 false，
  // 不會留下殘留的 dirty（否則離開頁面會出現假的未儲存提示）。
  const upgradeChanged = canUpgrade && upgradeConfirmed;

  const isDirty = useMemo(() => {
    return (
      upgradeChanged ||
      isSettingsDirty(
        { ...baseline, classAttrs: [...baselineManualAttrs.entries()].map(([className, a]) => toClassAttributeSetting({ ...a, className })) },
        rows,
        draft.aliases,
        manualAttrSettings
      ) ||
      mapsDiffer(baselineManualAttrs, effectiveManualAttrs)
    );
  }, [upgradeChanged, baseline, baselineManualAttrs, rows, draft.aliases, manualAttrSettings, effectiveManualAttrs]);

  /**
   * 課表每個班級目前有效的類別／固定 5 天（使用者的指定優先，未指定者為 unset）。
   * 這是 UI 顯示、影響預覽與儲存共用的單一來源。
   */
  const currentAttrs: Map<string, ClassAttributesView> = useMemo(() => {
    const names = new Set<string>();
    for (const r of rows) {
      const n = r.className.trim();
      if (n) names.add(n);
    }
    // 使用者的指定帶過來；其餘為未設定
    const out = new Map<string, ClassAttributesView>();
    for (const n of names) {
      out.set(n, effectiveManualAttrs.get(n) ?? resolveClassAttributes(n));
    }
    return out;
  }, [rows, effectiveManualAttrs]);


  /**
   * 選類別 → 使用者決定（manual）。
   *
   * #157 Ruling 4：選回「（未設定）」等於撤回這個決定 → 該班回到 `unset`。
   * 沒有「恢復自動」這種回退路徑：一旦 auto 來源移除，依班名重新判定就沒有對應物，
   * 留著只會是空殼按鈕。
   *
   * 撤回的結果**記成明確的未設定**（`categorySource: 'unset'`）而不是「刪掉這一筆」：
   * 刪掉會讓整班改名時從 baseline 撈回舊值（seed 草稿帶的是使用者明確指定的類別），
   * 使用者的撤回就被還原了。存檔時 `applyManualAttrsToClasses` 只寫 `categorySource === 'manual'`
   * 的班，因此撤回後該班的草稿不帶 category 欄位（＝未設定，03 §5.2 版本界線規則第 2 點）。
   */
  const handleSelectCategory = (className: string, category: ClassCategory) => {
    setManualAttrs((prev) => {
      const next = new Map(prev);
      const base = currentAttrs.get(className) ?? resolveClassAttributes(className);
      if (category === 'unset') {
        // 撤回指定：記為**明確的未設定**，不是「刪掉這一筆」。
        // 若只是刪除，整班改名時 `carryAttributesOnRename` 會從 baseline 撈回舊值
        // （seed 草稿帶的是使用者明確指定的 math），使用者的撤回就被還原了。
        next.set(className, { ...base, category: 'unset', categorySource: 'unset' });
        return next;
      }
      next.set(className, { ...base, category, categorySource: 'manual' });
      return next;
    });
    setPreview(null);
  };

  const handleToggleFixedFiveDays = (className: string, fixed: boolean) => {
    setManualAttrs((prev) => {
      const next = new Map(prev);
      const base = currentAttrs.get(className) ?? resolveClassAttributes(className);
      next.set(className, { ...base, fixedFiveDays: fixed });
      return next;
    });
    setPreview(null);
  };


  // 當前有效班級名稱集合
  const currentActiveBaseNames = useMemo(() => {
    return new Set(
      rows
        .filter((r) => r.active && r.className.trim() !== '')
        .map((r) => r.className.trim())
    );
  }, [rows]);

  // 候選人填寫之目標映射
  const [candidateTargets, setCandidateTargets] = useState<Record<string, string>>({});

  const handleUpdateCandidateTarget = (raw: string, target: string) => {
    setCandidateTargets((prev) => ({ ...prev, [raw]: target }));
    setPreview(null);
  };

  const handleToggleAlias = (raw: string, target: string) => {
    setDraft((prev) => {
      const exists = prev.aliases.some((a) => a.rawBaseName === raw && a.targetBaseName === target);
      return {
        ...prev,
        aliases: exists
          ? prev.aliases.filter((a) => !(a.rawBaseName === raw && a.targetBaseName === target))
          : [...prev.aliases, { rawBaseName: raw, targetBaseName: target }],
      };
    });
    setPreview(null);
  };

  // 呼叫唯讀計算 API (POST /api/v1/settings/calculate，250ms debounce，帶 requestKey 防晚到覆蓋)
  useEffect(() => {
    const timer = setTimeout(async () => {
      const seq = ++reqSeqRef.current;
      const requestKey = `req-${Date.now()}-${seq}`;
      latestReqKeyRef.current = requestKey;

      // 這次請求所依據的列（closure 快照）：回應成功後與結果一起保存
      const rowsAtRequest = rows;
      const failCalculation = () => {
        // 只有最新請求的失敗才生效；舊請求晚到的失敗不得覆蓋較新的狀態
        if (requestKey !== latestReqKeyRef.current) return;
        setCalculateResult(null);
        setCalculateInputRows(null);
        setCalculateError(CALCULATE_FAILED_MESSAGE);
      };

      setCalculating(true);
      try {
        const calcClasses = applyManualAttrsToClasses(
          gridRowsToCalculateClasses(rows, draft.classes),
          effectiveManualAttrs
        );
        const calcDraft = {
          ...draft,
          classes: calcClasses,
        };

        const res = await fetch('/api/v1/settings/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestKey, draft: calcDraft }),
        });

        if (!res.ok) {
          failCalculation();
          return;
        }

        const data = await res.json();
        // 晚到請求保護 (UX08)：只有當前最新 requestKey 的回應才生效
        if (data.requestKey === latestReqKeyRef.current) {
          setCalculateResult(data);
          setCalculateInputRows(rowsAtRequest);
          setCalculateError(null);
        }
      } catch {
        // 連線中斷或回應無法解析：不中斷 UI，但不留舊數字、也不顯示成「沒有重疊」
        failCalculation();
      } finally {
        if (requestKey === latestReqKeyRef.current) {
          setCalculating(false);
        }
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [rows, draft, effectiveManualAttrs]);

  // 更新時段列
  const handleUpdateRow = (rowId: string, updates: Partial<ScheduleGridRow>) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId) return r;
        const updated = { ...r, ...updates };
        if (updates.startTime !== undefined) {
          updated.startMinutes = timeStringToMinutes(updates.startTime);
        }
        if (updates.endTime !== undefined) {
          updated.endMinutes = timeStringToMinutes(updates.endTime);
        }
        return updated;
      })
    );
    setPreview(null);
  };

  // 刪除時段列
  const handleDeleteRow = (rowId: string) => {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
    setPreview(null);
  };

  // 新增時段列（支援選定課程類型）
  const handleAddRow = (row: Omit<ScheduleGridRow, 'rowId'>, classType?: ClassType) => {
    const startMin = timeStringToMinutes(row.startTime);
    const endMin = timeStringToMinutes(row.endTime);
    const newRow: ScheduleGridRow = {
      ...row,
      rowId: `user-row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      startMinutes: startMin,
      endMinutes: endMin,
    };
    setRows((prev) => [...prev, newRow]);
    if (classType) {
      setManualAttrs((prev) => {
        const next = new Map(prev);
        const base = resolveClassAttributes(row.className.trim(), { classType });
        next.set(row.className.trim(), { ...base, classType });
        return next;
      });
    }
    setPreview(null);
  };

  // ---------------------------------------------------------------------------
  // #81：課表 Excel 全量匯出／匯入（單純一鍵，無欄位挑選對話框）
  // ---------------------------------------------------------------------------

  const [scheduleTransferBusy, setScheduleTransferBusy] = useState(false);
  const [scheduleImportError, setScheduleImportError] = useState<string | null>(null);

  /**
   * 匯出：把**目前草稿**（含尚未儲存的編輯）整份送給 server 產生 .xlsx。
   * 匯出的是有效屬性（使用者的指定優先、未指定者為「（未設定）」），所以匯出檔本身就是一份完整的課表備份。
   */
  const handleExportExcel = useCallback(async () => {
    setScheduleTransferBusy(true);
    setScheduleImportError(null);
    try {
      const payload = JSON.stringify({
        rows,
        classAttrs: [...currentAttrs.entries()].map(([className, a]) => ({
          className,
          classType: a.classType,
          category: a.category,
          fixedFiveDays: a.fixedFiveDays,
        })),
      });
      const formData = new FormData();
      formData.set('mode', 'export');
      formData.set('payload', payload);

      const res = await fetch('/api/v1/settings/schedule-table', { method: 'POST', body: formData });
      if (!res.ok) {
        setScheduleImportError('匯出失敗，請稍後再試一次。');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = '課表.xlsx';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showToast('已匯出完整課表 Excel');
    } catch {
      setScheduleImportError('匯出失敗，請稍後再試一次。');
    } finally {
      setScheduleTransferBusy(false);
    }
  }, [rows, currentAttrs, showToast]);

  /**
   * 匯入：整批取代目前草稿。
   * 解析與格式驗證在 server 端（`schedule-table-io`），任何一列不合法即整批拒絕，
   * 回傳的 error 直接顯示、**不動 rows** —— 因此不會出現「套用了一半」的破碎狀態。
   * 匯入的屬性一律視為使用者明確指定（manual）：匯入是顯式動作，不該被任何自動判定改回去。
   */
  const handleImportExcel = useCallback(async (file: File) => {
    setScheduleTransferBusy(true);
    setScheduleImportError(null);
    try {
      const formData = new FormData();
      formData.set('mode', 'import');
      formData.set('file', file);

      const res = await fetch('/api/v1/settings/schedule-table', { method: 'POST', body: formData });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setScheduleImportError(json?.error ?? '匯入失敗，請確認檔案是本工具匯出的課表 Excel。');
        return;
      }

      const importedRows = json?.rows as ScheduleGridRow[] | undefined;
      if (!Array.isArray(importedRows) || importedRows.length === 0) {
        setScheduleImportError('這個 Excel 檔案裡沒有任何課表資料列。');
        return;
      }

      setRows(importedRows);
      const nextAttrs = new Map<string, ClassAttributesView>();
      for (const a of json?.classAttrs as Array<{
        className: string;
        classType?: ClassType;
        category: ClassCategory;
        fixedFiveDays: boolean;
      }>) {
        nextAttrs.set(a.className, {
          classType: a.classType ?? resolveClassAttributes(a.className).classType,
          category: a.category,
          categorySource: 'manual',
          fixedFiveDays: a.fixedFiveDays,
        });
      }
      setManualAttrs(nextAttrs);
      // 匯入是整份取代，不是「沿用原本的手動值」。
      setPreview(null);
      showToast(`已匯入課表（${importedRows.length} 個時段），請確認後儲存`);
    } catch {
      setScheduleImportError('匯入失敗，請確認檔案是本工具匯出的課表 Excel。');
    } finally {
      setScheduleTransferBusy(false);
    }
  }, [showToast]);

  // 還原到 baseline（取消修改與離頁時「捨棄修改」共用）
  const resetDraft = () => {
    setRows(baseline.rows);
    setDraft((prev) => ({ ...prev, aliases: baseline.aliases }));
    setManualAttrs(new Map(baselineManualAttrs));
    setPreview(null);
    // D2d r3／F-1：升級勾選也必須一起清除。漏了它 → `upgradeChanged` 恆 true →
    // `isDirty` 恆 true，使用者按了取消修改畫面卻仍標示「有未儲存的變更」，
    // 而且這個 state 無法再從畫面清除（「取消修改」是唯一會呼叫 resetDraft 的入口，
    // 勾選框又已被 isDirty 綁著而按不下去）。
    setUpgradeConfirmed(false);
  };

  // 取消修改
  const handleDiscard = () => {
    resetDraft();
    showToast('已取消未儲存的變更');
  };

  // 離頁提醒（09 §3.2；D38 F07）：有未儲存修改時，站內離開（側欄、品牌連結、瀏覽器 Back）先確認；儲存成功後不再提醒
  const leaveGuard = useUnsavedChangesGuard(isDirty, resetDraft);

  // 開啟確認視窗並載入影響預覽
  const handleOpenReview = async () => {
    setIsImpactDialogOpen(true);
    setPreviewLoading(true);
    setDialogError(null);
    setPreview(null);

    try {
      const currentClasses = applyManualAttrsToClasses(
        gridRowsToClasses(rows, draft.classes) as Array<ClassSetting & Record<string, unknown>>,
        effectiveManualAttrs
      ) as ClassSetting[];
      const updatedDraft: SettingsDraft = {
        ...draft,
        classes: currentClasses,
      };

      // 依 server 決定的模式：無 active 名單時不傳送 importId（走 settings_only）
      const payload: Record<string, unknown> = {
        draft: updatedDraft,
        expectedRevision: revision,
      };
      // 升級流程（Q11）：只有使用者明確勾選「改用新規則」才帶目標版本；否則沿用現行版本（v2 DB 不動）
      if (isUpgrading) payload.targetRuleSetVersion = TARGET_FORMAL_RULE_SET_VERSION;
      if (hasActiveImport && importId) {
        payload.importId = importId;
      }

      const res = await fetch('/api/v1/settings/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setDialogError(describeSettingsPreviewError(readRawFailure(res.status, json)));
        return;
      }
      setPreview(json);
    } catch (e) {
      // 連線中斷或回應無法解析：白話說明，例外訊息只放詳細資訊
      setDialogError(describeSettingsPreviewError(failureFromException(e)));
    } finally {
      setPreviewLoading(false);
    }
  };

  // 套用並儲存設定
  const handleApply = async () => {
    if (!preview) return;
    setApplying(true);
    setDialogError(null);

    try {
      const idempotencyKey = `apply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await fetch('/api/v1/settings/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewId: preview.previewId,
          expectedRevision: revision,
          idempotencyKey,
        }),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setDialogError(describeSettingsApplyError(readRawFailure(res.status, json)));
        return;
      }

      // 套用成功：更新 baseline，清除 dirty 狀態（此後離頁不再提醒）；就地更新版本與儲存時間
      setBaseline({
        rows: [...rows],
        aliases: [...draft.aliases],
      });
      // 儲存成功後，已套用的手動值成為新的 baseline（此後離開與取消修改都回到這組值）
      const savedManualAttrs = new Map(
        [...effectiveManualAttrs].filter(
          ([className, a]) =>
            a.categorySource === 'manual' ||
            a.fixedFiveDays ||
            a.classType !== resolveClassAttributes(className).classType
        )
      );
      setManualAttrs(savedManualAttrs);
      setBaselineManualAttrs(savedManualAttrs);
      if (typeof json?.revision === 'number') setRevision(json.revision);
      if (typeof json?.appliedAt === 'string') setSavedAt(json.appliedAt);
      setIsImpactDialogOpen(false);
      setPreview(null);
      // D2d r3／F-2：套用成功後把「目前生效的版本」更新為 **apply 記錄的** target 版
      // （`previewSettingsChange` 回傳的 `targetRuleSetVersion` 就是寫進 preview 列、
      //   apply 唯一採用的值，見 `apply-settings.ts` `resolveRuleSetForApply`）。
      // 這讓 `canUpgrade` 轉 false → banner 消失、isDirty 歸零、離頁守衛不再攔截。
      // 刻意**不**加 `router.refresh()`／`revalidatePath()`：那會連帶重新取得 rows／
      // baseline／manualAttrs，把上面「就地更新 baseline」這條既有路徑整段作廢並擴大回歸面；
      // 版本判斷只需要這一項。
      const appliedVersion = preview?.targetRuleSetVersion ?? null;
      if (appliedVersion) setAppliedRuleSetVersion(appliedVersion);
      setUpgradeConfirmed(false);
      showToast(preview.mode === 'settings_only' ? '課表已成功儲存' : '課表已套用並完成重算');

      // F3：儲存成功後，就地刷新班名比對報告（維持同頁即時更新，不需整頁 reload）。
      // 刷新的對象是畫面正在檢視的名單（reportImportId；?import= 可指定尚未啟用的另一批），不是編輯器儲存所依據的現行名單。
      // 沒有檢視中的名單（尚無任何名單）就沒有報告可刷新。
      startReportRefresh();
    } catch (e) {
      setDialogError(describeSettingsApplyError(failureFromException(e)));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="settings-workflow-root">
      {/* 頁面標題與快速導引 */}
      <header className="page-header" style={{ marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '0 0 6px' }}>課表設定</h1>
          <p className="note" style={{ margin: 0 }}>
            設定各班上課時段與老師，即時預覽與安親、課輔窗口的重疊與扣除天數。
          </p>
        </div>
      </header>

      {/* 頁籤切換（09 §6：鍵盤可操作） */}
      <TabList
        label="課表設定頁籤"
        idPrefix="settings"
        selected={activeTab}
        onSelect={(k) => setActiveTab(k as 'schedule' | 'mapping')}
        tabs={[
          { key: 'schedule', label: '課表' },
          {
            key: 'mapping',
            label: (
              <>
                班名對應 {candidates.length > 0 && <span className="pill warn">{candidates.length}</span>}
              </>
            ),
          },
        ]}
      />

      {/* 頁籤內容一：課表平鋪排課主畫面 */}
      {activeTab === 'schedule' && (
        <section aria-label="排課時段設定" {...tabPanelProps('settings', 'schedule')}>
          {/* 唯讀照顧窗口摘要 */}
          <WindowSummary />

          {/* D2b 4（Q11）：首次改用新規則的明確確認——不靜默切換 */}
          {canUpgrade && (
            <div
              className={isUpgrading ? 'notice-inline' : 'notice-warn'}
              role="status"
              data-upgrade-banner=""
              style={{ marginBottom: '16px' }}
            >
              <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={upgradeConfirmed}
                  data-upgrade-confirm=""
                  aria-label="改用新規則（erp-tag-v4）"
                  onChange={(e) => {
                    setUpgradeConfirmed(e.target.checked);
                    setPreview(null);
                  }}
                />
                <span>
                  <strong>改用新規則（v4）</strong>：勾選後，本次確認變更會改用新的計算規則重新計算全部學生
                  （折扣類別、天數下限與重複報名的判定方式不同），並產生新的核對結果。
                  <br />
                  未勾選時維持現行規則，既有結果不受影響；已產生的舊結果不會被改寫。
                </span>
              </label>
            </div>
          )}

          {/* #80：折扣類別與固定 5 天已併入下方「89 筆平鋪時段表格」，同一列一次完成（不再有獨立的屬性卡片） */}
          {/* 89 筆平鋪時段表格（含班級屬性欄、Excel 匯出入工具列） */}
          <ScheduleGrid
            rows={rows}
            onUpdateRow={handleUpdateRow}
            onDeleteRow={handleDeleteRow}
            onAddRow={handleAddRow}
            calculating={calculating}
            calculateResult={calculateResult}
            calculateInputRows={calculateInputRows}
            calculateError={calculateError}
            focusClass={focusClass}
            classAttributes={currentAttrs}
            onSelectCategory={handleSelectCategory}
            onToggleFixedFiveDays={handleToggleFixedFiveDays}
            onExportExcel={handleExportExcel}
            onImportExcel={handleImportExcel}
            importError={scheduleImportError}
            transferBusy={scheduleTransferBusy}
          />
        </section>
      )}

      {/* 頁籤內容二：班名對應 */}
      {activeTab === 'mapping' && (
        <section aria-label="班名對應設定" {...tabPanelProps('settings', 'mapping')}>
          <MappingPanel
            hasStudents={Boolean(importId || hasActiveImport)}
            candidates={candidates}
            aliases={draft.aliases}
            currentActiveBaseNames={currentActiveBaseNames}
            candidateTargets={candidateTargets}
            onUpdateCandidateTarget={handleUpdateCandidateTarget}
            onToggleAlias={handleToggleAlias}
            classNameReport={report}
            classNameReportStaleMessage={reportStaleError}
            reportRecoveryStage={reportRecovery === 'retrying' ? 'retrying' : reportRecovery}
            // 重試中鎖定候選表：真正的鎖定（依過期報告不可確認班名）。
            // 課表頁的時段編輯不在此鎖定範圍——那是使用者自己的草稿，保存後會以新報告解鎖。
            candidatesLocked={reportRecovery !== null}
            onRetryReport={() => startReportRefresh(true)}
            onReloadPage={() => window.location.reload()}
          />
        </section>
      )}

      {/* D2b 5（Q9）：同名合併且設定不同 → 要求先選擇，不可靜默取其一 */}
      {mergeConflicts.length > 0 && (
        <div className="alert alert-danger" role="alert" data-merge-conflict="" style={{ marginBottom: '12px' }}>
          <strong>無法儲存：班級合併設定衝突</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {mergeConflicts.map((c) => (
              <li key={c.mergedName}>
                「{c.mergedName}」由 {c.sources.join('、')} 合併而來，各班的課程類型、類別與固定 5 天設定不同（
                {c.sourceAttributes
                  .map(
                    (a) =>
                      `${a.classType === 'care' ? '安親課輔班' : '非安親課輔班'}／${CATEGORY_LABELS[a.category]}／${a.fixedFiveDays ? '固定 5 天' : '不固定'}`
                  )
                  .join('、')}
                ）。請先選擇要保留的設定，或改回不同的班名。
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 固定底部操作列 */}
      <div className="savebar">
        <div className="savebar-status">
          {isDirty ? (
            <span className="save-status-dirty">
              <span className="dot dot-dirty" aria-hidden="true" />
              有未儲存的變更 · 請確認變更後儲存
            </span>
          ) : (
            <span className="save-status-clean">
              <span className="dot dot-clean" aria-hidden="true" />
              課表已為最新儲存狀態
              {savedAt && ` · ${formatDateTime(savedAt)}`}
            </span>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={!isDirty}
            onClick={handleDiscard}
          >
            取消修改
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!isDirty || calculating || mergeConflicts.length > 0}
            onClick={handleOpenReview}
          >
            確認變更
          </button>
        </div>
      </div>

      {/* 儲存確認視窗 (Impact Dialog) */}
      <ImpactDialog
        isOpen={isImpactDialogOpen}
        mode={hasActiveImport ? 'with_students' : 'settings_only'}
        preview={preview}
        splitWarnings={splitWarnings}
        onClose={() => {
          setIsImpactDialogOpen(false);
          setPreview(null);
          setDialogError(null);
        }}
        onApply={handleApply}
        applying={applying}
        loading={previewLoading}
        error={dialogError}
      />

      {/* 離頁確認（未儲存的課表修改） */}
      <LeaveConfirmDialog
        open={leaveGuard.pending !== null}
        onKeepEditing={leaveGuard.keepEditing}
        onDiscard={leaveGuard.discardAndLeave}
      />

      {/* Toast 訊息 */}
      {toastMessage && (
        <div id="toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </div>
  );
}

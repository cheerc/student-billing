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
} from '@/contracts/settings';
import { DynamicCandidate, buildDynamicCandidates, type CandidateCounts } from '@/domain/schedules/seed-manifest';
import { CalculatePreviewResponse } from '@/application/schedule-preview';
import type { ClassNameMatchReport } from '@/application/class-name-match-report';
import { WindowSummary } from '@/components/settings/window-summary';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { ImpactDialog, SettingsPreviewData } from '@/components/settings/impact-dialog';
import { LeaveConfirmDialog } from '@/components/settings/leave-confirm-dialog';
import { MappingPanel } from '@/components/settings/mapping-panel';
import { ClassAttributesPanel } from '@/components/settings/class-attributes-panel';
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
  /**
   * D2b 4（Q11）：現行 run 的規則版本。v2 時顯示「改用新規則」升級動作（明確確認，不靜默切換）。
   * null＝尚無啟用的 run（空 DB，該 run 建立時即為目標版本 v3，無需升級動作）。
   */
  currentRuleSetVersion?: string | null;
}

/** 計算失敗時的說明（不外露狀態碼或工程字）；ScheduleGrid 會補上「不代表沒有衝堂」。 */
const CALCULATE_FAILED_MESSAGE = '無法計算重疊與扣除天數，請稍後再試。';

/** 有效屬性 → isSettingsDirty 的 ClassAttributeSetting 形狀（className 為 key）。 */
function toClassAttributeSetting(a: ClassAttributesView & { className?: string }): ClassAttributeSetting {
  return {
    className: a.className ?? '',
    category: a.category,
    categorySource: a.categorySource,
    fixedFiveDays: a.fixedFiveDays,
    fixedSource: a.fixedSource,
  };
}

/**
 * 把手動覆寫寫進 draft 的班級（存檔／預覽都用它）。
 * 只寫 manual 的欄位：未手動者不寫四個欄位，讀取時即自動偵測（改班名會重新偵測）。
 */
function applyManualAttrsToClasses<T extends { baseName: string }>(
  classes: Array<T & Record<string, unknown>>,
  manualAttrs: Map<string, ClassAttributesView>
): Array<T & Record<string, unknown>> {
  return classes.map((c) => {
    const clean = { ...c };
    delete clean.category;
    delete clean.categorySource;
    delete clean.fixedFiveDays;
    delete clean.fixedSource;
    const m = manualAttrs.get(c.baseName);
    return {
      ...clean,
      ...(m?.categorySource === 'manual'
        ? { category: m.category, categorySource: m.categorySource }
        : {}),
      ...(m?.fixedSource === 'manual'
        ? { fixedFiveDays: m.fixedFiveDays, fixedSource: m.fixedSource }
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
      av.category !== bv.category ||
      av.categorySource !== bv.categorySource ||
      av.fixedFiveDays !== bv.fixedFiveDays ||
      av.fixedSource !== bv.fixedSource
    ) {
      return true;
    }
  }
  return false;
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
   * D2b 1／2：手動覆寫的班級屬性（類別／固定 5 天）以「班名 → 四個欄位」存放。
   * 未列在此 map 的班＝未手動＝依班名自動偵測（缺欄位即 auto，03 §5.2 版本界線規則第 2 點），
   * 因此改班名時未手動者會即時重新偵測，手動者則不變（D37 1a）。
   */
  const [manualAttrs, setManualAttrs] = useState<Map<string, ClassAttributesView>>(() => {
    const map = new Map<string, ClassAttributesView>();
    for (const c of initialDraft.classes) {
      if (c.categorySource === 'manual' || c.fixedSource === 'manual') {
        map.set(c.baseName, resolveClassAttributes(c.baseName, c));
      }
    }
    return map;
  });

  // 明確恢復自動的班不再繼承 rename baseline；後續手動編輯仍以當前班的設定為準。
  const [restoredAutoNames, setRestoredAutoNames] = useState<Set<string>>(() => new Set());

  // D31: 基準狀態與未儲存 (dirty) 追蹤
  const [baseline, setBaseline] = useState<SettingsBaseline>(() => ({
    rows: initialRows,
    aliases: initialDraft.aliases,
  }));
  const [baselineManualAttrs, setBaselineManualAttrs] = useState<Map<string, ClassAttributesView>>(() => {
    const map = new Map<string, ClassAttributesView>();
    for (const c of initialDraft.classes) {
      if (c.categorySource === 'manual' || c.fixedSource === 'manual') {
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

  // D2b 4（Q11）：是否已明確確認要改用新規則（v3）。未確認時一切照現行版本走，既有 v2 DB 不動。
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false);
  // D2d r3／F-2：`currentRuleSetVersion` 是 server-render prop，session 內不更新，
  // 套用成功後 `canUpgrade` 仍為 true → banner 仍在、isDirty 仍 true、離頁仍被攔截。
  // 改用**本地 state 追蹤「目前生效的版本」**（初始取 server prop）；套用成功後設為
  // **apply 記錄的** `targetRuleSetVersion`——apply 的結果才是權威，不主動猜 v3。
  // 缺值時保守不變（`?? prev`），不製造未知狀態。
  const [appliedRuleSetVersion, setAppliedRuleSetVersion] = useState<string | null>(currentRuleSetVersion);
  const canUpgrade = appliedRuleSetVersion === 'erp-tag-v2';
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
  // 重新取得報告失敗時的說明：有值時不顯示（已過期的）報告數字，只顯示無法取得的標示
  const [reportStaleError, setReportStaleError] = useState<string | null>(null);
  if (prevReportProp !== classNameReport) {
    setPrevReportProp(classNameReport);
    setPersistedReportOverride(null);
    setReportStaleError(null);
  }
  const report = persistedReportOverride ?? classNameReport;
  const reportRefreshSeq = useRef(0);

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
   * 合併衝突的判定必須用各來源班的**有效**屬性（手動值優先，未手動者依 baseline 班名自動偵測），
   * 只拿「手動值」會讓兩班中有一班未手動時被誤判為不衝突。
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
    for (const name of restoredAutoNames) inheritableBaseline.delete(name);
    // D2d C（04 §8 UX72）：baseline 的**班名集合**（含未手動、靠自動偵測的班），
    // 讓 carryAttributesOnRename 能分辨「改名成不存在的新名」（手動值跟著走）與
    // 「併入 baseline 已存在的班 Z」（以 Z 為準，不帶入 X 的手動值）。
    const baselineNames = new Set(baseline.rows.map((r) => r.className.trim()).filter(Boolean));
    return carryAttributesOnRename(renames, manualAttrs, inheritableBaseline, baselineNames);
  }, [classLifecycle, manualAttrs, baselineManualAttrs, restoredAutoNames, baseline.rows]);

  // 顯示與寫入都用「改名後」的手動值。
  const effectiveManualAttrs = manualAttrsAfterRename;

  /**
   * 只有「手動覆寫」需要獨立計入 dirty：未手動的類別與固定 5 天是由班名推導，
   * 班名本身已由 rows／baseline 的逐列比對涵蓋，若把自動值也帶進去，
   * 會讓「沒有任何覆寫」的空 baseline 與整份班級清單永遠長度不同 → 永遠 dirty。
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
   * 課表每個班級目前有效的類別／固定 5 天（手動值優先，未手動者依**目前**班名自動偵測）。
   * 這是 UI 顯示、影響預覽與儲存共用的單一來源。
   */
  const currentAttrs: Map<string, ClassAttributesView> = useMemo(() => {
    const names = new Set<string>();
    for (const r of rows) {
      const n = r.className.trim();
      if (n) names.add(n);
    }
    // 手動值帶過來；其餘依目前班名自動偵測
    const out = new Map<string, ClassAttributesView>();
    for (const n of names) {
      out.set(n, effectiveManualAttrs.get(n) ?? resolveClassAttributes(n));
    }
    return out;
  }, [rows, effectiveManualAttrs]);


  // D2b 2：手動選類別 → manual；恢復自動 → 依目前班名重新偵測並標回 auto
  const handleSelectCategory = (className: string, category: ClassCategory) => {
    setManualAttrs((prev) => {
      const next = new Map(prev);
      const base = currentAttrs.get(className) ?? resolveClassAttributes(className);
      next.set(className, { ...base, category, categorySource: 'manual' });
      return next;
    });
    setPreview(null);
  };

  const handleToggleFixedFiveDays = (className: string, fixed: boolean) => {
    setManualAttrs((prev) => {
      const next = new Map(prev);
      const base = currentAttrs.get(className) ?? resolveClassAttributes(className);
      next.set(className, { ...base, fixedFiveDays: fixed, fixedSource: 'manual' });
      return next;
    });
    setPreview(null);
  };

  const handleRestoreAuto = (className: string) => {
    const names = [className, ...classLifecycle.renames
      .filter((rename) => rename.to === className)
      .map((rename) => rename.from)];
    setRestoredAutoNames((prev) => new Set([...prev, ...names]));
    setManualAttrs((prev) => {
      const next = new Map(prev);
      for (const name of names) next.delete(name);
      return next;
    });
    setPreview(null);
  };

  /** 類別面板只列使用者此刻看得見的班（跟著課表搜尋／星期篩選一致）。 */
  const visibleClassNames = useMemo(() => {
    return [...new Set(rows.map((r) => r.className.trim()).filter(Boolean))];
  }, [rows]);

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

  // 新增時段列
  const handleAddRow = (row: Omit<ScheduleGridRow, 'rowId'>) => {
    const startMin = timeStringToMinutes(row.startTime);
    const endMin = timeStringToMinutes(row.endTime);
    const newRow: ScheduleGridRow = {
      ...row,
      rowId: `user-row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      startMinutes: startMin,
      endMinutes: endMin,
    };
    setRows((prev) => [...prev, newRow]);
    setPreview(null);
  };

  // 還原到 baseline（取消修改與離頁時「捨棄修改」共用）
  const resetDraft = () => {
    setRows(baseline.rows);
    setDraft((prev) => ({ ...prev, aliases: baseline.aliases }));
    setManualAttrs(new Map(baselineManualAttrs));
    setRestoredAutoNames(new Set());
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
      if (isUpgrading) payload.targetRuleSetVersion = 'erp-tag-v3';
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
        [...effectiveManualAttrs].filter(([, a]) =>
          a.categorySource === 'manual' || a.fixedSource === 'manual'
        )
      );
      setManualAttrs(savedManualAttrs);
      setBaselineManualAttrs(savedManualAttrs);
      setRestoredAutoNames(new Set());
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
      if (reportImportId) {
        const seq = ++reportRefreshSeq.current;
        const REFRESH_FAILED = '課表已儲存，但無法取得最新的班名比對報告，因此暫不顯示比對結果。請重新整理頁面後查看。';
        fetch(`/api/v1/settings/class-name-report?importId=${encodeURIComponent(reportImportId)}`)
          .then(async (r) => {
            if (!r.ok) {
              if (seq === reportRefreshSeq.current) setReportStaleError(REFRESH_FAILED);
              return;
            }
            const updated = (await r.json()) as ClassNameMatchReport;
            if (seq === reportRefreshSeq.current) {
              setPersistedReportOverride(updated);
              setReportStaleError(null);
            }
          })
          .catch(() => {
            if (seq === reportRefreshSeq.current) setReportStaleError(REFRESH_FAILED);
          });
      }
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
                  aria-label="改用新規則（erp-tag-v3）"
                  onChange={(e) => {
                    setUpgradeConfirmed(e.target.checked);
                    setPreview(null);
                  }}
                />
                <span>
                  <strong>改用新規則（v3）</strong>：勾選後，本次確認變更會改用新的計算規則重新計算全部學生
                  （折扣類別、天數下限與重複報名的判定方式不同），並產生新的核對結果。
                  <br />
                  未勾選時維持現行規則，既有結果不受影響；已產生的舊結果不會被改寫。
                </span>
              </label>
            </div>
          )}

          {/* D2b 2（D37 1a）：折扣類別與固定 5 天（自動偵測＋可手動覆寫／恢復自動） */}
          <ClassAttributesPanel
            attributes={currentAttrs}
            visibleClassNames={visibleClassNames}
            onSelectCategory={handleSelectCategory}
            onToggleFixedFiveDays={handleToggleFixedFiveDays}
            onRestoreAuto={handleRestoreAuto}
          />

          {/* 89 筆平鋪時段表格 */}
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
                「{c.mergedName}」由 {c.sources.join('、')} 合併而來，各班的類別與固定 5 天設定不同（
                {c.sourceAttributes
                  .map((a, i) => `${CATEGORY_LABELS[a.category]}／${a.fixedFiveDays ? '固定 5 天' : '不固定'}`)
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

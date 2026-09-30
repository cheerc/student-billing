'use client';

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  SettingsDraft,
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
} from '@/contracts/settings';
import { DynamicCandidate } from '@/domain/schedules/seed-manifest';
import { CalculatePreviewResponse } from '@/application/schedule-preview';
import type { ClassNameMatchReport } from '@/application/class-name-match-report';
import { WindowSummary } from '@/components/settings/window-summary';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { ImpactDialog, SettingsPreviewData } from '@/components/settings/impact-dialog';
import { LeaveConfirmDialog } from '@/components/settings/leave-confirm-dialog';
import { MappingPanel } from '@/components/settings/mapping-panel';
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
  matchedCount?: number;
  candidates?: DynamicCandidate[];
  lastAppliedRevision?: number;
  lastAppliedAt?: string | null;
  hasActiveImport?: boolean;
  /** 網址 tab 參數決定開啟的頁籤（預設課表） */
  initialTab?: 'schedule' | 'mapping';
  /** 「編輯此班課表」帶入的班級（班名）：課表頁定位並列出該班全部時段（F04） */
  focusClass?: string | null;
}

/** 計算失敗時的說明（不外露狀態碼或工程字）；ScheduleGrid 會補上「不代表沒有衝堂」。 */
const CALCULATE_FAILED_MESSAGE = '無法計算重疊與扣除天數，請稍後再試。';

export default function SettingsEditor({
  importId,
  currentRevision,
  initialDraft,
  unmatched = [],
  classNameReport = null,
  matchedCount = 0,
  candidates = [],
  lastAppliedRevision,
  lastAppliedAt,
  hasActiveImport = false,
  initialTab = 'schedule',
  focusClass = null,
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

  // D31: 基準狀態與未儲存 (dirty) 追蹤
  const [baseline, setBaseline] = useState<SettingsBaseline>(() => ({
    rows: initialRows,
    aliases: initialDraft.aliases,
  }));

  const isDirty = useMemo(() => {
    return isSettingsDirty(baseline, rows, draft.aliases);
  }, [baseline, rows, draft.aliases]);

  // 即時計算狀態
  const [calculateResult, setCalculateResult] = useState<CalculatePreviewResponse | null>(null);
  // 產生 calculateResult 時所依據的列：列之後被改動即代表該列舊結果失效（ScheduleGrid 顯示「—」，09 §3.1）
  const [calculateInputRows, setCalculateInputRows] = useState<ScheduleGridRow[] | null>(null);
  // 最近一次計算失敗的說明：失敗時不留舊結果，也不顯示成「沒有重疊」
  const [calculateError, setCalculateError] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const reqSeqRef = useRef(0);
  const latestReqKeyRef = useRef<string>('');

  // 儲存確認視窗狀態
  const [isImpactDialogOpen, setIsImpactDialogOpen] = useState(false);
  const [preview, setPreview] = useState<SettingsPreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [dialogError, setDialogError] = useState<UserFacingError | null>(null);

  // F3：班名比對報告 client state，儲存成功後即時刷新最新 persisted 報告，避免畫面停留於舊資料
  const [persistedReportOverride, setPersistedReportOverride] = useState<ClassNameMatchReport | null>(null);
  const [prevReportProp, setPrevReportProp] = useState<ClassNameMatchReport | null>(classNameReport);
  if (prevReportProp !== classNameReport) {
    setPrevReportProp(classNameReport);
    setPersistedReportOverride(null);
  }
  const report = persistedReportOverride ?? classNameReport;
  const [reportStaleError, setReportStaleError] = useState<string | null>(null);
  const reportRefreshSeq = useRef(0);

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
        const calcClasses = gridRowsToCalculateClasses(rows, draft.classes);
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
  }, [rows, draft]);

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
    setPreview(null);
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
      const currentClasses = gridRowsToClasses(rows, draft.classes);
      const updatedDraft: SettingsDraft = {
        ...draft,
        classes: currentClasses,
      };

      // 依 server 決定的模式：無 active 名單時不傳送 importId（走 settings_only）
      const payload: Record<string, unknown> = {
        draft: updatedDraft,
        expectedRevision: revision,
      };
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
      if (typeof json?.revision === 'number') setRevision(json.revision);
      if (typeof json?.appliedAt === 'string') setSavedAt(json.appliedAt);
      setIsImpactDialogOpen(false);
      setPreview(null);
      showToast(preview.mode === 'settings_only' ? '課表已成功儲存' : '課表已套用並完成重算');

      // F3：儲存成功後，就地刷新班名比對報告（維持同頁即時更新，不需整頁 reload）
      const seq = ++reportRefreshSeq.current;
      const q = importId ? `?importId=${encodeURIComponent(importId)}` : '';
      fetch(`/api/v1/settings/class-name-report${q}`)
        .then(async (r) => {
          if (!r.ok) {
            if (seq === reportRefreshSeq.current) setReportStaleError('無法重新取得最新的班名比對報告');
            return;
          }
          const updated = (await r.json()) as ClassNameMatchReport;
          if (seq === reportRefreshSeq.current) {
            setPersistedReportOverride(updated);
            setReportStaleError(null);
          }
        })
        .catch(() => {
          if (seq === reportRefreshSeq.current) setReportStaleError('無法重新取得最新的班名比對報告');
        });
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
          />
        </section>
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
            disabled={!isDirty || calculating}
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

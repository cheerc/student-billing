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
import { WindowSummary } from '@/components/settings/window-summary';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { ImpactDialog, SettingsPreviewData } from '@/components/settings/impact-dialog';
import { MappingPanel } from '@/components/settings/mapping-panel';
import { TabList, tabPanelProps } from '@/components/ui/tabs';

interface SettingsEditorProps {
  importId: string | null;
  currentRevision: number;
  initialDraft: SettingsDraft;
  unmatched?: string[];
  seedNotAppeared?: string[];
  matchedCount?: number;
  candidates?: DynamicCandidate[];
  lastAppliedRevision?: number;
  lastAppliedAt?: string | null;
  hasActiveImport?: boolean;
}

export default function SettingsEditor({
  importId,
  currentRevision,
  initialDraft,
  unmatched = [],
  seedNotAppeared = [],
  matchedCount = 0,
  candidates = [],
  lastAppliedRevision,
  lastAppliedAt,
  hasActiveImport = false,
}: SettingsEditorProps) {
  const [activeTab, setActiveTab] = useState<'schedule' | 'mapping'>('schedule');
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
  const [calculating, setCalculating] = useState(false);
  const reqSeqRef = useRef(0);
  const latestReqKeyRef = useRef<string>('');

  // 儲存確認視窗狀態
  const [isImpactDialogOpen, setIsImpactDialogOpen] = useState(false);
  const [preview, setPreview] = useState<SettingsPreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

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

        if (!res.ok) return;

        const data = await res.json();
        // 晚到請求保護 (UX08)：只有當前最新 requestKey 的回應才生效
        if (data.requestKey === latestReqKeyRef.current) {
          setCalculateResult(data);
        }
      } catch {
        // 唯讀計算異常靜默處理，不中斷 UI
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

  // 取消修改（還原到 baseline）
  const handleDiscard = () => {
    setRows(baseline.rows);
    setDraft((prev) => ({ ...prev, aliases: baseline.aliases }));
    setPreview(null);
    showToast('已取消未儲存的變更');
  };

  // 開啟確認視窗並載入影響預覽
  const handleOpenReview = async () => {
    setIsImpactDialogOpen(true);
    setPreviewLoading(true);
    setDialogError(null);

    try {
      const currentClasses = gridRowsToClasses(rows, draft.classes);
      const updatedDraft: SettingsDraft = {
        ...draft,
        classes: currentClasses,
      };

      // 依 server 決定的模式：無 active 名單時不傳送 importId（走 settings_only）
      const payload: Record<string, unknown> = {
        draft: updatedDraft,
        expectedRevision: currentRevision,
      };
      if (hasActiveImport && importId) {
        payload.importId = importId;
      }

      const res = await fetch('/api/v1/settings/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '載入預覽失敗');
      setPreview(json);
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : String(e));
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
          expectedRevision: currentRevision,
          idempotencyKey,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error('設定版本已變更，請重新確認變更後再行套用。');
        }
        if (res.status === 400 && json.error?.includes('PREVIEW_EXPIRED')) {
          throw new Error('預覽已逾期，請重新確認變更後再行套用。');
        }
        throw new Error(json.error || '套用失敗');
      }

      // 套用成功：更新 baseline，清除 dirty 狀態
      setBaseline({
        rows: [...rows],
        aliases: [...draft.aliases],
      });
      setIsImpactDialogOpen(false);
      setPreview(null);
      showToast(preview.mode === 'settings_only' ? '課表已成功儲存' : '課表已套用並完成重算');
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : String(e));
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
            seedNotAppeared={seedNotAppeared}
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
              {lastAppliedAt && ` · ${new Date(lastAppliedAt).toLocaleTimeString()}`}
            </span>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={!isDirty || calculating}
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
        }}
        onApply={handleApply}
        applying={applying || previewLoading}
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

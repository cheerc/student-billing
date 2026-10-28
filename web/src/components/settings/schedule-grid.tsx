'use client';

import React, { useState, useMemo, useRef, useCallback } from 'react';
import { ScheduleGridRow, type ClassType, DEFAULT_CARE_CLASS_NAMES } from '@/contracts/settings';
import { CalculatePreviewResponse } from '@/application/schedule-preview';
import { InfoTip } from '@/components/ui/info-tip';
import { CATEGORY_LABELS, type ClassAttributesView } from '@/domain/classification/class-attributes';
import type { ClassCategory } from '@/domain/classification/class-category';
import { TabList } from '@/components/ui/tabs';

/**
 * 折扣類別下拉選單的固定順序。
 * #157 Ruling 4：`unset`（未設定）排最前——它是預設狀態，也必須讓使用者能把設錯的班改回未設定。
 */
const CATEGORY_ORDER: ClassCategory[] = ['unset', 'care', 'math', 'english', 'none'];

/** 星期下拉的可選項（#82 另加「未定」，讓行政可以先建班名再排時間）。 */
const WEEKDAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '未定' },
  { value: '一', label: '週一' },
  { value: '二', label: '週二' },
  { value: '三', label: '週三' },
  { value: '四', label: '週四' },
  { value: '五', label: '週五' },
  { value: '六', label: '週六' },
  { value: '日', label: '週日' },
];

interface ScheduleGridProps {
  rows: ScheduleGridRow[];
  onUpdateRow: (rowId: string, updates: Partial<ScheduleGridRow>) => void;
  onDeleteRow: (rowId: string) => void;
  onAddRow: (
    row: Omit<ScheduleGridRow, 'rowId'>,
    classType?: ClassType | 'non_care',
    options?: { initialCategory?: 'unset' }
  ) => void;
  rosterOnlyClasses?: Array<{ baseName: string; students: number; tokens: number }>;
  rosterOnlyLocked?: boolean;
  rosterOnlyStaleMessage?: string | null;
  calculating: boolean;
  calculateResult: CalculatePreviewResponse | null;
  /**
   * 產生 calculateResult 時所依據的列（送出請求當下的 rows）。列目前的輸入與它不同＝該列的舊計算值已失效，
   * 顯示「—」直到新結果回來（09 §3.1：舊值立即失效，不得沿用）。未提供時視為與目前的列一致。
   */
  calculateInputRows?: ScheduleGridRow[] | null;
  /** 最近一次計算失敗的說明（有值時顯示 role=alert；此時 calculateResult 應為 null，各欄顯示「—」）。 */
  calculateError?: string | null;
  /**
   * 由「編輯此班課表」帶入的穩定班級識別（班名；F04）：只列該班的全部時段，並可回到全部班級。
   * 以進入時該班的列 id 記住，編輯中改班名或新增該班時段都不會讓列消失。
   */
  focusClass?: string | null;
  /** 初始課程類型頁籤（預設 non_care） */
  initialClassTypeTab?: ClassType | 'non_care';
  /**
   * #80：班級的折扣類別與「天數固定 5 天」併入同一張表格後，編輯器把**有效值**與變更處理器交進來。
   * 未提供（單獨使用本元件的測試）時這兩欄仍渲染，只是不可操作。
   */
  classAttributes?: Map<string, ClassAttributesView>;
  onSelectCategory?: (className: string, category: ClassCategory) => void;
  onToggleFixedFiveDays?: (className: string, fixed: boolean) => void;
  /** #81：課表全量匯出／匯入（單純一鍵，無欄位挑選對話框）。未提供時不渲染這兩個按鈕。 */
  onExportExcel?: () => void;
  onImportExcel?: (file: File) => void;
  /** Excel 匯入的錯誤（表頭／格式不符）；有值時顯示 role=alert，匯入已整批拒絕、未套用任何資料。 */
  importError?: string | null;
  /** Excel 匯入／匯出進行中（停用按鈕避免重複送出）。 */
  transferBusy?: boolean;
}

/**
 * 影響某一列計算結果的輸入：星期、起迄、班名（決定所屬班級）、班級是否啟用，
 * 以及 #113 follow-up 的逐列「不計扣天」——它一勾就會改變該列（與該班）的扣天，
 * 因此和時間欄一樣必須讓該列的舊計算值立即失效（09 §3.1：舊值立即失效，不得沿用）。
 */
function rowCalcSignature(r: ScheduleGridRow): string {
  return JSON.stringify([r.className, r.weekday, r.startMinutes, r.endMinutes, r.active, r.skipDeduction ?? false]);
}

export function formatDeductionDays(val: number | null | undefined): string {
  if (val === null || val === undefined) return '—';
  const pos = Math.abs(val);
  if (pos === 0) return '0';
  const rounded = Number(pos.toFixed(3));
  return String(rounded);
}

/**
 * 「未設定時間」儲存格（#82，decision `d-20261004093019108435-11`）：平鋪列裡只有班名、時間還在
 * 協調中的佔位列，計算欄位顯示「—」而不是「待補」徽章（行政每天都有這種列，滿版 badge 是視覺疲勞）。
 * a11y 補償：視覺只留一個破折號，但這格對螢幕閱讀器讀出「未設定時間」，鍵盤與螢讀使用者
 * 仍拿得到「這格是空的」這個語意，不必靠顏色或 badge 猜。
 *
 * 說明用可聚焦的 `<button>`（InfoTip）而非 `title`：09 §6 與 a11y 稽核都要求
 * 「資訊不可只藏在 hover」——`title` 只有滑鼠看得到，鍵盤使用者永遠讀不到。
 */
function NotSetYetCell({ children = '—', label = '未設定時間' }: { children?: React.ReactNode; label?: string }) {
  return (
    <InfoTip label={label} trigger={<span className="subtle cell-not-set">{children}</span>} variant="plain">
      {label}：這一列還沒有設定上課時間，所以算不出重疊與扣除。
    </InfoTip>
  );
}

/**
 * 「需確認」標示：星期空白或無法識別。v2 同星期規則下該列衝堂以 0 計，但這不是「已驗證沒有衝堂」，
 * 所以四個計算欄以此徽章取代數字（09 §3.1）。徽章是按鈕（鍵盤可聚焦），原因（寫出輸入的值）用 tooltip 呈現；
 * 頁面另有不靠 hover 的說明（見 ScheduleGrid 的 data-unknown-weekday-notice）。
 */
function NeedsReviewBadge({ reasons }: { reasons: string[] }) {
  const badge = <span className="badge-needs-review">需確認</span>;
  return (
    <InfoTip label="需確認原因" trigger={badge} variant="plain">
      {reasons.length > 0 ? reasons.join('；') : '星期無法識別，此列衝堂以 0 計，不代表沒有衝堂。'}
    </InfoTip>
  );
}

export function ScheduleGrid({
  rows,
  onUpdateRow,
  onDeleteRow,
  onAddRow,
  rosterOnlyClasses = [],
  rosterOnlyLocked = false,
  rosterOnlyStaleMessage = null,
  calculating,
  calculateResult,
  calculateInputRows,
  calculateError = null,
  focusClass = null,
  initialClassTypeTab = 'non_care',
  classAttributes,
  onSelectCategory,
  onToggleFixedFiveDays,
  onExportExcel,
  onImportExcel,
  importError = null,
  transferBusy = false,
}: ScheduleGridProps) {
  const [focus, setFocus] = useState<string | null>(focusClass);
  // 進入時屬於該班的列（改班名後仍留在畫面上，不因編輯而消失）
  const [focusRowIds] = useState<Set<string>>(
    () => new Set(focusClass ? rows.filter((r) => r.className.trim() === focusClass).map((r) => r.rowId) : [])
  );
  const [search, setSearch] = useState('');
  const [weekdayFilter, setWeekdayFilter] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [pendingRosterOnlyClass, setPendingRosterOnlyClass] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const getClassType = useCallback(
    (className: string): ClassType | 'non_care' => {
      const clean = className.trim();
      const attr = classAttributes?.get(clean);
      if (attr?.classType) return attr.classType;
      return DEFAULT_CARE_CLASS_NAMES.has(clean) ? 'care' : 'non_care';
    },
    [classAttributes]
  );

  // specs/14 §3.6：課表設定頁以分頁籤呈現：[非安親課輔班]（預設開啟）、[安親課輔班]（第二順位）
  // 若帶有 ?class=X 且 X 為安親課輔班，自動切換至 [安親課輔班] 避免誤判 missing
  const initialTab = useMemo<ClassType | 'non_care'>(() => {
    if (focusClass) {
      return getClassType(focusClass);
    }
    return initialClassTypeTab;
  }, [focusClass, getClassType, initialClassTypeTab]);

  const [activeTypeTab, setActiveTypeTab] = useState<ClassType | 'non_care'>(initialTab);

  // 新增班級表單狀態（#82：只有班名必填，其餘預設皆空；specs/14 A1：支援課程類型）
  const [newClassType, setNewClassType] = useState<ClassType | 'non_care'>('non_care');
  const [newClassName, setNewClassName] = useState('');
  const [newTeacher, setNewTeacher] = useState('');
  const [newWeekday, setNewWeekday] = useState('');
  const [newStartTime, setNewStartTime] = useState('');
  const [newEndTime, setNewEndTime] = useState('');

  // 將 calculateResult.rows 建立以 rowId 為鍵的快速查詢表。
  // 只收「輸入仍和計算當時相同」的列：列被改過（或是新增的列）＝舊結果已失效，不放進表，畫面顯示「—」（09 §3.1）。
  const resultMap = useMemo(() => {
    if (!calculateResult?.rows) return new Map();
    const inputSigs = new Map((calculateInputRows ?? rows).map((r) => [r.rowId, rowCalcSignature(r)]));
    const current = new Map(rows.map((r) => [r.rowId, rowCalcSignature(r)]));
    return new Map(
      calculateResult.rows
        .filter((r) => inputSigs.has(r.rowId) && inputSigs.get(r.rowId) === current.get(r.rowId))
        .map((r) => [r.rowId, r])
    );
  }, [calculateResult, calculateInputRows, rows]);

  // issues 以 rowId 為鍵的快速查詢表（只含仍有效的列）
  const issuesMap = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!calculateResult?.issues) return map;
    for (const issue of calculateResult.issues) {
      if (issue.rowId && resultMap.has(issue.rowId)) {
        const arr = map.get(issue.rowId) ?? [];
        arr.push(issue.message);
        map.set(issue.rowId, arr);
      }
    }
    return map;
  }, [calculateResult, resultMap]);

  // 星期無法識別（含空白）的有效列：供頁面上不靠 hover 的說明使用
  const unknownWeekdayInfo = useMemo(() => {
    let count = 0;
    let blank = 0;
    for (const r of rows) {
      const calcRow = resultMap.get(r.rowId);
      if (calcRow?.anqin.status === 'unknown_weekday') {
        count += 1;
        if (r.weekday.trim() === '') blank += 1;
      }
    }
    return { count, blank };
  }, [rows, resultMap]);

  // 定位班級（F04）：找不到該班（例如已改名）時明說，並顯示全部班級
  const focusMissing = focus !== null && focusRowIds.size === 0;
  const focusActive = focus !== null && !focusMissing;

  // 篩選時段列
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (focusActive) return focusRowIds.has(r.rowId) || r.className.trim() === focus;
      const matchSearch = search.trim() === '' || r.className.includes(search.trim());
      const matchWeekday = weekdayFilter === '' || r.weekday === weekdayFilter;
      return matchSearch && matchWeekday;
    });
  }, [rows, search, weekdayFilter, focusActive, focus, focusRowIds]);

  // 統計班級與時段數量（依課程類型頁籤統計）
  const nonCareClassesCount = useMemo(() => {
    return new Set(
      rows
        .filter((r) => getClassType(r.className) !== 'care')
        .map((r) => r.className.trim())
        .filter(Boolean)
    ).size;
  }, [rows, getClassType]);

  const careClassesCount = useMemo(() => {
    return new Set(
      rows
        .filter((r) => getClassType(r.className) === 'care')
        .map((r) => r.className.trim())
        .filter(Boolean)
    ).size;
  }, [rows, getClassType]);

  // 非安親課輔班時段列
  const displayedNonCareRows = useMemo(() => {
    return filteredRows.filter((r) => getClassType(r.className) !== 'care');
  }, [filteredRows, getClassType]);

  // 安親課輔班：每班一列
  const displayedCareRows = useMemo(() => {
    const careRows = filteredRows.filter((r) => getClassType(r.className) === 'care');
    const seen = new Set<string>();
    const list: ScheduleGridRow[] = [];
    for (const r of careRows) {
      const name = r.className.trim();
      if (!seen.has(name)) {
        seen.add(name);
        list.push(r);
      }
    }
    return list;
  }, [filteredRows, getClassType]);

  const currentTabRowCount = activeTypeTab !== 'care' ? displayedNonCareRows.length : displayedCareRows.length;
  const currentTabClassCount = activeTypeTab !== 'care' ? nonCareClassesCount : careClassesCount;

  const pendingRosterOnlyClassUnavailable =
    pendingRosterOnlyClass !== null &&
    (rosterOnlyLocked ||
      !rosterOnlyClasses.some((item) => item.baseName === pendingRosterOnlyClass) ||
      rows.some((row) => row.className.trim() === pendingRosterOnlyClass));

  const clearFocus = () => {
    setFocus(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('class');
      window.history.replaceState({}, '', url.toString());
    } catch {
      // 容錯
    }
  };

  const handleCreateSession = (e: React.FormEvent) => {
    e.preventDefault();
    if (pendingRosterOnlyClassUnavailable) return;

    const name = newClassName.trim();
    // #82：只有班名必填，其餘可留空（佔位列）
    if (!name) return;

    onAddRow(
      {
        className: name,
        teacher: newTeacher.trim() || null,
        weekday: newClassType === 'care' ? '' : newWeekday,
        startTime: newClassType === 'care' ? '' : newStartTime,
        endTime: newClassType === 'care' ? '' : newEndTime,
        startMinutes: null,
        endMinutes: null,
        active: true,
        // #113 follow-up：新增的時段預設不計扣天＝關（未勾選）。
        skipDeduction: false,
      },
      newClassType,
      pendingRosterOnlyClass === null ? undefined : { initialCategory: 'unset' }
    );

    setActiveTypeTab(newClassType);
    setNewClassName('');
    setNewTeacher('');
    setNewWeekday('');
    setNewStartTime('');
    setNewEndTime('');
    setShowAddForm(false);
    setPendingRosterOnlyClass(null);
  };

  const handleAddRosterOnlyClass = (baseName: string) => {
    const alreadyRepresented = rows.some((row) => row.className.trim() === baseName);
    if (rosterOnlyLocked || alreadyRepresented || showAddForm) return;

    setPendingRosterOnlyClass(baseName);
    setNewClassName(baseName);
    setNewTeacher('');
    setNewWeekday('');
    setNewStartTime('');
    setNewEndTime('');
    // The class type is an explicit form choice; use the visible tab only as its initial selection.
    setNewClassType(activeTypeTab);
    setShowAddForm(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onImportExcel) {
      onImportExcel(file);
    }
    // 重設 input value，讓同檔名也能再次觸發 onChange
    if (e.target) {
      e.target.value = '';
    }
  };

  return (
    <div className="card schedule-grid-container">
      {/* specs/14 §3.6：課表設定頁以分頁籤呈現 */}
      <div className="schedule-type-tabs" style={{ marginBottom: '16px' }}>
        <TabList
          label="課程類型頁籤"
          idPrefix="class-type"
          tabs={[
            { key: 'non_care', label: `非安親課輔班 (${nonCareClassesCount})` },
            { key: 'care', label: `安親課輔班 (${careClassesCount})` },
          ]}
          selected={activeTypeTab}
          onSelect={(key) => setActiveTypeTab(key as ClassType | 'non_care')}
        />
      </div>

      {/* 搜尋與篩選工具列 */}
      <div className="toolbar">
        <input
          type="text"
          className="search"
          placeholder="搜尋班級名稱..."
          aria-label="搜尋課表班級"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <select
          aria-label="課表星期篩選"
          value={weekdayFilter}
          onChange={(e) => setWeekdayFilter(e.target.value)}
        >
          <option value="">全部星期</option>
          {WEEKDAY_OPTIONS.filter((o) => o.value !== '').map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <span className="note count-summary">
          {currentTabClassCount} 個班級 · {currentTabRowCount} 個時段
          {calculating && <span className="calculating-indicator"> · 計算中...</span>}
        </span>

        {/* #81：Excel 匯出／匯入按鈕（單純一鍵，無欄位挑選對話框） */}
        {onExportExcel && onImportExcel && (
          <div className="transfer-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={onExportExcel}
              disabled={transferBusy}
              data-schedule-export=""
            >
              {transferBusy ? '處理中...' : '匯出 Excel'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => importInputRef.current?.click()}
              disabled={transferBusy}
              data-schedule-import=""
            >
              匯入 Excel
            </button>
            {/* 隱藏的檔案選擇器（接受 .xlsx）；使用者點擊「匯入 Excel」按鈕即開啟系統原生檔案對話框 */}
            <input
              ref={importInputRef}
              type="file"
              accept=".xlsx"
              style={{ display: 'none' }}
              aria-label="選擇課表 Excel 檔案"
              onChange={handleFileChange}
            />
          </div>
        )}

        <button
          type="button"
          className="btn-primary end"
          onClick={() => {
            setShowAddForm((prev) => {
              if (!prev) setNewClassType(activeTypeTab);
              else setPendingRosterOnlyClass(null);
              return !prev;
            });
          }}
        >
          {showAddForm ? '取消新增' : '＋ 新增班級'}
        </button>
      </div>

      {rosterOnlyClasses.length > 0 && (
        <details
          className="roster-only-schedule-section"
          role="region"
          aria-label="名單中尚未加入課表設定的班級"
          data-roster-only-section=""
        >
          <summary style={{ cursor: 'pointer', padding: '10px 14px', fontWeight: 600 }}>
            名單中有 {rosterOnlyClasses.length} 個班級尚未加入課表設定
          </summary>
          <div style={{ marginTop: '8px' }}>
            <p className="note">
              這些班級來自目前檢視的名單，尚未出現在課表設定中。加入後請自行選擇課程類型、折扣類別與適用設定。
            </p>
            {rosterOnlyStaleMessage && (
              <p className="notice-warn" role="status" data-roster-only-stale="">
                {rosterOnlyStaleMessage}最新報告完成前，不能依這份舊清單加入班級。請到「班名對應」頁重新載入。
              </p>
            )}
            <div className="scroll table-scroll-container">
              <table className="data-table roster-only-schedule-table">
                <thead>
                  <tr>
                    <th>班級名稱</th>
                    <th>學生</th>
                    <th>報名筆數</th>
                    <th>狀態</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rosterOnlyClasses.map((item) => {
                    const alreadyRepresented = rows.some((row) => row.className.trim() === item.baseName);
                    return (
                      <tr key={item.baseName} data-roster-only-class={item.baseName}>
                        <td>{item.baseName}</td>
                        <td>{item.students} 位</td>
                        <td>{item.tokens}</td>
                        <td>尚未加入課表設定</td>
                        <td>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={rosterOnlyLocked || alreadyRepresented || showAddForm}
                            onClick={() => handleAddRosterOnlyClass(item.baseName)}
                          >
                            加入課表設定
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}

      {/* Excel 匯入錯誤橫幅（整批拒絕時顯示，角色為 alert） */}
      {importError && (
        <div className="alert alert-danger" role="alert" data-schedule-import-error="">
          <strong>課表匯入失敗（沒有套用任何資料）：</strong>
          {importError}
        </div>
      )}

      {/* 定位模式提示橫幅（F04） */}
      {focusActive && (
        <div className="notice-inline" role="status" data-focus-class="">
          只顯示班級「{focus}」的全部時段（{filteredRows.length} 個時段）
          <button type="button" className="link-button" onClick={clearFocus}>
            顯示全部班級
          </button>
        </div>
      )}

      {/* 定位班級找不到時（例如剛剛在別處改名），明說並退回全部班級 */}
      {focusMissing && (
        <div className="notice-warn" role="status" data-focus-class-missing="">
          課表中找不到班級「{focus}」，可能已改名或停用；先顯示全部班級。
        </div>
      )}

      {/* 計算失敗：不顯示舊值、不當成「沒有重疊」（09 §3.1） */}
      {calculateError && (
        <div className="alert alert-danger" role="alert" data-calculate-error="">
          {calculateError} 各欄先以「—」顯示，不代表沒有衝堂；修改課表後會自動重試。
        </div>
      )}

      {/* 星期無法識別：需確認的說明，不只藏在 hover 裡（09 §6） */}
      {unknownWeekdayInfo.count > 0 && (
        <div className="notice-inline" role="status" data-unknown-weekday-notice="">
          有 {unknownWeekdayInfo.count} 個時段的星期無法識別（需確認）
          {unknownWeekdayInfo.blank > 0 ? `，其中 ${unknownWeekdayInfo.blank} 個沒有填星期` : ''}
          ：這些時段的重疊與扣除以「需確認」標示，不代表沒有衝堂。請把星期改成「一」到「日」。
        </div>
      )}

      {/* 新增班級內嵌表單（specs/14 A1：支援課程類型選擇） */}
      {showAddForm && (
        <form onSubmit={handleCreateSession} className="add-session-panel" aria-label="新增班級表單">
          <div className="form-row">
            <label>
              <span>課程類型 *</span>
              <select
                value={newClassType}
                onChange={(e) => setNewClassType(e.target.value as ClassType | 'non_care')}
                aria-label="新增班級課程類型"
              >
                <option value="non_care">非安親課輔班</option>
                <option value="care">安親課輔班</option>
              </select>
            </label>
            <label>
              <span>班級名稱 *</span>
              <input
                type="text"
                required
                placeholder={newClassType === 'care' ? "例如：國小輔導-七年級" : "例如：國小數學-一A"}
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
              />
            </label>
            <label>
              <span>帶班老師</span>
              <input
                type="text"
                placeholder="選填"
                value={newTeacher}
                onChange={(e) => setNewTeacher(e.target.value)}
              />
            </label>
            {newClassType !== 'care' && (
              <>
                <label>
                  <span>星期</span>
                  <select value={newWeekday} onChange={(e) => setNewWeekday(e.target.value)}>
                    {WEEKDAY_OPTIONS.map((o) => (
                      <option key={o.value || 'unset'} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>上課時間 (起)</span>
                  <input
                    type="time"
                    value={newStartTime}
                    onChange={(e) => setNewStartTime(e.target.value)}
                  />
                </label>
                <label>
                  <span>上課時間 (迄)</span>
                  <input
                    type="time"
                    value={newEndTime}
                    onChange={(e) => setNewEndTime(e.target.value)}
                  />
                </label>
              </>
            )}
            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={pendingRosterOnlyClassUnavailable}>確認新增</button>
            </div>
          </div>
          <span className="note">
            {newClassType === 'care'
              ? '安親課輔班不需輸入上課星期與時間。'
              : '只有「班級名稱」必填；星期與時間可以先留空，等排課確定後再補，計算欄會顯示「—」。'}
          </span>
        </form>
      )}

      {/* 課表表格：兩頁籤欄位徹底分離（specs/14 §3.6, A2, A4） */}
      <div
        role="tabpanel"
        id={`class-type-panel-${activeTypeTab}`}
        aria-labelledby={`class-type-tab-${activeTypeTab}`}
        className="scroll table-scroll-container schedule-table-scroll"
      >
        {activeTypeTab !== 'care' ? (
          /* [非安親課輔班] 表格：包含不計扣天與時段計算，無天數固定 5 天 */
          <table className="schedule-table schedule-table-non-care">
            <thead>
              <tr>
                <th rowSpan={2} className="col-classname sticky-col sticky-corner">班級名稱</th>
                <th rowSpan={2} className="col-category">列入多科折扣</th>
                <th rowSpan={2} className="col-skip-deduction">不計扣天</th>
                <th rowSpan={2} className="col-teacher">帶班老師</th>
                <th rowSpan={2} className="col-weekday">星期</th>
                <th rowSpan={2} className="col-time">上課時間<br />起 — 迄</th>
                <th rowSpan={2} className="col-duration number">課程時長<br />分</th>
                <th colSpan={2} className="col-group-anqin cblue">安親窗口 (13:00–16:00)</th>
                <th colSpan={2} className="col-group-tutoring cteal">課輔窗口 (16:30–19:30)</th>
                <th rowSpan={2} className="col-actions">操作</th>
              </tr>
              <tr>
                <th className="number cblue">重疊／分</th>
                <th className="number cblue">扣除／天</th>
                <th className="number cteal">重疊／分</th>
                <th className="number cteal">扣除／天</th>
              </tr>
            </thead>
            <tbody>
              {displayedNonCareRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="empty-row-text">
                    沒有符合篩選條件的非安親課輔班時段。
                  </td>
                </tr>
              ) : (
                displayedNonCareRows.map((r, idx) => {
                  const isFirstOfClass =
                    idx === 0 || displayedNonCareRows[idx - 1].className !== r.className;
                  const calcRow = resultMap.get(r.rowId);
                  const rowIssues = issuesMap.get(r.rowId) ?? [];
                  const className = r.className.trim();

                  // 判斷該列是否為不完整列
                  const isIncomplete =
                    r.startMinutes === null ||
                    r.endMinutes === null ||
                    r.endMinutes <= r.startMinutes ||
                    calcRow?.anqin.status === 'missing_time';

                  const isInactive = !r.active || calcRow?.anqin.status === 'inactive';
                  const isSharedWindow = calcRow?.anqin.status === 'shared_window';
                  const isUnknownWeekday = !isInactive && !isIncomplete && calcRow?.anqin.status === 'unknown_weekday';

                  const attr = classAttributes?.get(className);
                  const attrsDisabled = !classAttributes || !onSelectCategory;

                  return (
                    <tr
                      key={r.rowId}
                      className={`schedule-row ${isFirstOfClass ? 'class-group-start' : ''} ${
                        !r.active ? 'row-inactive' : ''
                      } ${isIncomplete ? 'row-incomplete' : ''} ${isUnknownWeekday ? 'row-unknown-weekday' : ''}`}
                    >
                      {/* 1. 班級名稱 */}
                      <td className="col-classname sticky-col">
                        <input
                          type="text"
                          className="input-classname"
                          value={r.className}
                          onChange={(e) => onUpdateRow(r.rowId, { className: e.target.value })}
                          aria-label={`班級名稱 第 ${idx + 1} 列`}
                        />
                      </td>

                      {/* 2. 列入多科折扣 */}
                      <td className="col-category">
                        <select
                          value={attr?.category ?? 'unset'}
                          disabled={attrsDisabled}
                          aria-label={`${className} 的列入多科折扣`}
                          data-category-select={className}
                          onChange={(e) => onSelectCategory?.(className, e.target.value as ClassCategory)}
                        >
                          {CATEGORY_ORDER.map((c) => (
                            <option key={c} value={c}>
                              {CATEGORY_LABELS[c]}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* 3. 不計扣天（逐列） */}
                      <td className="col-skip-deduction">
                        <label className="fixed-five-toggle">
                          <input
                            type="checkbox"
                            checked={r.skipDeduction ?? false}
                            aria-label={`${r.className} 第 ${idx + 1} 列的不計扣天`}
                            data-skip-deduction-toggle={r.rowId}
                            onChange={(e) => onUpdateRow(r.rowId, { skipDeduction: e.target.checked })}
                          />
                          <span aria-hidden="true">{r.skipDeduction ? '是' : '否'}</span>
                        </label>
                      </td>

                      {/* 4. 帶班老師 */}
                      <td className="col-teacher">
                        <input
                          type="text"
                          className="input-teacher"
                          value={r.teacher ?? ''}
                          placeholder="無"
                          onChange={(e) => onUpdateRow(r.rowId, { teacher: e.target.value || null })}
                          aria-label={`帶班老師 第 ${idx + 1} 列`}
                        />
                      </td>

                      {/* 5. 星期 */}
                      <td className="col-weekday">
                        <input
                          type="text"
                          className="input-weekday"
                          placeholder="未定"
                          value={r.weekday}
                          onChange={(e) => onUpdateRow(r.rowId, { weekday: e.target.value })}
                          aria-label={`星期 第 ${idx + 1} 列`}
                        />
                      </td>

                      {/* 6. 上課時間 (起 — 迄) */}
                      <td className="col-time">
                        <div className="time-inputs-pair">
                          <input
                            type="text"
                            className="input-time"
                            placeholder="HH:mm"
                            value={r.startTime}
                            onChange={(e) => onUpdateRow(r.rowId, { startTime: e.target.value })}
                            aria-label={`起始時間 第 ${idx + 1} 列`}
                          />
                          <span className="time-separator">—</span>
                          <input
                            type="text"
                            className="input-time"
                            placeholder="HH:mm"
                            value={r.endTime}
                            onChange={(e) => onUpdateRow(r.rowId, { endTime: e.target.value })}
                            aria-label={`結束時間 第 ${idx + 1} 列`}
                          />
                        </div>
                      </td>

                      {/* 7. 課程時長 */}
                      <td className="col-duration number" data-calc="duration">
                        {isIncomplete ? (
                          <NotSetYetCell />
                        ) : isInactive ? (
                          <span className="subtle">停用</span>
                        ) : (
                          calcRow?.durationMinutes ?? '—'
                        )}
                      </td>

                      {/* 8. 安親 重疊／分 */}
                      <td className="number cblue" data-calc="anqin-overlap">
                        {isIncomplete ? (
                          <NotSetYetCell />
                        ) : isInactive ? (
                          <span className="subtle">—</span>
                        ) : isSharedWindow ? (
                          <span className="subtle">共用</span>
                        ) : isUnknownWeekday ? (
                          <NeedsReviewBadge reasons={rowIssues} />
                        ) : (
                          calcRow ? (calcRow.anqin.overlapMinutes ?? 0) : '—'
                        )}
                      </td>

                      {/* 9. 安親 扣除／天 */}
                      <td className="number cblue" data-calc="anqin-deduction">
                        {isIncomplete ? (
                          <NotSetYetCell />
                        ) : isInactive ? (
                          <span className="subtle">—</span>
                        ) : isSharedWindow ? (
                          <span className="subtle">共用</span>
                        ) : isUnknownWeekday ? (
                          <NeedsReviewBadge reasons={rowIssues} />
                        ) : (
                          formatDeductionDays(calcRow?.anqin.rawDeduction)
                        )}
                      </td>

                      {/* 10. 課輔 重疊／分 */}
                      <td className="number cteal" data-calc="tutoring-overlap">
                        {isIncomplete ? (
                          <NotSetYetCell />
                        ) : isInactive ? (
                          <span className="subtle">—</span>
                        ) : isSharedWindow ? (
                          <span className="subtle">共用</span>
                        ) : isUnknownWeekday ? (
                          <NeedsReviewBadge reasons={rowIssues} />
                        ) : (
                          calcRow ? (calcRow.tutoring.overlapMinutes ?? 0) : '—'
                        )}
                      </td>

                      {/* 11. 課輔 扣除／天 */}
                      <td className="number cteal" data-calc="tutoring-deduction">
                        {isIncomplete ? (
                          <NotSetYetCell />
                        ) : isInactive ? (
                          <span className="subtle">—</span>
                        ) : isSharedWindow ? (
                          <span className="subtle">共用</span>
                        ) : isUnknownWeekday ? (
                          <NeedsReviewBadge reasons={rowIssues} />
                        ) : (
                          formatDeductionDays(calcRow?.tutoring.rawDeduction)
                        )}
                      </td>

                      {/* 12. 操作 */}
                      <td className="col-actions">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn-danger-icon"
                            title="刪除此時段"
                            onClick={() => onDeleteRow(r.rowId)}
                            aria-label={`刪除時段 ${r.className}`}
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          /* [安親課輔班] 表格：每班一列，無時段與不計扣天（specs/14 §3.6, A2, A4） */
          <table className="schedule-table schedule-table-care">
            <thead>
              <tr>
                <th className="col-classname sticky-col sticky-corner">班級名稱</th>
                <th className="col-category">列入多科折扣</th>
                <th className="col-fixed-five">天數固定 5 天</th>
                <th className="col-teacher">帶班老師</th>
                <th className="col-status">狀態</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {displayedCareRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-row-text">
                    沒有符合篩選條件的安親課輔班。
                  </td>
                </tr>
              ) : (
                displayedCareRows.map((r, idx) => {
                  const className = r.className.trim();
                  const attr = classAttributes?.get(className);
                  const attrsDisabled = !classAttributes || !onSelectCategory || !onToggleFixedFiveDays;

                  return (
                    <tr key={r.rowId} className="schedule-row class-group-start">
                      {/* 1. 班級名稱 */}
                      <td className="col-classname sticky-col">
                        <input
                          type="text"
                          className="input-classname"
                          value={r.className}
                          onChange={(e) => onUpdateRow(r.rowId, { className: e.target.value })}
                          aria-label={`班級名稱 第 ${idx + 1} 列`}
                        />
                      </td>

                      {/* 2. 列入多科折扣 */}
                      <td className="col-category">
                        <select
                          value={attr?.category ?? 'unset'}
                          disabled={attrsDisabled}
                          aria-label={`${className} 的列入多科折扣`}
                          data-category-select={className}
                          onChange={(e) => onSelectCategory?.(className, e.target.value as ClassCategory)}
                        >
                          {CATEGORY_ORDER.map((c) => (
                            <option key={c} value={c}>
                              {CATEGORY_LABELS[c]}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* 3. 天數固定 5 天 */}
                      <td className="col-fixed-five">
                        <label className="fixed-five-toggle">
                          <input
                            type="checkbox"
                            checked={attr?.fixedFiveDays ?? false}
                            disabled={attrsDisabled}
                            aria-label={`${className} 的天數固定 5 天`}
                            data-fixed-five-toggle={className}
                            onChange={(e) => onToggleFixedFiveDays?.(className, e.target.checked)}
                          />
                          <span aria-hidden="true">{attr?.fixedFiveDays ? '是' : '否'}</span>
                        </label>
                      </td>

                      {/* 4. 帶班老師 */}
                      <td className="col-teacher">
                        <input
                          type="text"
                          className="input-teacher"
                          value={r.teacher ?? ''}
                          placeholder="無"
                          onChange={(e) => onUpdateRow(r.rowId, { teacher: e.target.value || null })}
                          aria-label={`帶班老師 第 ${idx + 1} 列`}
                        />
                      </td>

                      {/* 5. 狀態 */}
                      <td className="col-status">
                        <span className="badge badge-neutral" data-status-label="">
                          安親課輔班（不計時段）
                        </span>
                      </td>

                      {/* 6. 操作 */}
                      <td className="col-actions">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn-danger-icon"
                            title="刪除此班級"
                            onClick={() => onDeleteRow(r.rowId)}
                            aria-label={`刪除班級 ${r.className}`}
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="tablefoot">
        <span className="note">
          扣除欄為單堂未取整數值（以正量顯示）。整班重疊加總後，不足 0.3 天不扣、0.3～0.8 天扣半天、0.8 天以上扣 1 天。
        </span>
      </div>
    </div>
  );
}
export default ScheduleGrid;

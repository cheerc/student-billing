'use client';

import React, { useState, useMemo, useCallback } from 'react';
import {
  ScheduleGridRow,
  type ClassType,
  CLASS_TYPE_ORDER,
  CLASS_TYPE_LABELS,
  isSchedulableClassType,
  supportsMultiSubjectDiscount,
  defaultSkipDeductionForClassType,
  DEFAULT_CARE_CLASS_NAMES,
} from '@/contracts/settings';
import { SEED_CLASS_TYPES } from '@/domain/schedules/seed-manifest';
import { CalculatePreviewResponse } from '@/application/schedule-preview';
import { InfoTip } from '@/components/ui/info-tip';
import { type ClassAttributesView } from '@/domain/classification/class-attributes';
import { TabList } from '@/components/ui/tabs';
import { YesNoRadioGroup } from './yes-no-radio-group';

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

export interface ScheduleGridProps {
  rows: ScheduleGridRow[];
  onUpdateRow: (rowId: string, updates: Partial<ScheduleGridRow>) => void;
  onDeleteRow: (rowId: string) => void;
  onAddRow: (
    row: Omit<ScheduleGridRow, 'rowId'>,
    classType?: ClassType | 'non_care',
    options?: { initialCategory?: 'unset'; hasMultiSubjectDiscount?: boolean; fixedFiveDays?: boolean }
  ) => void;
  calculating: boolean;
  calculateResult: CalculatePreviewResponse | null;
  calculateInputRows?: ScheduleGridRow[] | null;
  calculateError?: string | null;
  focusClass?: string | null;
  onClearFocus?: () => void;
  initialClassTypeTab?: ClassType | 'non_care';
  selectedClassType?: ClassType;
  onSelectClassType?: (classType: ClassType) => void;
  search?: string;
  showAddForm?: boolean;
  onShowAddFormChange?: (open: boolean) => void;
  classAttributes?: Map<string, ClassAttributesView>;
  onSelectCategory?: (className: string, category: any) => void;
  onToggleMultiDiscount?: (className: string, hasMulti: boolean) => void;
  onToggleFixedFiveDays?: (className: string, fixed: boolean) => void;
  importError?: string | null;
}

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

function NotSetYetCell({ children = '—', label = '未設定時間' }: { children?: React.ReactNode; label?: string }) {
  return (
    <InfoTip label={label} trigger={<span className="subtle cell-not-set">{children}</span>} variant="plain">
      {label}：這一列還沒有設定上課時間，所以算不出重疊與扣除。
    </InfoTip>
  );
}

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
  calculating,
  calculateResult,
  calculateInputRows,
  calculateError = null,
  focusClass = null,
  onClearFocus,
  initialClassTypeTab = 'care',
  classAttributes,
  onSelectCategory,
  onToggleMultiDiscount,
  onToggleFixedFiveDays,
  selectedClassType,
  onSelectClassType,
  search = '',
  showAddForm = false,
  onShowAddFormChange,
  importError = null,
}: ScheduleGridProps) {
  const focusIsControlled = focusClass !== undefined;
  const [localFocus, setLocalFocus] = useState<string | null>(focusClass ?? null);
  const focus = focusIsControlled ? focusClass ?? null : localFocus;
  const focusRowIds = useMemo<Set<string>>(
    () => new Set(focus ? rows.filter((r) => r.className.trim() === focus).map((r) => r.rowId) : []),
    [focus, rows]
  );
  const [weekdayFilter, setWeekdayFilter] = useState('');

  const getClassType = useCallback(
    (className: string): ClassType => {
      const clean = className.trim();
      const attr = classAttributes?.get(clean);
      if (attr?.classType) {
        return attr.classType === 'non_care' ? 'other' : attr.classType;
      }
      const seedType = SEED_CLASS_TYPES.get(clean);
      if (seedType) {
        return seedType;
      }
      return DEFAULT_CARE_CLASS_NAMES.has(clean) ? 'care' : 'other';
    },
    [classAttributes]
  );

  const initialTab = useMemo<ClassType>(() => {
    if (focusClass) {
      return getClassType(focusClass);
    }
    if (initialClassTypeTab && initialClassTypeTab !== 'non_care' && initialClassTypeTab !== 'care') {
      return initialClassTypeTab;
    }
    // 預設優先開啟 care（安親課輔班）；若當前 rows 無任何 care 班級，則自動落到第一個有資料的頁籤
    const hasCare = rows.some((r) => getClassType(r.className) === 'care');
    if (hasCare) return 'care';

    for (const type of CLASS_TYPE_ORDER) {
      if (rows.some((r) => getClassType(r.className) === type)) {
        return type;
      }
    }
    return 'care';
  }, [focusClass, getClassType, initialClassTypeTab, rows]);

  // 生產頁面傳入受控選取值；本地狀態僅供獨立 ScheduleGrid 渲染測試使用。
  const [localActiveTypeTab, setLocalActiveTypeTab] = useState<ClassType>(initialTab);
  const activeTypeTab = selectedClassType ?? localActiveTypeTab;
  const [newClassName, setNewClassName] = useState('');
  const [newTeacher, setNewTeacher] = useState('');
  const [newWeekday, setNewWeekday] = useState('');
  const [newStartTime, setNewStartTime] = useState('');
  const [newEndTime, setNewEndTime] = useState('');
  const [newHasMulti, setNewHasMulti] = useState(() =>
    supportsMultiSubjectDiscount(selectedClassType ?? initialTab)
  );
  const [newFixedFive, setNewFixedFive] = useState(false);
  const [newSkipDeduction, setNewSkipDeduction] = useState(() =>
    defaultSkipDeductionForClassType(selectedClassType ?? initialTab)
  );

  const resetNewClassTypeDefaults = useCallback((type: ClassType) => {
    setNewHasMulti(supportsMultiSubjectDiscount(type));
    setNewFixedFive(false);
    setNewSkipDeduction(defaultSkipDeductionForClassType(type));
  }, []);

  const handleSelectType = (type: ClassType) => {
    setLocalActiveTypeTab(type);
    onSelectClassType?.(type);
    resetNewClassTypeDefaults(type);
  };

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

  const focusMissing = focus !== null && focusRowIds.size === 0;
  const focusActive = focus !== null && !focusMissing;

  const isSchedulableTab = isSchedulableClassType(activeTypeTab);

  // 篩選時段列
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (focusActive) return focusRowIds.has(r.rowId) || r.className.trim() === focus;
      const matchSearch = search.trim() === '' || r.className.includes(search.trim());
      // care 與 unscheduled 不受星期篩選影響
      const matchWeekday = !isSchedulableTab || weekdayFilter === '' || r.weekday === weekdayFilter;
      return matchSearch && matchWeekday;
    });
  }, [rows, search, weekdayFilter, focusActive, focus, focusRowIds, isSchedulableTab]);

  // 判斷單列是否未填時間（待補 1c）
  const isRowIncomplete = useCallback((r: ScheduleGridRow) => {
    return (
      r.weekday.trim() === '' ||
      r.startMinutes === null ||
      r.endMinutes === null ||
      r.endMinutes <= r.startMinutes
    );
  }, []);

  // 取得各頁籤顯示之列清單
  const displayedTabRows = useMemo(() => {
    const matching = filteredRows.filter((r) => getClassType(r.className) === activeTypeTab);
    if (!isSchedulableTab) {
      // care 與 unscheduled 每班去重僅顯示 1 列
      const seen = new Set<string>();
      const list: ScheduleGridRow[] = [];
      for (const r of matching) {
        const name = r.className.trim();
        if (!seen.has(name)) {
          seen.add(name);
          list.push(r);
        }
      }
      return list;
    }
    return matching;
  }, [filteredRows, getClassType, activeTypeTab, isSchedulableTab]);

  // 各頁籤統計使用全量 rows；搜尋／星期篩選只影響「目前顯示」摘要。
  const tabStats = useMemo(() => {
    const stats: Record<ClassType, { classCount: number; rowCount: number; incompleteCount: number }> = {
      care: { classCount: 0, rowCount: 0, incompleteCount: 0 },
      english: { classCount: 0, rowCount: 0, incompleteCount: 0 },
      math: { classCount: 0, rowCount: 0, incompleteCount: 0 },
      other: { classCount: 0, rowCount: 0, incompleteCount: 0 },
      unscheduled: { classCount: 0, rowCount: 0, incompleteCount: 0 },
    };

    const classSets: Record<ClassType, Set<string>> = {
      care: new Set(),
      english: new Set(),
      math: new Set(),
      other: new Set(),
      unscheduled: new Set(),
    };

    for (const r of rows) {
      const type = getClassType(r.className);
      const name = r.className.trim();
      stats[type].rowCount += 1;
      if (name) classSets[type].add(name);
      if (isSchedulableClassType(type) && isRowIncomplete(r)) {
        stats[type].incompleteCount += 1;
      }
    }

    for (const type of CLASS_TYPE_ORDER) {
      stats[type].classCount = classSets[type].size;
    }

    return stats;
  }, [rows, getClassType, isRowIncomplete]);

  const currentTabClassCount = tabStats[activeTypeTab].classCount;
  const currentTabRowCount = tabStats[activeTypeTab].rowCount;
  const displayedTabClassCount = new Set(
    displayedTabRows.map((row) => row.className.trim()).filter(Boolean)
  ).size;
  const hasSearchFilter = search.trim() !== '';
  const hasWeekdayFilter = isSchedulableTab && weekdayFilter !== '';

  const clearFocus = () => {
    if (!focusIsControlled) setLocalFocus(null);
    onClearFocus?.();
  };

  const handleCreateSession = (e: React.FormEvent) => {
    e.preventDefault();

    const name = newClassName.trim();
    if (!name) return;

    const isSchedulable = isSchedulableClassType(activeTypeTab);

    onAddRow(
      {
        className: name,
        teacher: newTeacher.trim() || null,
        weekday: !isSchedulable ? '' : newWeekday,
        startTime: !isSchedulable ? '' : newStartTime,
        endTime: !isSchedulable ? '' : newEndTime,
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: !isSchedulable ? false : newSkipDeduction,
      },
      activeTypeTab,
      {
        hasMultiSubjectDiscount: newHasMulti,
        fixedFiveDays: newFixedFive,
      }
    );

    setNewClassName('');
    setNewTeacher('');
    setNewWeekday('');
    setNewStartTime('');
    setNewEndTime('');
    onShowAddFormChange?.(false);
  };

  return (
    <div className="card schedule-grid-container">
      {/* D61：5 個課程類型頁籤與條件篩選同列 */}
      <div className="schedule-type-controls">
        <div className="schedule-type-tabs">
          <TabList
            label="課程類型頁籤"
            idPrefix="class-type"
            tabs={CLASS_TYPE_ORDER.map((type) => {
              const { classCount, incompleteCount } = tabStats[type];
              const incompleteLabel =
                isSchedulableClassType(type) && incompleteCount > 0
                  ? ` · 待補 ${incompleteCount}`
                  : '';
              return {
                key: type,
                label: (
                  <>
                    <span className="schedule-type-tab-label">{CLASS_TYPE_LABELS[type]}</span>{' '}
                    <span className="schedule-type-tab-count">({classCount}{incompleteLabel})</span>
                  </>
                ),
              };
            })}
            selected={activeTypeTab}
            onSelect={(key) => handleSelectType(key as ClassType)}
          />
        </div>

        {/* 類型頁籤右側的條件式星期篩選；不進入 tablist。 */}
        {isSchedulableTab && (
          <select
            id="schedule-weekday-filter"
            className="schedule-weekday-filter"
            aria-label="課表星期篩選"
            value={weekdayFilter}
            onChange={(event) => setWeekdayFilter(event.target.value)}
          >
            <option value="">全部星期</option>
            {WEEKDAY_OPTIONS.filter((option) => option.value !== '').map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        {calculating && (
          <span className="calculating-indicator" role="status" aria-live="polite">
            計算中...
          </span>
        )}
      </div>

      {importError && (
        <div className="alert alert-danger" role="alert" data-schedule-import-error="">
          <strong>課表匯入失敗（沒有套用任何資料）：</strong>
          {importError}
        </div>
      )}

      {focusActive && (
        <div className="notice-inline" role="status" data-focus-class="">
          只顯示班級「{focus}」的全部時段（{filteredRows.length} 個時段）
          <button type="button" className="link-button" onClick={clearFocus}>
            顯示全部班級
          </button>
        </div>
      )}

      {focusMissing && (
        <div className="notice-warn" role="status" data-focus-class-missing="">
          課表中找不到班級「{focus}」，可能已改名或停用；先顯示全部班級。
        </div>
      )}

      {calculateError && (
        <div className="alert alert-danger" role="alert" data-calculate-error="">
          {calculateError} 各欄先以「—」顯示，不代表沒有衝堂；修改課表後會自動重試。
        </div>
      )}

      {unknownWeekdayInfo.count > 0 && isSchedulableTab && (
        <div className="notice-inline" role="status" data-unknown-weekday-notice="">
          有 {unknownWeekdayInfo.count} 個時段的星期無法識別（需確認）
          {unknownWeekdayInfo.blank > 0 ? `，其中 ${unknownWeekdayInfo.blank} 個沒有填星期` : ''}
          ：這些時段的重疊與扣除以「需確認」標示，不代表沒有衝堂。請把星期改成「一」到「日」。
        </div>
      )}

      {/* 新增班級表單（動態支援五種課程類型） */}
      {showAddForm && (
        <form onSubmit={handleCreateSession} className="add-session-panel" aria-label="新增班級表單">
          <div className="form-row">
            <label>
              <span>課程類型 *</span>
              <select
                value={activeTypeTab}
                onChange={(e) => handleSelectType(e.target.value as ClassType)}
                aria-label="新增班級課程類型"
              >
                {CLASS_TYPE_ORDER.map((type) => (
                  <option key={type} value={type}>
                    {CLASS_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>班級名稱 *</span>
              <input
                type="text"
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
                placeholder="例如：平日作文班"
                aria-label="新增班級名稱"
                required
              />
            </label>
            <label>
              <span>帶班老師</span>
              <input
                type="text"
                value={newTeacher}
                onChange={(e) => setNewTeacher(e.target.value)}
                placeholder="例如：張老師"
                aria-label="新增帶班老師"
              />
            </label>

            {/* 是否有多科折扣：僅 care, english, math 出現 */}
            {supportsMultiSubjectDiscount(activeTypeTab) && (
              <label>
                <span>是否有多科折扣</span>
                <YesNoRadioGroup
                  label="新增班級是否有多科折扣"
                  name="new-multi-discount"
                  value={newHasMulti}
                  onChange={setNewHasMulti}
                />
              </label>
            )}

            {/* 天數固定 5 天：僅 care 出現 */}
            {activeTypeTab === 'care' && (
              <label>
                <span>天數固定 5 天</span>
                <YesNoRadioGroup
                  label="新增班級天數固定5天"
                  name="new-fixed-five"
                  value={newFixedFive}
                  onChange={setNewFixedFive}
                />
              </label>
            )}

            {/* 不計扣天：僅 english, math, other 出現 */}
            {isSchedulableClassType(activeTypeTab) && (
              <label>
                <span>不計扣天</span>
                <YesNoRadioGroup
                  label="新增時段不計扣天"
                  name="new-skip-deduction"
                  value={newSkipDeduction}
                  onChange={setNewSkipDeduction}
                />
              </label>
            )}

            {/* 星期與起訖時間：僅排課類型出現 */}
            {isSchedulableClassType(activeTypeTab) && (
              <>
                <label>
                  <span>星期</span>
                  <select
                    value={newWeekday}
                    onChange={(e) => setNewWeekday(e.target.value)}
                    aria-label="新增星期"
                  >
                    {WEEKDAY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>起始時間</span>
                  <input
                    type="text"
                    value={newStartTime}
                    onChange={(e) => setNewStartTime(e.target.value)}
                    placeholder="HH:mm"
                    aria-label="新增起始時間"
                  />
                </label>
                <label>
                  <span>結束時間</span>
                  <input
                    type="text"
                    value={newEndTime}
                    onChange={(e) => setNewEndTime(e.target.value)}
                    placeholder="HH:mm"
                    aria-label="新增結束時間"
                  />
                </label>
              </>
            )}

            <button
              type="submit"
              className="btn-primary"
              style={{ alignSelf: 'flex-end' }}
            >
              確認新增
            </button>
          </div>
        </form>
      )}

      {/* 依頁籤分離渲染表格 */}
      <div
        role="tabpanel"
        id={`class-type-panel-${activeTypeTab}`}
        aria-labelledby={`class-type-tab-${activeTypeTab}`}
        className="scroll table-scroll-container schedule-table-scroll"
      >
        {activeTypeTab === 'care' ? (
          /* 1. 安親課輔班（6 欄） */
          <table className="schedule-table schedule-table-care">
            <thead>
              <tr>
                <th className="col-classname sticky-col sticky-corner">班級名稱</th>
                <th className="col-has-multi">是否有多科折扣</th>
                <th className="col-fixed-five">天數固定 5 天</th>
                <th className="col-teacher">帶班老師</th>
                <th className="col-status">狀態</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {displayedTabRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-row-text">
                    沒有符合篩選條件的安親課輔班。
                  </td>
                </tr>
              ) : (
                displayedTabRows.map((r, idx) => {
                  const className = r.className.trim();
                  const attr = classAttributes?.get(className);
                  const attrsDisabled = !classAttributes;

                  return (
                    <tr key={r.rowId} className="schedule-row class-group-start">
                      <td className="col-classname sticky-col">
                        <input
                          type="text"
                          className="input-classname"
                          value={r.className}
                          onChange={(e) => onUpdateRow(r.rowId, { className: e.target.value })}
                          aria-label={`班級名稱 第 ${idx + 1} 列`}
                        />
                      </td>
                      <td className="col-has-multi">
                        <YesNoRadioGroup
                          label={`${className} 的是否有多科折扣`}
                          name={`multi-${r.rowId}`}
                          value={attr?.hasMultiSubjectDiscount ?? true}
                          disabled={attrsDisabled}
                          onChange={(val) => onToggleMultiDiscount?.(className, val)}
                        />
                      </td>
                      <td className="col-fixed-five">
                        <YesNoRadioGroup
                          label={`${className} 的天數固定 5 天`}
                          name={`fixed-${r.rowId}`}
                          value={attr?.fixedFiveDays ?? false}
                          disabled={attrsDisabled}
                          onChange={(val) => onToggleFixedFiveDays?.(className, val)}
                        />
                      </td>
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
                      <td className="col-status">
                        <span className="ded-status" data-status="shared_window">
                          安親課輔班（不計時段）
                        </span>
                      </td>
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
        ) : activeTypeTab === 'unscheduled' ? (
          /* 5. 不排課班級（4 欄） */
          <table className="schedule-table schedule-table-unscheduled">
            <thead>
              <tr>
                <th className="col-classname sticky-col sticky-corner">班級名稱</th>
                <th className="col-teacher">帶班老師</th>
                <th className="col-status">狀態</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {displayedTabRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty-row-text">
                    沒有符合篩選條件的不排課班級。
                  </td>
                </tr>
              ) : (
                displayedTabRows.map((r, idx) => (
                  <tr key={r.rowId} className="schedule-row class-group-start">
                    <td className="col-classname sticky-col">
                      <input
                        type="text"
                        className="input-classname"
                        value={r.className}
                        onChange={(e) => onUpdateRow(r.rowId, { className: e.target.value })}
                        aria-label={`班級名稱 第 ${idx + 1} 列`}
                      />
                    </td>
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
                    <td className="col-status">
                      <span className="ded-status" data-status="unscheduled">
                        不排課
                      </span>
                    </td>
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
                ))
              )}
            </tbody>
          </table>
        ) : (
          /* 2, 3, 4. 排課類型（美語班 12 欄、數學班 12 欄、其他班 11 欄） */
          <table className={`schedule-table schedule-table-${activeTypeTab}`}>
            <thead>
              <tr>
                <th rowSpan={2} className="col-classname sticky-col sticky-corner">
                  班級名稱
                </th>
                {/* 其他班不出現多科折扣欄位 */}
                {activeTypeTab !== 'other' && (
                  <th rowSpan={2} className="col-has-multi">
                    是否有多科折扣
                  </th>
                )}
                <th rowSpan={2} className="col-skip-deduction">
                  不計扣天
                </th>
                <th rowSpan={2} className="col-teacher">
                  帶班老師
                </th>
                <th rowSpan={2} className="col-weekday">
                  星期
                </th>
                <th rowSpan={2} className="col-time">
                  上課時間
                  <br />
                  起 — 迄
                </th>
                <th rowSpan={2} className="col-duration number">
                  課程時長
                  <br />分
                </th>
                <th colSpan={2} className="col-group-anqin cblue">
                  安親窗口 (13:00–16:00)
                </th>
                <th colSpan={2} className="col-group-tutoring cteal">
                  課輔窗口 (16:30–19:30)
                </th>
                <th rowSpan={2} className="col-actions">
                  操作
                </th>
              </tr>
              <tr>
                <th className="number cblue">重疊／分</th>
                <th className="number cblue">扣除／天</th>
                <th className="number cteal">重疊／分</th>
                <th className="number cteal">扣除／天</th>
              </tr>
            </thead>
            <tbody>
              {displayedTabRows.length === 0 ? (
                <tr>
                  <td colSpan={activeTypeTab === 'other' ? 11 : 12} className="empty-row-text">
                    沒有符合篩選條件的{CLASS_TYPE_LABELS[activeTypeTab]}時段。
                  </td>
                </tr>
              ) : (
                displayedTabRows.map((r, idx) => {
                  const isFirstOfClass =
                    idx === 0 || displayedTabRows[idx - 1].className !== r.className;
                  const calcRow = resultMap.get(r.rowId);
                  const className = r.className.trim();
                  const attr = classAttributes?.get(className);
                  const attrsDisabled = !classAttributes;

                  const isTimeIncomplete =
                    r.startMinutes === null ||
                    r.endMinutes === null ||
                    r.endMinutes <= r.startMinutes;

                  const isInactive = !r.active || calcRow?.anqin.status === 'inactive';
                  const isSharedWindow = calcRow?.anqin.status === 'shared_window';
                  const isUnknownWeekday =
                    !isInactive && !isTimeIncomplete && (calcRow?.anqin.status === 'unknown_weekday' || r.weekday.trim() === '');

                  const missingWeekday = r.weekday.trim() === '';
                  const missingStart = r.startMinutes === null;
                  const missingEnd = r.endMinutes === null || (r.startMinutes !== null && r.endMinutes <= r.startMinutes);

                  const hasMulti = attr?.hasMultiSubjectDiscount ?? true;

                  return (
                    <tr
                      key={r.rowId}
                      className={`schedule-row ${isFirstOfClass ? 'class-group-start' : ''} ${
                        !r.active ? 'row-inactive' : ''
                      } ${isTimeIncomplete ? 'row-incomplete' : ''} ${isUnknownWeekday ? 'row-unknown-weekday' : ''}`}
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

                      {/* 2. 是否有多科折扣（僅 english, math；同班第 2 列起顯示靜態 ↳ 同本班） */}
                      {activeTypeTab !== 'other' && (
                        <td className="col-has-multi">
                          {isFirstOfClass ? (
                            <YesNoRadioGroup
                              label={`${className} 的是否有多科折扣`}
                              name={`multi-${className}`}
                              value={hasMulti}
                              disabled={attrsDisabled}
                              onChange={(val) => onToggleMultiDiscount?.(className, val)}
                            />
                          ) : (
                            <span className="same-class-marker">↳ 同本班（{hasMulti ? '是' : '否'}）</span>
                          )}
                        </td>
                      )}

                      {/* 3. 不計扣天（逐時段） */}
                      <td className="col-skip-deduction">
                        <YesNoRadioGroup
                          label={`${r.className} 第 ${idx + 1} 列的不計扣天`}
                          name={`skip-${r.rowId}`}
                          value={r.skipDeduction ?? (activeTypeTab === 'other')}
                          onChange={(val) => onUpdateRow(r.rowId, { skipDeduction: val })}
                        />
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

                      {/* 5. 星期（待補時套用 .input-missing） */}
                      <td className="col-weekday">
                        <input
                          type="text"
                          className={`input-weekday ${missingWeekday ? 'input-missing' : ''}`}
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
                            className={`input-time ${missingStart ? 'input-missing' : ''}`}
                            placeholder="HH:mm"
                            value={r.startTime}
                            onChange={(e) => onUpdateRow(r.rowId, { startTime: e.target.value })}
                            aria-label={`起始時間 第 ${idx + 1} 列`}
                          />
                          <span className="time-separator">—</span>
                          <input
                            type="text"
                            className={`input-time ${missingEnd ? 'input-missing' : ''}`}
                            placeholder="HH:mm"
                            value={r.endTime}
                            onChange={(e) => onUpdateRow(r.rowId, { endTime: e.target.value })}
                            aria-label={`結束時間 第 ${idx + 1} 列`}
                          />
                        </div>
                      </td>

                      {/* 7. 課程時長（未填時間顯示高對比「待補時間」徽章 1c） */}
                      <td className="col-duration number" data-calc="duration">
                        {isTimeIncomplete ? (
                          <span
                            className="badge-incomplete"
                            tabIndex={0}
                            aria-label="待補時間：此列尚未填妥上課時間"
                          >
                            待補時間
                          </span>
                        ) : isInactive ? (
                          <span className="subtle">停用</span>
                        ) : (
                          calcRow?.durationMinutes ?? '—'
                        )}
                      </td>

                      {/* 8. 安親 重疊／分 */}
                      <td className="number cblue" data-calc="anqin-overlap">
                        {isTimeIncomplete ? (
                          <span className="subtle">—</span>
                        ) : isInactive ? (
                          <span className="subtle">—</span>
                        ) : isSharedWindow ? (
                          <span className="subtle">不計時段</span>
                        ) : isUnknownWeekday ? (
                          <NeedsReviewBadge reasons={issuesMap.get(r.rowId) ?? []} />
                        ) : (
                          calcRow?.anqin.overlapMinutes ?? '—'
                        )}
                      </td>

                      {/* 9. 安親 扣除／天 */}
                      <td className="number cblue" data-calc="anqin-deduction">
                        {isTimeIncomplete ? (
                          <span className="subtle">—</span>
                        ) : isInactive ? (
                          <span className="subtle">—</span>
                        ) : isSharedWindow ? (
                          <span className="subtle">—</span>
                        ) : isUnknownWeekday ? (
                          <NeedsReviewBadge reasons={issuesMap.get(r.rowId) ?? []} />
                        ) : calcRow?.anqin.status === 'no_deduction' ? (
                          <span className="subtle">不計扣天</span>
                        ) : (
                          formatDeductionDays(calcRow?.anqin.rawDeduction)
                        )}
                      </td>

                      {/* 10. 課輔 重疊／分 */}
                      <td className="number cteal" data-calc="tutoring-overlap">
                        {isTimeIncomplete ? (
                          <span className="subtle">—</span>
                        ) : isInactive ? (
                          <span className="subtle">—</span>
                        ) : isSharedWindow ? (
                          <span className="subtle">不計時段</span>
                        ) : isUnknownWeekday ? (
                          <NeedsReviewBadge reasons={issuesMap.get(r.rowId) ?? []} />
                        ) : (
                          calcRow?.tutoring.overlapMinutes ?? '—'
                        )}
                      </td>

                      {/* 11. 課輔 扣除／天 */}
                      <td className="number cteal" data-calc="tutoring-deduction">
                        {isTimeIncomplete ? (
                          <span className="subtle">—</span>
                        ) : isInactive ? (
                          <span className="subtle">—</span>
                        ) : isSharedWindow ? (
                          <span className="subtle">—</span>
                        ) : isUnknownWeekday ? (
                          <NeedsReviewBadge reasons={issuesMap.get(r.rowId) ?? []} />
                        ) : calcRow?.tutoring.status === 'no_deduction' ? (
                          <span className="subtle">不計扣天</span>
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
        )}
      </div>

      {/* 全量／篩選統計在表格捲動區外，並保留 D39 白話規則。 */}
      <div className="tablefoot">
        <div className="schedule-count-summary" aria-live="polite">
          <span className="note count-summary">
            {isSchedulableTab
              ? `共 ${currentTabClassCount} 個班級 · ${currentTabRowCount} 個時段`
              : `共 ${currentTabClassCount} 個班級`}
          </span>
          {focusActive ? (
            <span className="note count-filter-summary">
              目前只顯示「{focus}」班{isSchedulableTab ? ` · ${displayedTabRows.length} 個時段` : ''}
            </span>
          ) : (hasSearchFilter || hasWeekdayFilter) ? (
            <span className="note count-filter-summary">
              {isSchedulableTab
                ? `目前顯示 ${displayedTabClassCount} 個班級 · ${displayedTabRows.length} 個時段`
                : `目前顯示 ${displayedTabClassCount} 個班級`}
            </span>
          ) : null}
        </div>
        <span className="note">
          整班重疊加總後，不足 0.3 天不扣、0.3～0.8 天扣半天、0.8 天以上扣 1 天。
        </span>
      </div>
    </div>
  );
}

export default ScheduleGrid;

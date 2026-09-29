'use client';

import React, { useState, useMemo } from 'react';
import { ScheduleGridRow } from '@/contracts/settings';
import { CalculatePreviewResponse } from '@/application/schedule-preview';
import { InfoTip } from '@/components/ui/info-tip';

interface ScheduleGridProps {
  rows: ScheduleGridRow[];
  onUpdateRow: (rowId: string, updates: Partial<ScheduleGridRow>) => void;
  onDeleteRow: (rowId: string) => void;
  onAddRow: (row: Omit<ScheduleGridRow, 'rowId'>) => void;
  calculating: boolean;
  calculateResult: CalculatePreviewResponse | null;
}

export function formatDeductionDays(val: number | null | undefined): string {
  if (val === null || val === undefined) return '—';
  const pos = Math.abs(val);
  if (pos === 0) return '0';
  const rounded = Number(pos.toFixed(3));
  return String(rounded);
}

/**
 * 「待補」標示：該欄因時段不完整而無法計算。原因（例如缺起訖時間）用可 hover／focus／click 開啟的 tooltip 呈現，
 * 不只靠 title（09 §6：阻擋錯誤與需確認後果不可只藏 hover；鍵盤也要能讀到）。
 */
function IncompleteBadge({ issues }: { issues: string[] }) {
  const badge = <span className="badge-incomplete">待補</span>;
  if (issues.length === 0) return badge;
  return (
    <InfoTip label="待補原因" trigger={badge} variant="plain">
      {issues.join('；')}
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
}: ScheduleGridProps) {
  const [search, setSearch] = useState('');
  const [weekdayFilter, setWeekdayFilter] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  // 新增時段表單狀態
  const [newClassName, setNewClassName] = useState('');
  const [newTeacher, setNewTeacher] = useState('');
  const [newWeekday, setNewWeekday] = useState('一');
  const [newStartTime, setNewStartTime] = useState('13:00');
  const [newEndTime, setNewEndTime] = useState('15:00');

  // 將 calculateResult.rows 建立以 rowId 為鍵的快速查詢表
  const resultMap = useMemo(() => {
    if (!calculateResult?.rows) return new Map();
    return new Map(calculateResult.rows.map((r) => [r.rowId, r]));
  }, [calculateResult]);

  // issues 以 rowId 為鍵的快速查詢表
  const issuesMap = useMemo(() => {
    if (!calculateResult?.issues) return new Map();
    const map = new Map<string, string[]>();
    for (const issue of calculateResult.issues) {
      if (issue.rowId) {
        const arr = map.get(issue.rowId) ?? [];
        arr.push(issue.message);
        map.set(issue.rowId, arr);
      }
    }
    return map;
  }, [calculateResult]);

  // 篩選時段列
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      const matchSearch = search.trim() === '' || r.className.includes(search.trim());
      const matchWeekday = weekdayFilter === '' || r.weekday === weekdayFilter;
      return matchSearch && matchWeekday;
    });
  }, [rows, search, weekdayFilter]);

  // 統計班級與時段數量
  const uniqueClassesCount = useMemo(() => {
    return new Set(filteredRows.map((r) => r.className.trim()).filter(Boolean)).size;
  }, [filteredRows]);

  const handleCreateSession = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newClassName.trim();
    if (!name) return;

    onAddRow({
      className: name,
      teacher: newTeacher.trim() || null,
      weekday: newWeekday,
      startTime: newStartTime,
      endTime: newEndTime,
      startMinutes: null,
      endMinutes: null,
      active: true,
    });

    setNewClassName('');
    setNewTeacher('');
    setShowAddForm(false);
  };

  return (
    <div className="card schedule-grid-container">
      {/* 搜尋與篩選工具列 */}
      <div className="toolbar">
        <input
          type="text"
          className="search"
          placeholder="搜尋班級名稱..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="搜尋課表班級"
        />
        <select
          value={weekdayFilter}
          onChange={(e) => setWeekdayFilter(e.target.value)}
          aria-label="課表星期篩選"
        >
          <option value="">全部星期</option>
          <option value="一">週一</option>
          <option value="二">週二</option>
          <option value="三">週三</option>
          <option value="四">週四</option>
          <option value="五">週五</option>
          <option value="六">週六</option>
          <option value="日">週日</option>
        </select>

        <span className="note count-summary">
          {uniqueClassesCount} 個班級 · {filteredRows.length} 個時段
          {calculating && <span className="calculating-indicator"> · 計算中...</span>}
        </span>

        <button
          type="button"
          className="btn-primary end"
          onClick={() => setShowAddForm((prev) => !prev)}
        >
          {showAddForm ? '取消新增' : '＋ 新增時段'}
        </button>
      </div>

      {/* 新增時段內嵌表單 */}
      {showAddForm && (
        <form onSubmit={handleCreateSession} className="add-session-panel" aria-label="新增時段表單">
          <div className="form-row">
            <label>
              <span>班級名稱 *</span>
              <input
                type="text"
                required
                placeholder="例如：國小數學-一A"
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
              />
            </label>
            <label>
              <span>帶班老師</span>
              <input
                type="text"
                placeholder="老師姓名"
                value={newTeacher}
                onChange={(e) => setNewTeacher(e.target.value)}
              />
            </label>
            <label>
              <span>星期</span>
              <select value={newWeekday} onChange={(e) => setNewWeekday(e.target.value)}>
                <option value="一">週一</option>
                <option value="二">週二</option>
                <option value="三">週三</option>
                <option value="四">週四</option>
                <option value="五">週五</option>
                <option value="六">週六</option>
                <option value="日">週日</option>
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
            <div className="form-actions">
              <button type="submit" className="btn-primary">確認新增</button>
            </div>
          </div>
        </form>
      )}

      {/* 平鋪排課表格 */}
      <div className="scroll table-scroll-container">
        <table className="schedule-table">
          <thead>
            <tr>
              <th rowSpan={2} className="col-classname sticky-col">班級名稱</th>
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
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-row-text">
                  沒有符合篩選條件的課表時段。
                </td>
              </tr>
            ) : (
              filteredRows.map((r, idx) => {
                const isFirstOfClass =
                  idx === 0 || filteredRows[idx - 1].className !== r.className;
                const calcRow = resultMap.get(r.rowId);
                const rowIssues = issuesMap.get(r.rowId) ?? [];

                // 判斷該列是否為不完整列
                const isIncomplete =
                  r.startMinutes === null ||
                  r.endMinutes === null ||
                  r.endMinutes <= r.startMinutes ||
                  calcRow?.anqin.status === 'missing_time';

                const isInactive = !r.active || calcRow?.anqin.status === 'inactive';
                const isSharedWindow = calcRow?.anqin.status === 'shared_window';
                const isUnknownWeekday = calcRow?.anqin.status === 'unknown_weekday';

                return (
                  <tr
                    key={r.rowId}
                    className={`schedule-row ${isFirstOfClass ? 'class-group-start' : ''} ${
                      !r.active ? 'row-inactive' : ''
                    } ${isIncomplete ? 'row-incomplete' : ''}`}
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

                    {/* 2. 帶班老師 */}
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

                    {/* 3. 星期 */}
                    <td className="col-weekday">
                      <input
                        type="text"
                        className="input-weekday"
                        value={r.weekday}
                        onChange={(e) => onUpdateRow(r.rowId, { weekday: e.target.value })}
                        aria-label={`星期 第 ${idx + 1} 列`}
                      />
                    </td>

                    {/* 4. 上課時間 (起 — 迄) */}
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

                    {/* 5. 課程時長 分 */}
                    <td className="col-duration number">
                      {isIncomplete ? (
                        <IncompleteBadge issues={rowIssues} />
                      ) : isInactive ? (
                        <span className="subtle">停用</span>
                      ) : (
                        calcRow?.durationMinutes ?? '—'
                      )}
                    </td>

                    {/* 6. 安親 重疊／分 */}
                    <td className="number cblue">
                      {isIncomplete ? (
                        <IncompleteBadge issues={rowIssues} />
                      ) : isInactive ? (
                        <span className="subtle">—</span>
                      ) : isSharedWindow ? (
                        <span className="subtle">共用</span>
                      ) : (
                        calcRow?.anqin.overlapMinutes ?? 0
                      )}
                    </td>

                    {/* 7. 安親 扣除／天 */}
                    <td className="number cblue">
                      {isIncomplete ? (
                        <IncompleteBadge issues={rowIssues} />
                      ) : isInactive ? (
                        <span className="subtle">—</span>
                      ) : isSharedWindow ? (
                        <span className="subtle">共用</span>
                      ) : (
                        formatDeductionDays(calcRow?.anqin.rawDeduction)
                      )}
                    </td>

                    {/* 8. 課輔 重疊／分 */}
                    <td className="number cteal">
                      {isIncomplete ? (
                        <IncompleteBadge issues={rowIssues} />
                      ) : isInactive ? (
                        <span className="subtle">—</span>
                      ) : isSharedWindow ? (
                        <span className="subtle">共用</span>
                      ) : (
                        calcRow?.tutoring.overlapMinutes ?? 0
                      )}
                    </td>

                    {/* 9. 課輔 扣除／天 */}
                    <td className="number cteal">
                      {isIncomplete ? (
                        <IncompleteBadge issues={rowIssues} />
                      ) : isInactive ? (
                        <span className="subtle">—</span>
                      ) : isSharedWindow ? (
                        <span className="subtle">共用</span>
                      ) : (
                        formatDeductionDays(calcRow?.tutoring.rawDeduction)
                      )}
                    </td>

                    {/* 10. 操作 */}
                    <td className="col-actions">
                      <button
                        type="button"
                        className="btn-danger-icon"
                        title="刪除此時段"
                        onClick={() => onDeleteRow(r.rowId)}
                        aria-label={`刪除時段 ${r.className}`}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="tablefoot">
        <span className="note">
          扣除欄為單堂未取整數值（以正量顯示）。整班扣除天數採同班先合計再取整（D24）。
        </span>
      </div>
    </div>
  );
}
export default ScheduleGrid;

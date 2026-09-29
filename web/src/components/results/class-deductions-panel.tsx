'use client';

import React, { useState } from 'react';
import { DeductionsResponse } from '@/application/schedule-deductions';
import { PreviewClass, PreviewRow } from '@/application/schedule-preview';

/**
 * 班級扣天（09 §5.2，對應 Excel C表）。
 *
 * 欄位：班級、老師、上課時間摘要、安親原始扣除、安親實際扣除、課輔原始扣除、課輔實際扣除、狀態。
 * 四個扣除欄單位天、**正量顯示**（domain 為負值不改，這裡只改顯示）；原始三位小數、
 * 實際依 domain 先整班相加再取整（D24）。狀態區分「無重疊／共用窗口／待補／需確認」，
 * 不混為同一種。
 *
 * 有 active run 時與學生總表讀同一份快照（scope=active_run）；無 active 時讀已儲存課表並
 * 標「尚未匯入學生，可先檢查扣天」——不得宣告帳單已對帳正確。
 */

export const classDeductionsColumns = [
  '班級',
  '老師',
  '上課時間',
  '安親原始扣除',
  '安親實際扣除',
  '課輔原始扣除',
  '課輔實際扣除',
  '狀態',
] as const;

/** 扣除值 → 正量字串；原始三位小數、實際半天單位。domain 負值在此轉為正量顯示。 */
export function formatDeduction(v: number | null, digits: 0 | 3): string {
  if (v === null) return '—';
  const pos = Math.abs(v);
  return digits === 3 ? pos.toFixed(3) : String(pos);
}

/** 上課時間摘要：每堂一行「星期 HH:mm–HH:mm」，無時段顯「待補」。 */
function scheduleSummary(rows: PreviewRow[], rowIds: string[]): string {
  const own = rows.filter((r) => rowIds.includes(r.rowId));
  const lines = own.map((r) => {
    if (r.startMinutes === null || r.endMinutes === null) {
      return `${r.weekday ?? '—'} 待補`;
    }
    const m = (v: number) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
    return `${r.weekday ?? '—'} ${m(r.startMinutes)}–${m(r.endMinutes)}`;
  });
  return lines.length > 0 ? lines.join('、') : '待補';
}

/** 班級狀態短標：無重疊／共用窗口／待補／需確認／已計算分開。 */
function statusLabel(c: PreviewClass): string {
  const s = c.anqin.status;
  if (s === 'inactive') return '停用';
  if (s === 'shared_window') return '共用窗口';
  if (s === 'missing_time') return '待補';
  if (s === 'incomplete') return '待補';
  if (s === 'unknown_weekday') return '需確認';
  if (s === 'no_overlap') return '無重疊';
  return '已計算';
}

interface ClassDeductionsPanelProps {
  data: DeductionsResponse;
  onEditClass: (classKey: string) => void;
  expandedClassKey?: string;
}

export function ClassDeductionsPanel({ data, onEditClass, expandedClassKey }: ClassDeductionsPanelProps) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(expandedClassKey ?? null);

  const classes = data.classes.filter((c) =>
    search.trim() === '' || c.classKey.includes(search.trim()) || (c.teacher ?? '').includes(search.trim())
  );

  return (
    <section className="class-deductions" aria-label="班級扣天">
      {data.scope === 'seed' || data.scope === 'saved_settings' ? (
        <p className="notice-inline">尚未匯入學生，可先檢查扣天。這裡只顯示課表計算結果，不代表帳單已核對。</p>
      ) : null}

      <div className="toolbar">
        <input
          type="text"
          className="search"
          placeholder="搜尋班級或老師..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="搜尋班級或老師"
        />
        <span className="note end">共 {classes.length} 個班級 · 每班扣除天數</span>
      </div>

      <div className="table-scroll">
        <table className="data-table deductions-table">
          <thead>
            <tr>
              {classDeductionsColumns.map((c, i) => (
                <th key={c} className={i >= 3 && i <= 6 ? 'number cblue' : undefined}>
                  {c}
                  {i >= 3 && i <= 6 ? <span className="th-unit">天</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {classes.map((c) => {
              const isOpen = expanded === c.classKey;
              const own = data.rows.filter((r) => c.rowIds.includes(r.rowId));
              return (
                <React.Fragment key={c.classKey}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setExpanded(isOpen ? null : c.classKey)}
                        aria-expanded={isOpen}
                      >
                        {c.classKey} {isOpen ? '⌃' : '⌄'}
                      </button>
                    </td>
                    <td>{c.teacher ?? '—'}</td>
                    <td style={{ fontSize: '0.75rem' }}>{scheduleSummary(data.rows, c.rowIds)}</td>
                    <td className="number cblue">{formatDeduction(c.anqin.raw, 3)}</td>
                    <td className="number cblue">{formatDeduction(c.anqin.rounded, 0)}</td>
                    <td className="number cblue">{formatDeduction(c.tutoring.raw, 3)}</td>
                    <td className="number cblue">{formatDeduction(c.tutoring.rounded, 0)}</td>
                    <td>
                      <span className="ded-status" data-status={c.anqin.status}>
                        {statusLabel(c)}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="ded-expanded">
                      <td colSpan={8}>
                        <div className="ded-detail">
                          <div className="ded-detail-head">
                            <span>全部時段與逐堂計算</span>
                            <button type="button" className="link-button" onClick={() => onEditClass(c.classKey)}>
                              編輯此班課表 →
                            </button>
                          </div>
                          <table className="ded-session-table">
                            <thead>
                              <tr>
                                <th>星期</th>
                                <th>上課時間</th>
                                <th className="number">課程時長</th>
                                <th className="number cblue">安親重疊／分</th>
                                <th className="number cblue">安親扣除／天</th>
                                <th className="number cblue">課輔重疊／分</th>
                                <th className="number cblue">課輔扣除／天</th>
                              </tr>
                            </thead>
                            <tbody>
                              {own.map((r) => (
                                <tr key={r.rowId}>
                                  <td>{r.weekday ?? '—'}</td>
                                  <td>
                                    {r.startMinutes === null || r.endMinutes === null
                                      ? '待補'
                                      : `${String(Math.floor(r.startMinutes / 60)).padStart(2, '0')}:${String(r.startMinutes % 60).padStart(2, '0')}–${String(Math.floor(r.endMinutes / 60)).padStart(2, '0')}:${String(r.endMinutes % 60).padStart(2, '0')}`}
                                  </td>
                                  <td className="number">{r.durationMinutes ?? '—'}</td>
                                  <td className="number cblue">{r.anqin.overlapMinutes ?? '—'}</td>
                                  <td className="number cblue">{formatDeduction(r.anqin.rawDeduction, 3)}</td>
                                  <td className="number cblue">{r.tutoring.overlapMinutes ?? '—'}</td>
                                  <td className="number cblue">{formatDeduction(r.tutoring.rawDeduction, 3)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
export default ClassDeductionsPanel;

'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { DeductionsResponse } from '@/application/schedule-deductions';
import { PreviewClass, PreviewRow, PreviewRowGroup } from '@/application/schedule-preview';
import { CareStatus, combineCareStatuses } from '@/application/care-status';
import { HeaderFilter, FilterChips, type FilterSection, type ChipItem } from '@/components/filters/header-filter';
import {
  BLANK,
  DEDUCTION_FILTER_FIELDS,
  NONE,
  chipsOf,
  escapeLiteral,
  hasAnySelection,
  type DeductionFilterKey,
  type DeductionFilters,
} from '@/lib/results-filters';

/**
 * 班級扣天（09 §5.2，對應 Excel C表）。
 *
 * 欄位：班級、老師、上課時間摘要、安親原始扣除、安親實際扣除、課輔原始扣除、課輔實際扣除、狀態。
 * 四個扣除欄單位天、**正量顯示**（domain 為負值不改，這裡只改顯示）；原始三位小數、
 * 實際依 domain 先整班相加再取整（D24）。狀態區分「無重疊／共用窗口／待補／需確認」，
 * 不混為同一種。
 *
 * 班級／老師／狀態三欄使用與學生總表同一個表頭篩選元件（D36），選項取自整個 run 的全部班級列；
 * 條件與學生總表各自獨立、各自保留（F03）。
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

/** 上課時間摘要：每堂一行「星期 HH:mm–HH:mm」，安親課輔班與不排課班顯「—」，排課班無時段顯「待補」。 */
function scheduleSummary(rows: PreviewRow[], rowIds: string[], status?: CareStatus): string {
  if (status === 'shared_window' || status === 'unscheduled') {
    return '—';
  }
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

/**
 * 整班狀態：安親與課輔兩側合併（未知／不完整＞已計算＞無重疊；F02）。
 * 只看安親側會讓「只與課輔窗口重疊」的班顯示成「無重疊」，未知／不完整也可能被另一側掩蓋。
 */
export function classStatus(c: PreviewClass): CareStatus {
  return combineCareStatuses(c.anqin.status, c.tutoring.status);
}

/** 逐堂列某一側的（重疊分鐘、原始扣除）兩格：星期未知的列顯示「需確認」，不冒充 0（09 §3.1）。 */
function sideCells(g: PreviewRowGroup): [React.ReactNode, React.ReactNode] {
  if (g.status === 'unknown_weekday') return ['需確認', '需確認'];
  return [g.overlapMinutes ?? '—', formatDeduction(g.rawDeduction, 3)];
}

/** 班級狀態短標：無重疊／安親課輔班（不計時段）／不排課／待補／需確認／已計算分開。 */
function statusLabel(s: CareStatus): string {
  if (s === 'inactive') return '停用';
  if (s === 'shared_window') return '安親課輔班（不計時段）';
  if (s === 'unscheduled') return '不排課';
  if (s === 'missing_time') return '待補';
  if (s === 'incomplete') return '待補';
  if (s === 'unknown_weekday') return '需確認';
  // #113：勾選「不計扣天」是一種刻意的政策結果，不是「算不出來」，因此不併入「無重疊」。
  if (s === 'no_deduction') return '不計扣天';
  if (s === 'no_overlap') return '無重疊';
  return '已計算';
}

interface ClassDeductionsPanelProps {
  data?: DeductionsResponse;
  onEditClass: (classKey: string) => void;
  expandedClassKey?: string;
  /**
   * 歷史 run 的課表快照不存在（或屬診斷軌）時的說明（09 §5.2）：
   * 明示資料不足、無法重建，不顯示任何表格或數字，也不改用最新設定補算。
   */
  unavailable?: { code: string; message: string };
  /** 班級／老師／狀態的表頭篩選條件（由頁面保存，切頁籤再回來仍在）；未提供＝不篩選 */
  filters?: DeductionFilters;
  onFiltersChange?: (next: DeductionFilters) => void;
}

const wireOf = (v: string | null | undefined): string => (v === null || v === undefined || v === '' ? BLANK : escapeLiteral(v));

export function ClassDeductionsPanel({ data, onEditClass, expandedClassKey, unavailable, filters = {}, onFiltersChange }: ClassDeductionsPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(expandedClassKey ?? null);

  const rowsWithFacets = useMemo(
    () =>
      (data?.classes ?? []).map((c) => ({
        c,
        facets: { dClass: wireOf(c.classKey), dTeacher: wireOf(c.teacher), dStatus: escapeLiteral(statusLabel(classStatus(c))) },
      })),
    [data]
  );

  if (unavailable || !data) {
    return (
      <section className="class-deductions" aria-label="班級扣天">
        <div className="state-card" role="status">
          <h3 className="state-title">這筆歷史資料無法顯示班級扣天</h3>
          <p className="state-desc">{unavailable?.message}</p>
          <Link href="/history" className="btn-secondary">回到匯入紀錄</Link>
        </div>
      </section>
    );
  }

  // 選項取自整個 run 的全部班級列（不受目前條件收斂）
  const optionsOf = (key: DeductionFilterKey): FilterSection => {
    const map = new Map<string, string>();
    for (const { facets, c } of rowsWithFacets) {
      const wire = facets[key];
      const label = wire === BLANK ? '(空白)' : key === 'dClass' ? c.classKey : key === 'dTeacher' ? (c.teacher ?? '') : statusLabel(classStatus(c));
      if (!map.has(wire)) map.set(wire, label);
    }
    const options = [...map].map(([value, label]) => ({ value, label }));
    options.sort((a, b) => (a.value === BLANK ? -1 : b.value === BLANK ? 1 : a.label.localeCompare(b.label, 'zh-Hant')));
    return { key, options };
  };

  const matches = (facets: Record<DeductionFilterKey, string>): boolean =>
    DEDUCTION_FILTER_FIELDS.every((f) => {
      const wires = filters[f.key];
      if (!wires || wires.length === 0) return true;
      if (wires[0] === NONE) return false;
      return wires.includes(facets[f.key]);
    });

  const classes = rowsWithFacets.filter((r) => matches(r.facets)).map((r) => r.c);

  const apply = (next: DeductionFilters) => {
    const merged: DeductionFilters = {};
    for (const [k, v] of Object.entries(next)) {
      if (v && v.length > 0) merged[k as DeductionFilterKey] = v;
    }
    onFiltersChange?.(merged);
  };

  const filterFor = (key: DeductionFilterKey, column: string) =>
    onFiltersChange ? (
      <HeaderFilter column={column} sections={[optionsOf(key)]} value={{ [key]: filters[key] }} onApply={(next) => apply({ ...filters, ...next })} />
    ) : null;

  const chipItems: ChipItem[] = chipsOf(filters, DEDUCTION_FILTER_FIELDS).map((c) => ({
    id: `${c.key}:${c.label}`,
    column: c.column,
    label: c.label,
    onRemove: () => apply({ ...filters, [c.key]: c.remaining.length > 0 ? c.remaining : undefined }),
  }));

  return (
    <section className="class-deductions" aria-label="班級扣天">
      {data.scope === 'seed' || data.scope === 'saved_settings' ? (
        <p className="notice-inline">尚未匯入學生，可先檢查扣天。這裡只顯示課表計算結果，不代表帳單已核對。</p>
      ) : null}

      <div className="results-filterbar">
        <FilterChips items={chipItems} onClearAll={() => apply({})} />
        <span className="note end">
          共 {classes.length} 個班級 · 每班扣除天數{hasAnySelection(filters) ? `（全部 ${rowsWithFacets.length} 個班級）` : ''}
        </span>
      </div>

      <div className="table-scroll">
        <table className="data-table deductions-table">
          <thead>
            <tr>
              {classDeductionsColumns.map((c, i) => (
                <th key={c} className={i >= 3 && i <= 6 ? 'number cblue' : undefined}>
                  {c}
                  {i >= 3 && i <= 6 ? <span className="th-unit">天</span> : null}
                  {c === '班級' ? filterFor('dClass', '班級') : null}
                  {c === '老師' ? filterFor('dTeacher', '老師') : null}
                  {c === '狀態' ? filterFor('dStatus', '狀態') : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {classes.length === 0 && (
              <tr>
                <td colSpan={8} className="empty-row-text">沒有符合條件的班級。</td>
              </tr>
            )}
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
                    <td style={{ fontSize: '0.75rem' }}>{scheduleSummary(data.rows, c.rowIds, classStatus(c))}</td>
                    <td className="number cblue">{formatDeduction(c.anqin.raw, 3)}</td>
                    <td className="number cblue">{formatDeduction(c.anqin.rounded, 0)}</td>
                    <td className="number cblue">{formatDeduction(c.tutoring.raw, 3)}</td>
                    <td className="number cblue">{formatDeduction(c.tutoring.rounded, 0)}</td>
                    <td>
                      <span className="ded-status" data-status={classStatus(c)}>
                        {statusLabel(classStatus(c))}
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
                                  <td className="number cblue">{sideCells(r.anqin)[0]}</td>
                                  <td className="number cblue">{sideCells(r.anqin)[1]}</td>
                                  <td className="number cblue">{sideCells(r.tutoring)[0]}</td>
                                  <td className="number cblue">{sideCells(r.tutoring)[1]}</td>
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

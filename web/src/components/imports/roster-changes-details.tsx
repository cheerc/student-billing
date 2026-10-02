import React from 'react';
import type { RosterChange, ClassBreakdown } from '@/application/roster-changes';

/**
 * 匯入預覽的逐人異動明細（specs/09 §4；operator 裁決 d-20260929111803466480-4／-5）。
 *
 * 只呈現 API 已用 before/after 計算結果判定好的資料，畫面不自行推導折扣或天數。
 * 「—」＝該側沒有值（沒有此課、不計入、課表無時段…），不等於 0 或 100%。
 */

const fmtDays = (v: number | null): string => (v === null ? '不適用' : String(v));

/** 學生層 before → after；兩側相同顯示「不變」。 */
function daysCell(before: number | null, after: number | null): string {
  return before === after ? '不變' : `${fmtDays(before)} → ${fmtDays(after)}`;
}

const RATE_COURSE_LABEL: Record<'anqin' | 'tutoring', string> = { anqin: '安親', tutoring: '課輔' };

const STATUS_LABEL: Record<string, string> = {
  not_counted: '不計入',
  no_enrollment: '—',
  schedule_empty: '課表無時段',
  schedule_not_found: '課表找不到',
};

/** 單班單側扣天：有值顯示「扣N天」，沒有值說明原因而不是寫 0。 */
function deductionText(v: number | null, status: string): string {
  if (v !== null) return `扣 ${v} 天`;
  return STATUS_LABEL[status] ?? '—';
}

const PRESENCE_LABEL: Record<ClassBreakdown['presence'], string> = {
  removed: '退掉',
  added: '新報',
  kept: '保留',
};

function categoryOf(c: RosterChange): { key: string; label: string } {
  if (c.isNew) return { key: 'new', label: '新增' };
  if (c.isRemoved) return { key: 'not-appeared', label: '未出現' };
  return { key: 'changed', label: '異動' };
}

function BreakdownList({ rows }: { rows: ClassBreakdown[] }) {
  return (
    <ul className="roster-change-classes">
      {rows.map((r) => (
        <li key={r.rawToken} data-presence={r.presence}>
          <span className="roster-change-class-name">{r.baseName}</span>
          <span className={`roster-change-presence presence-${r.presence}`}>{PRESENCE_LABEL[r.presence]}</span>
          <span className="roster-change-class-values">
            {`安親 ${deductionText(r.beforeAnqinDeduction, r.statusBefore)} → ${deductionText(r.afterAnqinDeduction, r.statusAfter)}；` +
              `課輔 ${deductionText(r.beforeTutoringDeduction, r.statusBefore)} → ${deductionText(r.afterTutoringDeduction, r.statusAfter)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RosterChangesDetails({ changes }: { changes: RosterChange[] }) {
  if (changes.length === 0) return null;
  return (
    <details className="roster-changes-details">
      <summary>{`查看逐人明細（${changes.length} 人）`}</summary>
      <div className="roster-changes-scroll">
        <table className="roster-changes-table">
          <thead>
            <tr>
              <th>學生</th>
              <th>類別</th>
              <th>折扣</th>
              <th>適用率</th>
              <th>安親天數</th>
              <th>課輔天數</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const cat = categoryOf(c);
              return (
                <React.Fragment key={`${cat.key}-${c.personCode}`}>
                  <tr data-category={cat.key}>
                    <td>
                      <span className="roster-change-name">{c.name}</span>{' '}
                      <span className="roster-change-code">{c.personCode}</span>
                    </td>
                    <td>{cat.label}</td>
                    <td data-field="discount">
                      {c.discountChange ? `${c.discountChange.beforeLabel} → ${c.discountChange.afterLabel}` : '—'}
                    </td>
                    <td data-field="rate">
                      {c.rateChange
                        ? c.rateChange.items.map((i) => (
                            <div key={i.course} data-rate={i.course}>
                              {`${RATE_COURSE_LABEL[i.course]} ${i.beforeLabel} → ${i.afterLabel}`}
                            </div>
                          ))
                        : '—'}
                    </td>
                    <td data-field="anqin-days">
                      {c.dayChange ? daysCell(c.dayChange.beforeAnqinDays, c.dayChange.afterAnqinDays) : '—'}
                    </td>
                    <td data-field="tutoring-days">
                      {c.dayChange ? daysCell(c.dayChange.beforeTutoringDays, c.dayChange.afterTutoringDays) : '—'}
                    </td>
                    <td>{c.reasons.join('、')}</td>
                  </tr>
                  {c.dayChange && c.dayChange.classBreakdown.length > 0 && (
                    <tr className="roster-change-breakdown">
                      <td colSpan={7}>
                        <BreakdownList rows={c.dayChange.classBreakdown} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

'use client';

import React from 'react';
import { StudentCalculationItem } from '@/application/query-students';
import { formatDiscountBps } from '@/application/roster-changes';
import { parseTagDiscounts } from '@/domain/billing/discount-rules';
import { InfoTip } from './ui/info-tip';

/**
 * 學生總表（09 §5.1）。
 *
 * 預設欄位固定為 12 欄（SPEC 所列）；人員代碼、美語／數學／中文天數、寫功課等既有欄
 * **位移**到欄位選擇與明細，**不刪功能**（學生資料仍完整攜帶，明細抽屜可查）。
 *
 * 型別不混（UX14）：0（適用但無扣天）、null（非適用／無法判定）、未設定（未配置）
 * 三者分開顯示，未配置絕不當成 100%。
 *
 * 徽章只呈警告，不堆綠色、不宣告帳單已對帳正確；徽章不得硬寫筆數（09 §7：
 * 「預期N人」只屬 fixture，實際筆數由查詢結果回填）。
 */

/** 預設欄位（順序即規格順序；匯入此表以維持欄位定義唯一來源）。 */
export const STUDENT_TABLE_COLUMNS = [
  '姓名',
  '年級',
  '所屬班級',
  '安親天數',
  '課輔天數',
  '額外扣天',
  '合計折扣',
  '已補科數',
  '兄弟姊妹折扣',
  '特殊折扣',
  '園內生',
  '需確認',
] as const;

/** 合計折扣＝基本率收取率短標（與異動判準共用同一格式化，短標一致）。 */
export function formatBaseDiscount(bps: number | null): string {
  return formatDiscountBps(bps);
}

/** 數值欄：null＝非適用／無法判定，顯示「—」而非 0（UX14 型別不混）。 */
function num(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return String(v);
}

/** 折扣率欄：null＝未配置，顯示「未設定」而非 100%（UX14）。 */
function rate(bps: number | null): string {
  if (bps === null) return '未設定';
  return formatDiscountBps(bps);
}

/** 額外扣天：hasExtraFlag 為「*額」標記來源（0 天與「無額外」不同）。 */
function extraDays(stu: StudentCalculationItem): string {
  const care = stu.trace as { careDays?: { anqin?: { hasExtraFlag?: boolean }; tutoring?: { hasExtraFlag?: boolean } } } | undefined;
  const hasExtra = Boolean(care?.careDays?.anqin?.hasExtraFlag || care?.careDays?.tutoring?.hasExtraFlag);
  const total =
    (stu.anqinDays ?? 0) + (stu.tutoringDays ?? 0);
  return hasExtra ? `${total}*` : num(stu.anqinDays === null && stu.tutoringDays === null ? null : total);
}

interface SummaryTableProps {
  students: StudentCalculationItem[];
  loading?: boolean;
  onSelectStudent: (student: StudentCalculationItem) => void;
  onResetFilters?: () => void;
}

export default function SummaryTable({
  students,
  loading,
  onSelectStudent,
  onResetFilters,
}: SummaryTableProps) {
  if (loading) {
    return (
      <div style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }} role="status" aria-live="polite">
        載入學生總表中…
      </div>
    );
  }

  if (students.length === 0) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <h3 style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: '6px' }}>沒有符合條件的學生</h3>
        <p style={{ fontSize: '0.8125rem', marginBottom: '16px' }}>請調整篩選條件後再試。目前的核對結果不會改變。</p>
        {onResetFilters && (
          <button type="button" className="btn-secondary" style={{ fontSize: '0.8125rem' }} onClick={onResetFilters}>
            清除篩選條件
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className="data-table results-table">
        <thead>
          <tr>
            <th className="sticky-name">姓名</th>
            <th>年級</th>
            <th>所屬班級</th>
            <th className="cblue">安親天數</th>
            <th className="cblue">課輔天數</th>
            <th>額外扣天</th>
            <th>
              合計折扣 <InfoTip label="合計折扣說明">對應基本率；指定課程可能另有調整</InfoTip>
            </th>
            <th>已補科數</th>
            <th>兄弟姊妹折扣</th>
            <th>特殊折扣</th>
            <th>園內生</th>
            <th>需確認</th>
          </tr>
        </thead>
        <tbody>
          {students.map((stu) => {
            const tags = parseTagDiscounts((stu.trace as { rawTags?: string } | undefined)?.rawTags ?? '');
            return (
              <tr
                key={stu.personCode}
                style={{ cursor: 'pointer', backgroundColor: stu.tierMismatch ? '#fff5f5' : undefined }}
                onClick={() => onSelectStudent(stu)}
              >
                <td className="sticky-name" style={{ fontWeight: 600 }}>
                  <button
                    type="button"
                    className="link-button"
                    data-student-trigger={stu.personCode}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectStudent(stu);
                    }}
                    aria-label={`查看 ${stu.name} 的明細`}
                  >
                    {stu.name}
                  </button>
                </td>
                <td>{stu.grade ? `${stu.grade}年級` : stu.gradeRaw || '—'}</td>
                <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {stu.enrollments.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      {stu.enrollments.slice(0, 2).map((e, eIdx) => (
                        <span key={eIdx}>{e.rawToken}</span>
                      ))}
                      {stu.enrollments.length > 2 && (
                        <span style={{ color: 'var(--text-muted)' }}>另 {stu.enrollments.length - 2} 班</span>
                      )}
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="cblue number">{stu.anqinDisplay || '—'}</td>
                <td className="cblue number">{stu.tutoringDisplay || '—'}</td>
                <td className="number">{extraDays(stu)}</td>
                <td className="number">
                  {formatBaseDiscount(stu.baseDiscountBps)}
                  <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontWeight: 400 }}>
                    指定課程可能另有調整
                  </div>
                </td>
                <td className="number">{num(stu.subjectCount)}</td>
                <td>
                  {tags.sibling ? (
                    <span className="badge badge-ok">有</span>
                  ) : (
                    <span className="subtle">—</span>
                  )}
                </td>
                <td>
                  {stu.subjectCount !== null && (stu.applicableAnqinBps !== null || stu.applicableTutoringBps !== null) ? (
                    <span className="number">{rate(stu.applicableTutoringBps ?? stu.applicableAnqinBps)}</span>
                  ) : (
                    <span className="subtle">—</span>
                  )}
                </td>
                <td>
                  {tags.internalStudent ? (
                    <span className="badge badge-ok">是</span>
                  ) : (
                    <span className="subtle">—</span>
                  )}
                </td>
                <td>
                  {stu.tierMismatch && (
                    <span className="badge badge-warn">天數不同</span>
                  )}
                  {stu.hasIssues && (
                    <span className="badge badge-warn">
                      {stu.issues.length > 0 ? stu.issues[0].code : '待核對'}
                    </span>
                  )}
                  {!stu.tierMismatch && !stu.hasIssues && <span className="subtle">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

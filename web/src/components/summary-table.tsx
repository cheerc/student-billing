'use client';

import React, { useState } from 'react';
import { StudentCalculationItem } from '@/application/query-students';
import { formatDiscountBps } from '@/application/roster-changes';
import { applicableRateForClass, type RunClassCategorySnapshot } from '@/application/applicable-rate';
import { parseTagDiscounts } from '@/domain/billing/discount-rules';
import { InfoTip } from './ui/info-tip';
import { issueLabel } from '@/lib/issue-copy';

/**
 * 學生總表（09 §5.1）。
 *
 * 預設欄位固定為 12 欄（SPEC 所列）；人員代碼、美語／數學／中文天數、寫功課等既有欄
 * **位移**到欄位選擇與明細，**不刪功能**（學生資料仍完整攜帶，明細抽屜可查）。
 * 恰選一班時（`singleClass`）在合計折扣右側多一欄「本班適用折扣」（F05），與基本率並列、不覆蓋。
 *
 * 型別不混（UX14）：0（適用但無扣天）、null（非適用／無法判定）、未設定（未配置）
 * 三者分開顯示，未配置絕不當成 100%。
 *
 * 徽章只呈警告，不堆綠色、不宣告帳單已對帳正確；徽章不得硬寫筆數（09 §7：
 * 「預期N人」只屬 fixture，實際筆數由查詢結果回填）。
 * 重複說明（合計折扣與指定課程的差別）只放在表頭 tooltip，不逐列重複（O01）。
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

/** 表頭篩選觸發鈕的欄位代號（由呼叫端決定要放哪個篩選元件）。 */
export type StudentColumnKey =
  | 'grade'
  | 'enrollment'
  | 'anqinDays'
  | 'tutoringDays'
  | 'extra'
  | 'baseDiscount'
  | 'applicable'
  | 'sibling'
  | 'special'
  | 'internal'
  | 'review';

/** 合計折扣＝基本率收取率短標（與異動判準共用同一格式化，短標一致）。 */
export function formatBaseDiscount(bps: number | null): string {
  return formatDiscountBps(bps);
}

/** 數值欄：null＝非適用／無法判定，顯示「—」而非 0（UX14 型別不混）。 */
function num(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return String(v);
}

/** 額外扣天：hasExtraFlag 為「*額」標記來源（0 天與「無額外」不同）。 */
function extraDays(stu: StudentCalculationItem): string {
  const care = stu.trace as { careDays?: { anqin?: { hasExtraFlag?: boolean }; tutoring?: { hasExtraFlag?: boolean } } } | undefined;
  const hasExtra = Boolean(care?.careDays?.anqin?.hasExtraFlag || care?.careDays?.tutoring?.hasExtraFlag);
  const total =
    (stu.anqinDays ?? 0) + (stu.tutoringDays ?? 0);
  return hasExtra ? `${total}*` : num(stu.anqinDays === null && stu.tutoringDays === null ? null : total);
}

/**
 * 恰選一班時的本班適用折扣：未配置＝「未設定」（不是 100%）；已配置但無法判定＝「—」。
 *
 * D2b 3（N-8）：v3 run 以 server 傳下的類別快照判斷，查詢 key 必須是**名冊班名**
 * （快照的 base_name 存的就是名冊班名；`singleClass` 亦來自名冊報名 key，兩者同源）。
 * v1／v2 沒有快照，沿用明確版本的凍結名稱映射；缺 Run/version/snapshot 時不猜。
 */
function localRate(
  stu: StudentCalculationItem,
  className: string,
  snapshots: RunClassCategorySnapshot[] | undefined,
  ruleSetVersion?: string | null
): string {
  const r = applicableRateForClass(
    className,
    stu,
    {
      isV3Run: Array.isArray(snapshots),
      usesSnapshot: Array.isArray(snapshots),
      ruleSetVersion,
      findSnapshot: (name) => snapshots?.find((x) => x.base_name === name),
    }
  );
  if (r.status === 'not_configured') return '未設定';
  return r.bps === null ? '—' : formatDiscountBps(r.bps);
}

interface SummaryTableProps {
  students: StudentCalculationItem[];
  loading?: boolean;
  onSelectStudent: (student: StudentCalculationItem) => void;
  onResetFilters?: () => void;
  /** 恰選一個班級時的班名；有值才顯示「本班適用折扣」欄（未選班、選多班、(空白) 都不顯示） */
  singleClass?: string | null;
  /** 表頭篩選觸發鈕；未提供時是純表格 */
  renderFilter?: (column: StudentColumnKey) => React.ReactNode;
  /**
   * 該 run 的班級類別快照（具快照能力的 run 才有；server 由 run_class_categories 讀出）。
   * v3/v4 缺快照時仍依 ruleSetVersion fail closed；明確 v1/v2 才用 frozen historical projection。
   */
  classCategorySnapshots?: RunClassCategorySnapshot[] | null;
  /** 該 run 的規則集版本（例如 erp-tag-v4） */
  ruleSetVersion?: string | null;
}

/**
 * 班名最多兩行，其餘收成同一行尾端的「另 N 班」，可點擊展開全部（O01）。
 * 每個班名固定一行（過長以省略號截斷，完整原文在明細「原始資料」），避免一列被折成好幾行而擠掉可見列數。
 */
function EnrollmentCell({ stu, expanded, onToggle }: { stu: StudentCalculationItem; expanded: boolean; onToggle: () => void }) {
  if (stu.enrollments.length === 0) return <>—</>;
  const shown = expanded ? stu.enrollments : stu.enrollments.slice(0, 2);
  const extra = stu.enrollments.length - 2;
  const more = (label: string) => (
    <button type="button" className="enroll-more" aria-expanded={expanded} onClick={(ev) => { ev.stopPropagation(); onToggle(); }}>
      {label}
    </button>
  );
  return (
    <div className="enroll-cell">
      {shown.map((e, i) => (
        <span key={i} className="enroll-line">
          <span className="enroll-name">{e.rawToken}</span>
          {!expanded && extra > 0 && i === shown.length - 1 ? more(`另 ${extra} 班`) : null}
        </span>
      ))}
      {expanded && extra > 0 ? more('收合') : null}
    </div>
  );
}

export default function SummaryTable({
  students,
  loading,
  onSelectStudent,
  onResetFilters,
  singleClass = null,
  renderFilter,
  classCategorySnapshots = null,
  ruleSetVersion = null,
}: SummaryTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const f = (column: StudentColumnKey) => renderFilter?.(column) ?? null;

  if (loading && students.length === 0) {
    return (
      <div style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }} role="status" aria-live="polite">
        載入學生總表中…
      </div>
    );
  }

  // R4-F03：0 人時**不得**整段抽掉表頭。表頭篩選入口在 thead 內（specs/09:151 要求
  // 「已勾選 0 人值仍可取消且不被 prune」），一旦 0 人就 return 空狀態，使用者便只能
  // 靠 chip 或「清除篩選條件」繞行，無法從面板調整條件。
  // 空狀態改放在 tbody 內（同 class-deductions-panel.tsx:203 的既有做法），
  // 表頭與文案按鈕都保留。「載入中且無資料」仍是獨立分支：此時尚未取得結果，
  // 顯示空表頭只會誤導為「篩不到人」。
  const emptyState = students.length === 0 && (
    <tr>
      <td colSpan={singleClass !== null ? 14 : 13}>
        <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <h3 style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: '6px' }}>沒有符合條件的學生</h3>
          <p style={{ fontSize: '0.8125rem', marginBottom: '16px' }}>請調整篩選條件後再試。目前的核對結果不會改變。</p>
          {onResetFilters && (
            <button type="button" className="btn-secondary" style={{ fontSize: '0.8125rem' }} onClick={onResetFilters}>
              清除篩選條件
            </button>
          )}
        </div>
      </td>
    </tr>
  );

  return (
    <>
      {loading && (
        <div className="table-updating" role="status">更新中…下方仍是上一次的結果</div>
      )}
      <div className="table-scroll" aria-busy={loading ? 'true' : undefined}>
        <table className="data-table results-table">
          <thead>
            <tr>
              <th className="sticky-name">姓名</th>
              <th>年級{f('grade')}</th>
              <th>所屬班級{f('enrollment')}</th>
              <th className="cblue">安親天數{f('anqinDays')}</th>
              <th className="cblue">課輔天數{f('tutoringDays')}</th>
              <th>額外扣天{f('extra')}</th>
              <th>
                合計折扣 <InfoTip label="合計折扣說明">對應基本率；指定課程可能另有調整</InfoTip>
                {f('baseDiscount')}
              </th>
              {singleClass !== null && (
                <th>
                  本班適用折扣 <InfoTip label="本班適用折扣說明">這個班適用的最終折扣，與合計折扣並列、不取代它。「未設定」＝這個班尚未設定適用折扣（不是 100%）；「—」＝這位學生無法判定。</InfoTip>
                  {f('applicable')}
                </th>
              )}
              <th>已補科數</th>
              <th>兄弟姊妹折扣{f('sibling')}</th>
              <th>特殊折扣{f('special')}</th>
              <th>園內生{f('internal')}</th>
              <th>需確認{f('review')}</th>
            </tr>
          </thead>
          <tbody>
            {emptyState}
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
                    <EnrollmentCell
                      stu={stu}
                      expanded={expandedRows.has(stu.personCode)}
                      onToggle={() =>
                        setExpandedRows((prev) => {
                          const next = new Set(prev);
                          if (next.has(stu.personCode)) next.delete(stu.personCode);
                          else next.add(stu.personCode);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="cblue number">{stu.anqinDisplay || '—'}</td>
                  <td className="cblue number">{stu.tutoringDisplay || '—'}</td>
                  <td className="number">{extraDays(stu)}</td>
                  <td className="number">{formatBaseDiscount(stu.baseDiscountBps)}</td>
                  {singleClass !== null && (
                    <td className="number">{localRate(stu, singleClass, classCategorySnapshots ?? undefined, ruleSetVersion)}</td>
                  )}
                  <td className="number">{num(stu.subjectCount)}</td>
                  <td>
                    {tags.sibling ? (
                      <span className="badge badge-ok">有</span>
                    ) : (
                      <span className="subtle">—</span>
                    )}
                  </td>
                  <td>
                    {tags.specialDiscount !== null ? (
                      <span className="number">{formatDiscountBps(Math.round(tags.specialDiscount * 10000))}</span>
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
                    {stu.actionableHasIssues && (
                      <span className="badge badge-warn">
                        {stu.actionableIssues.length > 0 ? issueLabel(stu.actionableIssues[0].code) : '待核對'}
                      </span>
                    )}
                    {!stu.tierMismatch && !stu.actionableHasIssues && <span className="subtle">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

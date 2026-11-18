'use client';

import React, { useEffect, useState } from 'react';
import { StudentCalculationItem } from '@/application/query-students';
import type { RunClassCategorySnapshot } from '@/application/applicable-rate';
import { InfoTip } from './ui/info-tip';
import { BLANK_CELL_TEXT, nonBlankCells, type TextCell } from '@/lib/table-columns/cell';
import { baseDiscountCell, studentColumnSpec, type StudentColumnCtx } from '@/lib/table-columns/student-columns';
import { columnLabels, type ColumnDef } from './tables/column-def';
import TableHeaderCell, { type HeaderSortState } from './tables/table-header-cell';

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

/** 預設欄位定義（順序即規格順序；欄名清單由此推導，維持欄位定義唯一來源）。 */
const STUDENT_COLUMN_DEFS = [
  { key: 'name', label: '姓名', className: 'sticky-name', sort: { server: 'name' } },
  { key: 'grade', label: '年級', filterKey: 'grade', sort: { server: 'grade' } },
  { key: 'enrollment', label: '所屬班級', filterKey: 'enrollment' },
  { key: 'anqinDays', label: '安親天數', className: 'cblue', filterKey: 'anqinDays', sort: { server: 'anqinDays' } },
  { key: 'tutoringDays', label: '課輔天數', className: 'cblue', filterKey: 'tutoringDays', sort: { server: 'tutoringDays' } },
  { key: 'extra', label: '額外扣天', filterKey: 'extra' },
  { key: 'baseDiscount', label: '合計折扣', filterKey: 'baseDiscount', sort: { server: 'baseDiscountBps' } },
  { key: 'supplement', label: '已補科數', sort: { server: 'subjectCount' } },
  { key: 'sibling', label: '兄弟姊妹折扣', filterKey: 'sibling' },
  { key: 'special', label: '特殊折扣', filterKey: 'special' },
  { key: 'internal', label: '園內生', filterKey: 'internal' },
  { key: 'review', label: '需確認', filterKey: 'review' },
] as const satisfies readonly ColumnDef[];

const APPLICABLE_COLUMN: ColumnDef = { key: 'applicable', label: '本班適用折扣', filterKey: 'applicable' };

export const STUDENT_TABLE_COLUMNS = columnLabels(STUDENT_COLUMN_DEFS);

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

/** 合計折扣＝基本率收取率短標（與異動判準共用同一格式化，短標一致）；委派欄位定義模組的同一份 cell。 */
export function formatBaseDiscount(bps: number | null): string {
  return baseDiscountCell(bps).text;
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
  /** 目前 server 排序（null＝預設順序）；與 onSortChange 同時提供才顯示排序鈕（D65） */
  sort?: { field: string; dir: 'asc' | 'desc' } | null;
  onSortChange?: (field: string) => void;
  /** 該 run 的班級類別快照（server 由 run_class_categories 讀出）；缺該班快照時顯示「未設定」。 */
  classCategorySnapshots?: RunClassCategorySnapshot[] | null;
}

/**
 * 班名最多兩行，其餘收成同一行尾端的「另 N 班」，可點擊展開全部（O01）。
 * 每個班名固定一行（過長以省略號截斷），主文字＝欄位定義的 baseName（空 baseName＝「班名無法解析」），
 * 原始 token（年度前綴、`[N]` 等修飾）放在 `data-raw-token`：滑鼠 hover 由 `EnrollTokenTooltip` 顯示，
 * 鍵盤／螢幕閱讀器改走明細「原始資料」（D66 Q2-b）。不用 `title`：不可聚焦元素只靠 title＝hover-only（09 §6、a11y rule 6）。
 * `cells` 與 `stu.enrollments` 逐項同序（enrollment 欄位定義每個報名一項）。
 */
function EnrollmentCell({
  stu,
  cells,
  expanded,
  onToggle,
}: {
  stu: StudentCalculationItem;
  cells: TextCell[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (cells.length === 0) return <>{BLANK_CELL_TEXT}</>;
  const shown = expanded ? cells : cells.slice(0, 2);
  const extra = cells.length - 2;
  const more = (label: string) => (
    <button type="button" className="enroll-more" aria-expanded={expanded} onClick={(ev) => { ev.stopPropagation(); onToggle(); }}>
      {label}
    </button>
  );
  return (
    <div className="enroll-cell">
      {shown.map((c, i) => (
        <span key={i} className="enroll-line">
          <span className="enroll-name" data-raw-token={stu.enrollments[i]?.rawToken}>{c.text}</span>
          {!expanded && extra > 0 && i === shown.length - 1 ? more(`另 ${extra} 班`) : null}
        </span>
      ))}
      {expanded && extra > 0 ? more('收合') : null}
    </div>
  );
}

/**
 * 所屬班級原始 token 的滑鼠 tooltip（D66 Q2-b）。整張表只掛一個：文件層級監聽 hover，
 * 讀 `[data-raw-token]`，以 position:fixed 呈現（不被 .table-scroll 裁切、不佔表格版面）；
 * pointer-events:none 不攔截點擊；Esc／離開／捲動／錨點被移出 DOM 即關；不增加任何 tab stop。
 * 只放補充資訊——鍵盤與螢幕閱讀器的對等路徑是明細抽屜「原始資料」（09 §6）。
 */
function EnrollTokenTooltip() {
  const [tip, setTip] = useState<{ text: string; left: number; top: number; anchor: Element } | null>(null);
  useEffect(() => {
    const holder = (e: Event): Element | null => (e.target instanceof Element ? e.target.closest('[data-raw-token]') : null);
    const over = (e: MouseEvent) => {
      const el = holder(e);
      const text = el?.getAttribute('data-raw-token');
      if (!el || !text) {
        setTip(null); // 指標在別處＝不殘留
        return;
      }
      const r = el.getBoundingClientRect();
      setTip({ text, left: r.left, top: r.bottom + 4, anchor: el });
    };
    const out = (e: MouseEvent) => {
      const el = holder(e);
      if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
      setTip(null);
    };
    const close = () => setTip(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setTip(null); };
    document.addEventListener('mouseover', over);
    document.addEventListener('mouseout', out);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mouseout', out);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', close, true);
    };
  }, []);
  // 篩選／排序重繪會把錨點整列移除，被移除的元素不會再發 mouseout：錨點離開 DOM 就關閉
  const anchor = tip?.anchor;
  useEffect(() => {
    if (!anchor) return;
    const obs = new MutationObserver(() => {
      if (!anchor.isConnected) setTip(null);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [anchor]);
  if (!tip) return null;
  return (
    <span role="tooltip" className="enroll-tip" style={{ position: 'fixed', left: tip.left, top: tip.top, pointerEvents: 'none' }}>
      {tip.text}
    </span>
  );
}

export default function SummaryTable({
  students,
  loading,
  onSelectStudent,
  onResetFilters,
  singleClass = null,
  renderFilter,
  sort = null,
  onSortChange,
  classCategorySnapshots = null,
}: SummaryTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const f = (column: StudentColumnKey) => renderFilter?.(column) ?? null;
  const sortStateOf = (d: ColumnDef): HeaderSortState | undefined => {
    if (!onSortChange || !d.sort || !('server' in d.sort)) return undefined;
    const field = d.sort.server;
    return { dir: sort?.field === field ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none', onToggle: () => onSortChange(field) };
  };

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
              {STUDENT_COLUMN_DEFS.map((def) => {
                const d: ColumnDef = def;
                const cell = (
                  <TableHeaderCell
                    key={d.key}
                    column={d}
                    filter={d.filterKey ? f(d.filterKey as StudentColumnKey) : null}
                    sort={sortStateOf(d)}
                  >
                    {d.key === 'baseDiscount' ? (
                      <>
                        {' '}
                        <InfoTip label="合計折扣說明">對應基本率；指定課程可能另有調整</InfoTip>
                      </>
                    ) : null}
                  </TableHeaderCell>
                );
                // 本班適用折扣緊接在合計折扣之後（恰選一班時）
                if (d.key !== 'baseDiscount' || singleClass === null) return cell;
                return (
                  <React.Fragment key={d.key}>
                    {cell}
                    <TableHeaderCell key="applicable" column={APPLICABLE_COLUMN} filter={f('applicable')}>
                      {' '}
                      <InfoTip label="本班適用折扣說明">這個班適用的最終折扣，與合計折扣並列、不取代它。「未設定」＝這個班尚未設定適用折扣（不是 100%）；「—」＝這位學生無法判定。</InfoTip>
                    </TableHeaderCell>
                  </React.Fragment>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {emptyState}
            {students.map((stu) => {
              // 每格文字都取自欄位定義（03 R6）：渲染、篩選、排序同一份 cells()
              const ctx: StudentColumnCtx = { singleClass, snapshots: classCategorySnapshots };
              const cells = (key: string): TextCell[] => nonBlankCells(studentColumnSpec(key)?.cells(stu, ctx) ?? []);
              const text = (key: string): string => cells(key).map((c) => c.text).join(' ') || BLANK_CELL_TEXT;
              const flag = (key: string, cls: string) => {
                const c = cells(key)[0];
                return c ? <span className={cls}>{c.text}</span> : <span className="subtle">{BLANK_CELL_TEXT}</span>;
              };
              const review = cells('review');
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
                      {text('name')}
                    </button>
                  </td>
                  <td>{text('grade')}</td>
                  <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    <EnrollmentCell
                      stu={stu}
                      cells={cells('enrollment')}
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
                  <td className="cblue number">{text('anqinDays')}</td>
                  <td className="cblue number">{text('tutoringDays')}</td>
                  <td className="number">{text('extraDeduction')}</td>
                  <td className="number">{text('baseDiscount')}</td>
                  {singleClass !== null && <td className="number">{text('applicableDiscount')}</td>}
                  <td className="number">{text('subjectCount')}</td>
                  <td>{flag('sibling', 'badge badge-ok')}</td>
                  <td>{flag('specialDiscount', 'number')}</td>
                  <td>{flag('internalStudent', 'badge badge-ok')}</td>
                  <td>
                    {review.length > 0 ? (
                      review.map((c) => (
                        <span key={c.text} className="badge badge-warn">{c.text}</span>
                      ))
                    ) : (
                      <span className="subtle">{BLANK_CELL_TEXT}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <EnrollTokenTooltip />
    </>
  );
}

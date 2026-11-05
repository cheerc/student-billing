'use client';

import React, { useEffect, useRef } from 'react';
import type { StudentSnapshot } from '@/domain/students';
import type { PreviewWithDiff } from '@/components/imports/imports-workflow';
import { ClassNameReportSummaryCard } from '@/components/imports/class-name-report-summary';
import { RosterChangesDetails } from '@/components/imports/roster-changes-details';
import { restoreFocusToOpener } from '@/components/ui/restore-focus-to-opener';

export type ReviewTab = 'changes' | 'list';
export type StudentFilterMode = 'all' | 'with-class' | 'no-class' | 'withdrawn';

interface ImportReviewDialogProps {
  isOpen: boolean;
  tab: ReviewTab;
  onTabChange: (tab: ReviewTab) => void;
  onClose: () => void;
  preview: PreviewWithDiff;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  filterMode: StudentFilterMode;
  onFilterModeChange: (mode: StudentFilterMode) => void;
  /** 已套用搜尋與狀態篩選的學生（顯示上限 100 列由本元件套用）。 */
  filteredStudents: StudentSnapshot[];
}

/**
 * 匯入預覽的「異動／名單」浮動視窗（D64 G3，UX124）。
 * 原生 <dialog>.showModal()；關閉（含 Esc）後焦點回到觸發鈕（同 settings/impact-dialog.tsx）。
 * 「異動」頁籤的班名摘要只顯示純文字、不含連結（UX121）。
 */
export function ImportReviewDialog({
  isOpen,
  tab,
  onTabChange,
  onClose,
  preview,
  searchQuery,
  onSearchChange,
  filterMode,
  onFilterModeChange,
  filteredStudents,
}: ImportReviewDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // 記住觸發元素：本元件每次開啟都是全新掛載，故於首次 render（showModal 之前）擷取 activeElement。
  // 不放進 effect：dev StrictMode 會重跑 effect，那時焦點已被 showModal 移進視窗內，會誤記成視窗內的按鈕。
  if (openerRef.current === null && isOpen && typeof document !== 'undefined') {
    openerRef.current = document.activeElement as HTMLElement | null;
  }
  useEffect(() => {
    if (!isOpen) return;
    return () => restoreFocusToOpener(openerRef.current);
  }, [isOpen]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen && dialog && !dialog.open) dialog.showModal();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const diff = preview.rosterDiff;
  const hasBase = !!diff && diff.baseImportId !== null;

  return (
    <dialog
      ref={dialogRef}
      className="import-review-dialog"
      aria-labelledby="importReviewTitle"
      aria-modal="true"
      onClose={onClose}
    >
      <div className="dialoghead">
        <h2 id="importReviewTitle">{preview.fileName}</h2>
        <button type="button" className="btn-close" onClick={onClose} aria-label="關閉視窗">
          ✕
        </button>
      </div>

      <div className="tabs import-review-tabs" role="tablist" aria-label="預覽內容">
        <button
          type="button"
          role="tab"
          id="import-review-tab-changes"
          aria-selected={tab === 'changes'}
          aria-controls="import-review-panel-changes"
          className={tab === 'changes' ? 'selected' : undefined}
          onClick={() => onTabChange('changes')}
        >
          異動
        </button>
        <button
          type="button"
          role="tab"
          id="import-review-tab-list"
          aria-selected={tab === 'list'}
          aria-controls="import-review-panel-list"
          className={tab === 'list' ? 'selected' : undefined}
          onClick={() => onTabChange('list')}
        >
          名單
        </button>
      </div>

      <div className="import-review-body">
        {tab === 'changes' && (
          <div role="tabpanel" id="import-review-panel-changes" aria-labelledby="import-review-tab-changes">
            {hasBase && diff && (
              <>
                <div className="roster-diff-bar" role="status">
                  <span className="roster-diff-label">與目前名單相比</span>
                  <span className="roster-diff-item" data-diff="new">
                    新增 <strong>{diff.newStudents}</strong> 人
                  </span>
                  <span className="roster-diff-item" data-diff="changed">
                    異動 <strong>{diff.changedStudents}</strong> 人
                  </span>
                  <span className="roster-diff-item" data-diff="not-appeared">
                    未出現 <strong>{diff.notAppearedStudents}</strong> 人
                  </span>
                </div>
                <div className="roster-changes-wrap">
                  <RosterChangesDetails changes={diff.changes ?? []} />
                </div>
              </>
            )}

            {/* 被略過的資料列須照實呈現（含列號／欄名／原因；D17、specs/09 §4）。 */}
            {preview.issues.length > 0 && (
              <div className="alert alert-warning issues-alert">
                <strong>匯入注意事項：</strong>
                <ul style={{ paddingLeft: '20px', marginTop: '6px' }}>
                  {preview.issues.map((issue, idx) => (
                    <li key={idx}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* pendingClasses 仍是 03 §5.2.4 的預覽 API 欄位；UI 只呈現這段純文字摘要（無連結，UX121）。 */}
            {preview.classNameReport && (
              <ClassNameReportSummaryCard summary={preview.classNameReport} showLink={false} />
            )}

            {!hasBase && preview.issues.length === 0 && !preview.classNameReport && (
              <p className="note">首次匯入，沒有可比較的目前名單，也沒有需要注意的項目。</p>
            )}
          </div>
        )}

        {tab === 'list' && (
          <div role="tabpanel" id="import-review-panel-list" aria-labelledby="import-review-tab-list">
            <div className="import-review-list-head">
              <div style={{ fontWeight: 600, fontSize: '14px' }}>
                名單預覽 ({filteredStudents.length} / {preview.students.length})
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="搜尋姓名或代碼..."
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  className="search"
                  style={{ width: '200px' }}
                  aria-label="搜尋預覽學生"
                />
                <select
                  value={filterMode}
                  onChange={(e) => onFilterModeChange(e.target.value as StudentFilterMode)}
                  aria-label="篩選學生狀態"
                >
                  <option value="all">全部學生 ({preview.stats.totalStudents})</option>
                  <option value="with-class">有班級 ({preview.stats.studentsWithClass})</option>
                  <option value="no-class">無課程 ({preview.stats.studentsWithoutClass})</option>
                  <option value="withdrawn">有離班標記 ({preview.stats.withdrawnStudentsCount})</option>
                </select>
              </div>
            </div>
        <div className="scroll table-scroll-container" style={{ border: '1px solid var(--border-color)', borderRadius: '6px' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '48px' }}>序號</th>
                <th>人員代碼</th>
                <th>姓名</th>
                <th>年級</th>
                <th>所屬分校</th>
                <th>報名班級</th>
                <th>標籤</th>
                <th>備註</th>
              </tr>
            </thead>
            <tbody>
              {filteredStudents.slice(0, 100).map((stu, idx) => (
                <tr key={stu.personCode}>
                  <td style={{ color: 'var(--text-muted)' }}>{idx + 1}</td>
                  <td className="code-text" style={{ fontWeight: 600 }}>{stu.personCode}</td>
                  <td style={{ fontWeight: 600 }}>{stu.name}</td>
                  <td>
                    {stu.grade ? (
                      <span>{stu.grade} 年級</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>{stu.gradeRaw || '未識別'}</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{stu.branch || '-'}</td>
                  <td>
                    {stu.enrollments.length > 0 ? (
                      <div className="token-list">
                        {stu.enrollments.map((enr, eIdx) => (
                          <div key={eIdx} className="token-item">
                            <span className="badge badge-class">{enr.rawToken}</span>
                            {enr.previewErpBillingTier !== undefined && enr.previewErpBillingTier !== null && (
                              <span className="badge badge-tier">
                                設定預覽級距: {enr.previewErpBillingTier} 天
                                {/*
                                  Rework B2：(預設) 表示該級距是解析失敗後採用的預設值，
                                  非 米豆奶 原始登記值。移除此標記會讓使用者把預設值
                                  誤認為實登值，直接影響級距差異的判讀基礎。
                                */}
                                {enr.previewTierParseStatus === 'defaulted' ? ' (預設)' : ''}
                              </span>
                            )}
                            {enr.previewErpBillingTier === null && enr.previewTierParseStatus === 'unavailable' && (
                              <span className="badge badge-warn">級距待設定／無法判定</span>
                            )}
                            {/*
                              Rework B2：離班徽章。篩選器與統計卡雖有離班資訊，
                              但表格必須看得出是哪幾位學生離班。
                            */}
                            {enr.withdrawalDate && (
                              <span className="badge badge-withdrawal">
                                離班: {enr.withdrawalDate}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>無班級</span>
                    )}
                  </td>
                  <td>
                    {stu.tagsRaw ? (
                      <span style={{ fontSize: '0.75rem', color: '#1d4ed8' }}>{stu.tagsRaw}</span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td>
                    {stu.notesRaw ? (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {stu.notesRaw}
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

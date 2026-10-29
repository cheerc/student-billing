'use client';

import React, { useState, useMemo } from 'react';
import type { ClassNameSyncReport, ClassNameSyncSystemOnly } from '@/application/class-name-match-report';
import { CLASS_TYPE_LABELS, type ScheduleGridRow, type AliasMapping, type ClassType } from '@/contracts/settings';

export interface ClassNameSyncPanelProps {
  report: ClassNameSyncReport | null;
  rows?: ScheduleGridRow[];
  aliases?: AliasMapping[];
  stagedRenames?: Map<string, string>; // erpBaseName -> systemBaseName
  stagedNewClasses?: Set<string>; // erpBaseName
  onStageSync?: (erpBaseName: string, systemBaseName: string) => void;
  onStageNewClass?: (erpBaseName: string, classType: ClassType) => void;
  onUndoStaged?: (erpBaseName: string) => void;
  onGoToSchedule?: (className: string) => void;
  locked?: boolean;
  reportRecoveryStage?: 'retrying' | 'reload' | 'reloadPage' | null;
  reportStaleMessage?: string | null;
  onRetryReport?: () => void;
  onReloadPage?: () => void;
  hasStudents?: boolean;
  defaultExpandedRow?: { erpBaseName: string; mode: 'sync' | 'new' } | null;
}

const CLASS_TYPE_ORDER: ClassType[] = ['care', 'english', 'math', 'other', 'unscheduled'];

export function ClassNameSyncPanel({
  report,
  rows = [],
  stagedRenames = new Map(),
  stagedNewClasses = new Set(),
  onStageSync,
  onStageNewClass,
  onUndoStaged,
  onGoToSchedule,
  locked = false,
  reportRecoveryStage = null,
  reportStaleMessage = null,
  onRetryReport = () => {},
  onReloadPage = () => {},
  hasStudents = true,
  defaultExpandedRow = null,
}: ClassNameSyncPanelProps) {
  const [expandedRow, setExpandedRow] = useState<{ erpBaseName: string; mode: 'sync' | 'new' } | null>(
    defaultExpandedRow
  );
  const [selectedTargetMap, setSelectedTargetMap] = useState<Record<string, string>>({});
  const [selectedClassTypeMap, setSelectedClassTypeMap] = useState<Record<string, ClassType>>({});

  // 整理已被暫存改名的課表班級集合（避免其他列重複選擇）
  const claimedSystemNames = useMemo(() => {
    return new Set(stagedRenames.values());
  }, [stagedRenames]);

  if (!hasStudents || !report) {
    return (
      <div className="card class-name-sync-panel-card" data-class-name-sync-panel="" style={{ padding: '32px', textAlign: 'center' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>📋</div>
        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
          匯入名單後，可在這裡同步班名
        </h3>
        <p className="note" style={{ maxWidth: '480px', margin: '0 auto 16px', lineHeight: 1.6 }}>
          目前系統中尚未匯入學生名冊。當您上傳米豆奶試算表後，若有班級名稱與課表不一致，將列於此處供您逐一確認同步或建立班級，完全不阻擋先行的課表維護與儲存。
        </p>
      </div>
    );
  }

  if (report.snapshotStatus === 'unavailable') {
    return (
      <div className="card class-name-sync-panel-card" data-class-name-sync-panel="" style={{ padding: '24px' }}>
        <p className="note">
          找不到這次計算當時的課表設定，無法判定班名同步；系統不會改用現在的課表猜測。
        </p>
      </div>
    );
  }

  const mismatches = report.mismatches ?? [];
  const systemOnly = report.systemOnly ?? [];
  const exactMatchCount = report.exactMatchCount ?? 0;
  const rosterClassCount = report.rosterClassCount ?? 0;
  const mismatchCount = mismatches.length;
  const unmappedCount = mismatches.filter((m) => m.legacyAliasTarget === null).length;
  const unmappedStudents = report.unmappedStudents ?? 0;

  const showRecoveryAlert = reportRecoveryStage === 'reload' || reportRecoveryStage === 'reloadPage';
  const staleMessage = showRecoveryAlert ? reportStaleMessage : null;

  /** UX46：重試中／未恢復時不渲染儲存前的舊報告，只顯示中性佔位或復原按鈕；差異表一併鎖定。 */
  const recovering = reportRecoveryStage === 'retrying';
  const lockedByReport = locked || reportRecoveryStage !== null;

  return (
    <div
      className="class-name-sync-panel-container"
      data-class-name-sync-panel=""
      data-report-locked={lockedByReport ? 'true' : undefined}
    >
      {/* 狀態與復原警示 (UX46) */}
      {staleMessage ? (
        <div className="alert alert-warning" role="alert" data-report-stale="" style={{ marginBottom: '20px' }}>
          <span>{staleMessage}</span>{' '}
          {reportRecoveryStage === 'reload' ? (
            <button type="button" className="btn-secondary" data-report-retry="" onClick={onRetryReport}>
              重新載入
            </button>
          ) : (
            <button type="button" className="btn-secondary" data-report-reload-page="" onClick={onReloadPage}>
              重新整理頁面
            </button>
          )}
        </div>
      ) : recovering ? (
        <p className="note" data-report-pending="" style={{ marginBottom: '20px' }}>
          更新中…
        </p>
      ) : null}

      {/* 更新中／未恢復：不渲染差異表與任何舊數字 */}
      {recovering || showRecoveryAlert ? (
        <div
          className="card"
          data-report-body-hidden=""
          aria-hidden={lockedByReport ? 'true' : undefined}
          style={{ padding: '24px', color: 'var(--text-muted, #64748b)' }}
        >
          {recovering ? '正在取得最新的班名比對報告…' : '報告尚未恢復，差異表暫時無法操作。'}
        </div>
      ) : (
        <>
          {/* 摘要列 */}
          <div className="card sync-summary-card" style={{ padding: '16px 20px', marginBottom: '20px' }}>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>
              名冊 {rosterClassCount} 個班名 · 一致 {exactMatchCount} · 不一致 {mismatchCount}
              <span className="subtle" style={{ fontWeight: 400, marginLeft: '8px' }}>
                （未對應 {unmappedCount}，影響 {unmappedStudents} 位學生）
              </span>
            </div>
          </div>

      {/* 差異表主體 */}
      <div className="card sync-table-card" style={{ padding: '0', overflow: 'hidden', marginBottom: '24px' }}>
        <div className="toolbar" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e2e8f0)' }}>
          <span style={{ fontWeight: 600 }}>班名差異比對（以米豆奶為準）</span>
          <span className="note end" style={{ fontSize: '13px' }}>
            逐列確認合併或新增為課表班級；未處理列將保留於差異表中
          </span>
        </div>

        {mismatches.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted, #64748b)' }}>
            ✓ 名冊中的班級名稱與課表完全一致，無需同步。
          </div>
        ) : (
          <div className="scroll table-scroll-container">
            <table className="data-table sync-mismatch-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ width: '25%' }}>米豆奶班名</th>
                  <th style={{ width: '18%' }}>學生</th>
                  <th style={{ width: '27%' }}>現況</th>
                  <th style={{ width: '30%' }}>動作</th>
                </tr>
              </thead>
              <tbody>
                {mismatches.map((m) => {
                  const erpName = m.erpBaseName;
                  const isStagedRename = stagedRenames.has(erpName);
                  const isStagedNew = stagedNewClasses.has(erpName);
                  const isStaged = isStagedRename || isStagedNew;
                  const stagedFromName = stagedRenames.get(erpName);

                  const isExpanded = expandedRow?.erpBaseName === erpName;
                  const expandMode = isExpanded ? expandedRow.mode : null;

                  // 候選班級：systemOnly 排除已被其他列選走的班級
                  const availableCandidates = systemOnly.filter((c) => {
                    // 若當前列已選中此班，允許它在自己的選項中出現
                    if (stagedFromName === c.baseName) return true;
                    return !claimedSystemNames.has(c.baseName);
                  });

                  // 候選依課程類型分組
                  const groupedCandidates = CLASS_TYPE_ORDER.map((type) => ({
                    type,
                    label: CLASS_TYPE_LABELS[type],
                    classes: availableCandidates.filter((c) => c.classType === type),
                  })).filter((g) => g.classes.length > 0);

                  // 當前選中的目標課表班
                  const selectedTarget =
                    selectedTargetMap[erpName] !== undefined
                      ? selectedTargetMap[erpName]
                      : m.legacyAliasTarget && availableCandidates.some((c) => c.baseName === m.legacyAliasTarget)
                      ? m.legacyAliasTarget
                      : '';

                  const selectedClassType = selectedClassTypeMap[erpName] ?? 'care';
                  const targetCandidateObj = availableCandidates.find((c) => c.baseName === selectedTarget);

                  // 孤兒別名檢測：目標班原有 legacyAliasFrom 排除目前班名後是否有孤兒
                  const orphanedAliases = (targetCandidateObj?.legacyAliasFrom ?? []).filter((name) => name !== erpName);

                  return (
                    <React.Fragment key={erpName}>
                      <tr data-mismatch-row={erpName} style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border-color, #e2e8f0)' }}>
                        <td style={{ fontWeight: 600 }}>{erpName}</td>
                        <td>
                          {m.students} 位 <span className="subtle">（{m.tokens} 筆）</span>
                        </td>
                        <td>
                          {m.legacyAliasTarget === null ? (
                            <span className="pill warn">未對應課表</span>
                          ) : (
                            <span className="pill">經舊對應連到「{m.legacyAliasTarget}」</span>
                          )}
                        </td>
                        <td>
                          {isStagedRename ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span className="pill" style={{ background: 'var(--primary-bg, #e0f2fe)', color: 'var(--primary-text, #0369a1)', fontWeight: 600 }}>
                                已暫存：{stagedFromName} → {erpName}（未儲存）
                              </span>
                              <button
                                type="button"
                                className="btn-secondary"
                                disabled={lockedByReport}
                                onClick={() => onUndoStaged?.(erpName)}
                              >
                                復原
                              </button>
                            </div>
                          ) : isStagedNew ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span className="pill" style={{ background: 'var(--primary-bg, #e0f2fe)', color: 'var(--primary-text, #0369a1)', fontWeight: 600 }}>
                                已暫存新增課表班級（未儲存）
                              </span>
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => onGoToSchedule?.(erpName)}
                              >
                                到課表填時段 →
                              </button>
                              <button
                                type="button"
                                className="btn-secondary"
                                disabled={lockedByReport}
                                onClick={() => onUndoStaged?.(erpName)}
                              >
                                復原
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="btn-secondary"
                                disabled={lockedByReport}
                                aria-expanded={isExpanded && expandMode === 'sync'}
                                onClick={() => {
                                  setExpandedRow((prev) =>
                                    prev?.erpBaseName === erpName && prev.mode === 'sync'
                                      ? null
                                      : { erpBaseName: erpName, mode: 'sync' }
                                  );
                                }}
                              >
                                同步到既有班級
                              </button>
                              <button
                                type="button"
                                className="btn-secondary"
                                disabled={lockedByReport}
                                aria-expanded={isExpanded && expandMode === 'new'}
                                onClick={() => {
                                  setExpandedRow((prev) =>
                                    prev?.erpBaseName === erpName && prev.mode === 'new'
                                      ? null
                                      : { erpBaseName: erpName, mode: 'new' }
                                  );
                                }}
                              >
                                新增為課表班級
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>

                      {/* 列內展開表單 */}
                      {isExpanded && !isStaged && (
                        <tr style={{ background: 'var(--bg-subtle, #f8fafc)', borderBottom: '1px solid var(--border-color, #e2e8f0)' }}>
                          <td colSpan={4} style={{ padding: '16px 20px' }}>
                            {expandMode === 'sync' ? (
                              /* 同步到既有班級展開表單 */
                              <div className="sync-expand-form" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                                  <label htmlFor={`select-target-${erpName}`} style={{ fontWeight: 600 }}>
                                    選擇課表班級：
                                  </label>
                                  <select
                                    id={`select-target-${erpName}`}
                                    aria-label="選擇同步目標課表班級"
                                    value={selectedTarget}
                                    disabled={lockedByReport}
                                    style={{ padding: '6px 10px', minWidth: '240px', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                                    onChange={(e) => {
                                      setSelectedTargetMap((prev) => ({ ...prev, [erpName]: e.target.value }));
                                    }}
                                  >
                                    <option value="">請選擇課表班級...</option>
                                    {groupedCandidates.map((g) => (
                                      <optgroup key={g.type} label={g.label}>
                                        {g.classes.map((c) => {
                                          const isLegacy = c.baseName === m.legacyAliasTarget;
                                          return (
                                            <option key={c.baseName} value={c.baseName}>
                                              {c.baseName} ({c.sessionCount} 個時段){!c.active ? ' [已停用]' : ''}
                                              {isLegacy ? ' (舊對應)' : ''}
                                            </option>
                                          );
                                        })}
                                      </optgroup>
                                    ))}
                                  </select>

                                  <button
                                    type="button"
                                    className="btn-primary"
                                    disabled={lockedByReport || !selectedTarget}
                                    onClick={() => {
                                      if (!selectedTarget) return;
                                      onStageSync?.(erpName, selectedTarget);
                                      setExpandedRow(null);
                                    }}
                                  >
                                    暫存同步
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    disabled={lockedByReport}
                                    onClick={() => setExpandedRow(null)}
                                  >
                                    取消
                                  </button>
                                </div>

                                {selectedTarget && (
                                  <div style={{ marginTop: '4px', lineHeight: 1.6, fontSize: '13px', color: 'var(--text-secondary, #475569)' }}>
                                    <p style={{ margin: 0 }}>
                                      課表班級「{selectedTarget}」將改名為「{erpName}」，{selectedTarget} 的{' '}
                                      {targetCandidateObj?.sessionCount ?? 0} 個時段、課程類型與折扣設定一併沿用。
                                    </p>
                                    {orphanedAliases.length > 0 && (
                                      <p className="notice-warn" style={{ margin: '6px 0 0', color: '#b45309' }}>
                                        ⚠「{orphanedAliases.join('、')}」目前也經舊對應連到 {selectedTarget}，同步後將變成未對應。
                                      </p>
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              /* 新增為課表班級展開表單 */
                              <div className="new-class-expand-form" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                                  <div>
                                    <span style={{ fontWeight: 600, marginRight: '8px' }}>班級名稱：</span>
                                    <input
                                      type="text"
                                      value={erpName}
                                      readOnly
                                      disabled
                                      style={{ padding: '6px 10px', background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                                    />
                                  </div>

                                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                                    <span style={{ fontWeight: 600 }}>課程類型：</span>
                                    {CLASS_TYPE_ORDER.map((type) => (
                                      <label key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                                        <input
                                          type="radio"
                                          name={`new-class-type-${erpName}`}
                                          value={type}
                                          checked={selectedClassType === type}
                                          disabled={lockedByReport}
                                          onChange={() => {
                                            setSelectedClassTypeMap((prev) => ({ ...prev, [erpName]: type }));
                                          }}
                                        />
                                        <span>{CLASS_TYPE_LABELS[type]}</span>
                                      </label>
                                    ))}
                                  </div>

                                  <button
                                    type="button"
                                    className="btn-primary"
                                    disabled={lockedByReport}
                                    onClick={() => {
                                      onStageNewClass?.(erpName, selectedClassType);
                                      setExpandedRow(null);
                                    }}
                                  >
                                    暫存新增
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    disabled={lockedByReport}
                                    onClick={() => setExpandedRow(null)}
                                  >
                                    取消
                                  </button>
                                </div>
                                <p className="note" style={{ margin: 0, fontSize: '13px' }}>
                                  排課類型將建立一列空白時段，請至課表填寫上課時間；不排課類型不排時段。
                                </p>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 底部「課表有、本次名冊沒有的班級」details 展開區 */}
      {systemOnly.length > 0 && (
        <details className="card" style={{ padding: '0', overflow: 'hidden' }}>
          <summary style={{ padding: '12px 16px', fontWeight: 600, cursor: 'pointer' }}>
            課表有、本次名冊沒有的班級 ({systemOnly.length})
          </summary>
          <div style={{ padding: '0 16px 16px' }}>
            <p className="note" style={{ marginBottom: '12px' }}>
              這些班級存在於課表設定中，但本次名冊中無同名報名學生，為同步到既有班級之候選來源。
            </p>
            <div className="scroll table-scroll-container">
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>課表班名</th>
                    <th>課程類型</th>
                    <th>時段數</th>
                    <th>狀態</th>
                    <th>舊別名來源</th>
                  </tr>
                </thead>
                <tbody>
                  {systemOnly.map((c) => (
                    <tr key={c.baseName}>
                      <td style={{ fontWeight: 600 }}>{c.baseName}</td>
                      <td>{CLASS_TYPE_LABELS[c.classType]}</td>
                      <td>{c.sessionCount} 個時段</td>
                      <td>{!c.active ? <span className="pill">已停用</span> : <span className="pill">啟用中</span>}</td>
                      <td>
                        {c.legacyAliasFrom.length > 0 ? (
                          <span className="subtle">{c.legacyAliasFrom.join('、')}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}
        </>
      )}
    </div>
  );
}

export default ClassNameSyncPanel;

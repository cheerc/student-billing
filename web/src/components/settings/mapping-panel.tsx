'use client';

import React from 'react';
import { DynamicCandidate } from '@/domain/schedules/seed-manifest';
import { AliasMapping } from '@/contracts/settings';
import type { ClassNameMatchReport } from '@/application/class-name-match-report';
import { ClassNameReportPanel } from '@/components/settings/class-name-report-panel';

interface MappingPanelProps {
  hasStudents: boolean;
  candidates: DynamicCandidate[];
  aliases: AliasMapping[];
  currentActiveBaseNames?: Set<string>;
  candidateTargets?: Record<string, string>;
  onUpdateCandidateTarget?: (rawBaseName: string, target: string) => void;
  onToggleAlias?: (rawBaseName: string, targetBaseName: string) => void;
  /** 班名比對報告（D1）：兩份清單並排、預設展開；沒有名單或不提供時不顯示 */
  classNameReport?: ClassNameMatchReport | null;
  /** 儲存後重新取得報告失敗的說明：有值時不顯示報告（其數字是儲存前的），改顯示這則標示 */
  classNameReportStaleMessage?: string | null;
  /**
   * 復原階段（UX46；operator 裁決 d-20261002162913018695-69）：
   * retrying＝自動重試中（鎖定候選表、不顯示錯誤畫面）／reload＝請按［重新載入］／reloadPage＝請按［重新整理頁面］。
   * null 時沿用 classNameReportStaleMessage 的舊行為（本頁無報告可刷新時不會進入此狀態）。
   */
  reportRecoveryStage?: 'retrying' | 'reload' | 'reloadPage' | null;
  /** 候選表鎖定：報告重新取得進行中或失敗未恢復，候選依的是過期報告，不可操作 */
  candidatesLocked?: boolean;
  /** ［重新載入］：只重新取得報告（不整頁 reload） */
  onRetryReport?: () => void;
  /** ［重新整理頁面］：整頁 reload */
  onReloadPage?: () => void;
}

export function MappingPanel({
  hasStudents,
  candidates,
  aliases,
  currentActiveBaseNames = new Set(),
  candidateTargets = {},
  onUpdateCandidateTarget = () => {},
  onToggleAlias = () => {},
  classNameReport = null,
  classNameReportStaleMessage = null,
  reportRecoveryStage = null,
  candidatesLocked = false,
  onRetryReport = () => {},
  onReloadPage = () => {},
}: MappingPanelProps) {
  if (!hasStudents) {
    return (
      <div className="card mapping-panel-card" style={{ padding: '32px', textAlign: 'center' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>📋</div>
        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
          匯入名單後，可確認米豆奶班名
        </h3>
        <p className="note" style={{ maxWidth: '480px', margin: '0 auto 16px', lineHeight: 1.6 }}>
          目前系統中尚未匯入學生名冊。當您上傳米豆奶試算表後，若有尚未對齊的班級名稱，將自動列於此處供您確認與建立對應，完全不阻擋先行的課表維護與儲存。
        </p>
      </div>
    );
  }

  const isAliasMapped = (raw: string, target: string) => {
    return aliases.some((a) => a.rawBaseName === raw && a.targetBaseName === target);
  };

  // 復原動作只有一顆按鈕：［重新載入］→［重新整理頁面］。不解釋原因，也不勸告重新匯入（UX46）。
  const showRecoveryAlert = reportRecoveryStage === 'reload' || reportRecoveryStage === 'reloadPage';
  const staleMessage = showRecoveryAlert ? classNameReportStaleMessage : null;

  return (
    <div className="mapping-panel-container">
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
      ) : (
        classNameReport && (
          <div style={{ marginBottom: '20px' }}>
            <ClassNameReportPanel report={classNameReport} />
          </div>
        )
      )}

      <div
        className="card"
        data-candidates-locked={candidatesLocked ? '' : undefined}
        aria-disabled={candidatesLocked ? 'true' : undefined}
        style={{ marginBottom: '20px', opacity: candidatesLocked ? 0.55 : undefined }}
      >
        <div className="toolbar">
          <span style={{ fontWeight: 600 }}>待確認米豆奶班名 ({candidates.length})</span>
          <span className="note end">請為米豆奶匯入的班名指定對應的系統班級</span>
        </div>

        {candidates.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
            ✓ 所有米豆奶班名皆已對齊現有系統班級或已建立對應。
          </div>
        ) : (
          <div className="scroll table-scroll-container">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>對應</th>
                  <th>米豆奶匯入班名</th>
                  <th>學生數／筆數</th>
                  <th>系統對應班級</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const target = candidateTargets[c.rawBaseName] ?? c.suggestedTarget;
                  const isValidTarget = target.trim() === '' || currentActiveBaseNames.has(target.trim());
                  const isChecked = target.trim() && isValidTarget ? isAliasMapped(c.rawBaseName, target.trim()) : false;

                  return (
                    <tr key={c.rawBaseName}>
                      <td>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={candidatesLocked || !target.trim() || !isValidTarget}
                          aria-disabled={candidatesLocked ? 'true' : undefined}
                          onChange={() => {
                            if (!candidatesLocked && target.trim() && isValidTarget) {
                              onToggleAlias(c.rawBaseName, target.trim());
                            }
                          }}
                          aria-label={`確認對應 ${c.rawBaseName}`}
                        />
                      </td>
                      <td style={{ fontWeight: 600 }}>{c.rawBaseName}</td>
                      <td>
                        {c.studentCount} 人 <span className="subtle">({c.tokenCount} 筆)</span>
                      </td>
                      <td>
                        <input
                          type="text"
                          className="input-target-classname"
                          placeholder="請輸入或選擇現有班級"
                          aria-label={`對應目標班級 ${c.rawBaseName}`}
                          value={target}
                          disabled={candidatesLocked}
                          aria-disabled={candidatesLocked ? 'true' : undefined}
                          onChange={(e) => onUpdateCandidateTarget(c.rawBaseName, e.target.value)}
                          style={{
                            borderColor: !isValidTarget ? 'var(--danger-text)' : undefined,
                          }}
                        />
                        {!isValidTarget && (
                          <div style={{ fontSize: '11px', color: 'var(--danger-text)', marginTop: '2px' }}>
                            非現有有效班級
                          </div>
                        )}
                      </td>
                      <td>
                        {isChecked ? (
                          <span className="pill ok">已對應</span>
                        ) : (
                          <span className="pill warn">待確認</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
export default MappingPanel;

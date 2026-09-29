'use client';

import React, { useEffect, useRef } from 'react';
import { SplitClassWarning } from '@/contracts/settings';

export interface SettingsPreviewData {
  mode: 'settings_only' | 'with_students';
  previewId: string;
  inputHash: string;
  expectedRevision: number;
  settingsVersionId: string;
  importId: string | null;
  runId: string | null;
  totalStudents: number | null;
  affectedStudents: number | null;
  mismatchCount?: number | null;
  mismatchBefore?: number | null;
  mismatchAfter?: number | null;
  dayDeltas: Array<{
    personCode: string;
    name: string;
    before: number | null;
    after: number | null;
  }> | null;
}

interface ImpactDialogProps {
  isOpen: boolean;
  mode: 'settings_only' | 'with_students';
  preview: SettingsPreviewData | null;
  splitWarnings: SplitClassWarning[];
  onClose: () => void;
  onApply: () => void;
  applying: boolean;
}

export function ImpactDialog({
  isOpen,
  mode,
  preview,
  splitWarnings,
  onClose,
  onApply,
  applying,
}: ImpactDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [isOpen]);

  // 監聽 Esc 鍵關閉
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isSettingsOnly = mode === 'settings_only' || preview?.mode === 'settings_only';
  const hasDeltas = Array.isArray(preview?.dayDeltas) && preview!.dayDeltas!.length > 0;

  return (
    <dialog
      ref={dialogRef}
      className="impact-dialog"
      aria-labelledby="impactDialogTitle"
      aria-modal="true"
      onClose={onClose}
    >
      <div className="dialoghead">
        <div>
          <h2 id="impactDialogTitle">確認課表變更</h2>
          <p className="note">
            {isSettingsOnly
              ? '系統尚未匯入學生，變更將直接儲存為新版課表設定。'
              : '請檢視本次設定變更對現行學生計費天數的影響，確認無誤後方可套用。'}
          </p>
        </div>
        <button
          type="button"
          className="btn-close"
          onClick={onClose}
          aria-label="關閉確認視窗"
        >
          ✕
        </button>
      </div>

      <div className="dialogbody">
        {/* D28: 班級改散警告 */}
        {splitWarnings.length > 0 && (
          <div className="alert alert-warning" role="alert" style={{ marginBottom: '16px' }}>
            <strong>⚠ 班級改散警示：</strong>
            <p>以下原同名多時段班級被改散拆為不同班名，可能造成學生原報名歸屬分流：</p>
            <ul>
              {splitWarnings.map((w) => (
                <li key={w.originalName}>
                  原班級「{w.originalName}」被拆為：{w.splitNames.join('、')}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 模式一：無學生 settings_only */}
        {isSettingsOnly ? (
          <div className="settings-only-notice">
            <div className="notice-box">
              <span className="notice-badge">尚未匯入學生</span>
              <p className="notice-desc">
                目前系統尚未匯入任何學生收費名冊。儲存後課表設定將立即生效，後續匯入之學生名單將直接採用此設定進行排課衝堂與天數扣除計算。
              </p>
            </div>
            <div className="metrics-grid">
              <div className="metric-card">
                <span className="metric-label">受影響學生</span>
                <strong className="metric-value">—</strong>
                <span className="metric-sub">尚未匯入學生名單</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">預估影響天數</span>
                <strong className="metric-value">—</strong>
                <span className="metric-sub">無學生可供試算</span>
              </div>
            </div>
          </div>
        ) : (
          /* 模式二：有學生 with_students */
          <div className="with-students-preview">
            <div className="metrics-grid">
              <div className="metric-card">
                <span className="metric-label">受影響學生數</span>
                <strong className="metric-value">{preview?.affectedStudents ?? 0} 人</strong>
                <span className="metric-sub">天數發生變化</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">級距差異學生數</span>
                <strong className="metric-value">
                  mismatch {preview?.mismatchBefore ?? 0} → {preview?.mismatchAfter ?? preview?.mismatchCount ?? 0} 筆
                </strong>
                <span className="metric-sub">天數變動致級距異動</span>
              </div>
            </div>

            {hasDeltas ? (
              <div className="deltas-table-container">
                <h3 className="section-title">天數變動明細（前 50 筆）</h3>
                <div className="scroll table-scroll-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>人員代碼</th>
                        <th>姓名</th>
                        <th>變更前天數</th>
                        <th>變更後天數</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview!.dayDeltas!.slice(0, 50).map((d) => (
                        <tr key={d.personCode}>
                          <td className="code-text">{d.personCode}</td>
                          <td>{d.name}</td>
                          <td>{d.before ?? '-'}</td>
                          <td className="after-bold">{d.after ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="note" style={{ marginTop: '16px' }}>
                本次課表變更未改變現行學生的收費天數。
              </p>
            )}
          </div>
        )}
      </div>

      <div className="dialogfooter">
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          disabled={applying}
        >
          繼續編輯
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={onApply}
          disabled={applying}
        >
          {applying
            ? '儲存中...'
            : isSettingsOnly
            ? '儲存課表'
            : '儲存並更新結果'}
        </button>
      </div>
    </dialog>
  );
}
export default ImpactDialog;

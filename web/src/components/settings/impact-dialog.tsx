'use client';

import React, { useEffect, useRef } from 'react';
import { SplitClassWarning } from '@/contracts/settings';
import { CATEGORY_LABELS } from '@/domain/classification/class-attributes';
import { ErrorNotice } from '@/components/ui/error-notice';
import type { UserFacingError } from '@/lib/user-messages';

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
  /**
   * D2b r2（R2-2／Q13／06 D37）：跨類別別名提示。**不阻擋儲存**，只在使用者確認前列出
   * 哪些別名的折扣類別將改由系統班決定。
   */
  aliasCategoryNotices?: Array<{
    rawBaseName: string;
    targetBaseName: string;
    rawDetected: 'care' | 'math' | 'english' | 'none';
    targetDetected: 'care' | 'math' | 'english' | 'none';
  }>;
}

interface ImpactDialogProps {
  isOpen: boolean;
  mode: 'settings_only' | 'with_students';
  preview: SettingsPreviewData | null;
  splitWarnings: SplitClassWarning[];
  onClose: () => void;
  onApply: () => void;
  applying: boolean;
  /** 預覽或套用失敗：顯示白話說明（代碼在詳細資訊）；此時不顯示任何影響數字，也不能套用。 */
  error?: UserFacingError | null;
  /** 預覽計算中：不顯示 0 人或「未改變」，避免把未知冒充成沒有影響。 */
  loading?: boolean;
}

export function ImpactDialog({
  isOpen,
  mode,
  preview,
  splitWarnings,
  onClose,
  onApply,
  applying,
  error = null,
  loading = false,
}: ImpactDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // 關閉返回焦點（09 §6）：開啟前記住觸發元素，關閉（含 Esc、取消、套用成功）後還給它。
  // 本元件在 isOpen=false 時直接卸載 <dialog>，瀏覽器原生的「關閉時還原焦點」不會發生，所以要明確處理。
  // 宣告順序必須在 showModal 的 effect 之前：那時 activeElement 還是被點的「確認變更」按鈕。
  useEffect(() => {
    if (!isOpen) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      const opener = openerRef.current;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [isOpen]);

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
  const aliasNotices = preview?.aliasCategoryNotices ?? [];

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

        {/* 失敗：白話說明＋可展開的詳細資訊；不顯示任何影響數字（沒有預覽就沒有數字） */}
        {error && <ErrorNotice data-dialog-error="" message={error.message} detail={error.detail} />}

        {/* 計算中：未知不可冒充「0 人」或「沒有變更」 */}
        {!error && loading && !preview && (
          <p className="note" role="status" data-dialog-loading="">
            正在計算這次修改對學生天數的影響…
          </p>
        )}

        {/* 模式一：無學生 settings_only */}
        {error || (loading && !preview) ? null : isSettingsOnly ? (
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
                <span className="metric-sub">天數、科數或折扣有變化（每人只計一次）</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">米豆奶入班天數比對</span>
                <strong className="metric-value metric-sentence">
                  {`系統計算天數與米豆奶入班天數不符：${preview?.mismatchBefore ?? 0} 人 → ${
                    preview?.mismatchAfter ?? preview?.mismatchCount ?? 0
                  } 人`}
                </strong>
                <span className="metric-sub">每位學生只要有任一級距比較不符就算 1 人</span>
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

      {aliasNotices.length > 0 && (
        <details className="alert alert-warning" data-alias-category-notice="" style={{ marginTop: '16px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            {aliasNotices.length} 個別名的類別將改由系統班決定
          </summary>
          <p className="note" style={{ marginTop: '8px' }}>
            下列米豆奶班名對應到系統班級後，其折扣類別會以系統班為準。這是提示，不會阻止您儲存。
          </p>
          <ul style={{ marginTop: '8px', paddingLeft: '20px' }}>
            {aliasNotices.map((n) => (
              <li key={n.rawBaseName}>
                {n.rawBaseName}（{CATEGORY_LABELS[n.rawDetected]}）→ {n.targetBaseName}（
                {CATEGORY_LABELS[n.targetDetected]}）
              </li>
            ))}
          </ul>
        </details>
      )}

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
          disabled={applying || Boolean(error) || loading || !preview}
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

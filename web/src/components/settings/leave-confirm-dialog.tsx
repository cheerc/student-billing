'use client';

import React, { useEffect, useRef } from 'react';
import { restoreFocusToOpener } from '@/components/ui/restore-focus-to-opener';

interface LeaveConfirmDialogProps {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

/**
 * 離頁確認視窗（09 §3.2；D38 F07）：課表有未儲存的修改時，從站內離開前先問。
 * 「繼續編輯」是預設焦點與 Esc 的結果（不會丟草稿）；「捨棄修改」才離開。
 */
export function LeaveConfirmDialog({ open, onKeepEditing, onDiscard }: LeaveConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // 關閉後把焦點還給觸發元素（被點的連結／頁面上原本的焦點）。與 impact-dialog 共用 restoreFocusToOpener：
  // 觸發元素若在離頁確認開著期間變 disabled（debounce 觸發的計算），關閉當下 focus() 會落空，
  // 需等它恢復可聚焦後補還原（issue #48）。
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    return () => restoreFocusToOpener(openerRef.current);
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="impact-dialog leave-dialog"
      aria-labelledby="leaveDialogTitle"
      aria-describedby="leaveDialogDesc"
      aria-modal="true"
      onCancel={(e) => {
        // Esc：等同「繼續編輯」，不離開也不丟草稿
        e.preventDefault();
        onKeepEditing();
      }}
    >
      <div className="dialoghead">
        <div>
          <h2 id="leaveDialogTitle">有尚未儲存的課表修改</h2>
          <p className="note" id="leaveDialogDesc">
            離開這一頁後，這些修改會消失。要繼續編輯，還是捨棄修改並離開？
          </p>
        </div>
      </div>
      <div className="dialogfooter">
        <button type="button" className="btn-primary" onClick={onKeepEditing} autoFocus>
          繼續編輯
        </button>
        <button type="button" className="btn-secondary" onClick={onDiscard}>
          捨棄修改
        </button>
      </div>
    </dialog>
  );
}
export default LeaveConfirmDialog;

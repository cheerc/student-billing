'use client';

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { createUnsavedGuard, unwindSentinel, type LeaveRequest, type UnsavedGuard } from '@/lib/unsaved-guard';

/**
 * 未儲存修改的離頁提醒（09 §3.2；D38 F07）。`dirty` 為 true 時才啟用守衛；儲存成功、取消修改（dirty 變 false）
 * 或元件卸載即解除，不會裝在已儲存或唯讀的頁面上。
 *
 * - `pending`：使用者剛才嘗試的離開動作（同一時間只保留一個，重複觸發不會累積確認視窗）。
 * - `keepEditing()`：關閉確認，草稿保留、留在原頁。
 * - `discardAndLeave()`：捨棄草稿（呼叫 onDiscard）並只導覽一次。
 */
export function useUnsavedChangesGuard(dirty: boolean, onDiscard: () => void) {
  // 直接讀 App Router 的 context（沒有 router 的環境，例如單元測試的靜態轉譯，回傳 null 而不是丟出錯誤）；
  // 沒有 router 時以整頁導覽作為後備，行為仍是「只導覽一次」。
  const router = useContext(AppRouterContext);
  const [pending, setPending] = useState<LeaveRequest | null>(null);
  const pendingRef = useRef<LeaveRequest | null>(null);
  const guardRef = useRef<UnsavedGuard | null>(null);
  const sentinelLeftRef = useRef(false);
  const wasDirtyRef = useRef(false);
  const onDiscardRef = useRef(onDiscard);

  useEffect(() => {
    onDiscardRef.current = onDiscard;
  });

  useEffect(() => {
    if (!dirty) return;
    const guard = createUnsavedGuard({
      onAttempt: (request) => {
        // 已有一個確認在等使用者回答：不再疊加第二層（哨兵已由守衛補回，狀態一致）
        if (pendingRef.current) return;
        pendingRef.current = request;
        setPending(request);
      },
    });
    guardRef.current = guard;
    guard.arm();
    return () => {
      sentinelLeftRef.current = guard.release();
      guardRef.current = null;
      pendingRef.current = null;
    };
  }, [dirty]);

  // 仍停留在此頁而 dirty 變回 false（儲存成功、取消修改）：退掉哨兵紀錄，Back 一步就是上一頁。
  // 卸載時這個 effect 不會執行，所以不會在頁面被取代的途中再退一步。
  useEffect(() => {
    if (wasDirtyRef.current && !dirty && sentinelLeftRef.current) {
      sentinelLeftRef.current = false;
      unwindSentinel();
    }
    wasDirtyRef.current = dirty;
  }, [dirty]);

  const keepEditing = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
  }, []);

  const discardAndLeave = useCallback(() => {
    const request = pendingRef.current;
    const guard = guardRef.current;
    pendingRef.current = null;
    setPending(null);
    if (!request || !guard) return;
    // 先讓守衛解除並開始離開（同步標記），再重設草稿；leave 只會導覽一次
    void guard.leave(request, (href) => {
      if (router) router.push(href);
      else window.location.assign(href);
    });
    onDiscardRef.current();
  }, [router]);

  return { pending: dirty ? pending : null, keepEditing, discardAndLeave };
}

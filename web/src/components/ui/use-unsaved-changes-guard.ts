'use client';

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  createUnsavedGuardController,
  type LeaveRequest,
} from '@/lib/unsaved-guard';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * 未儲存修改的離頁提醒（09 §3.2；D38 F07；Issue #207 Phase 2）。
 *
 * 持久 Controller 狀態機模式：
 * - 支援 React 19 StrictMode 雙掛載。
 * - 以 useLayoutEffect 於 commit 階段同步觸發 syncDirty(dirty)，消除 passive effect 排程延遲。
 * - 結算期間保護站內連結排隊，防止導航目標遺失。
 * - 快速再編輯自動合併在途 go(-1)，新草稿零空窗保護且不誤跳確認視窗。
 */
export function useUnsavedChangesGuard(dirty: boolean, onDiscard: () => void) {
  const router = useContext(AppRouterContext);
  const [pending, setPending] = useState<LeaveRequest | null>(null);
  const onDiscardRef = useRef(onDiscard);
  const routerRef = useRef(router);

  useEffect(() => {
    onDiscardRef.current = onDiscard;
    routerRef.current = router;
  });

  // 持久 Controller 狀態機（全生命週期單一實例）
  const [controller] = useState(() =>
    createUnsavedGuardController({
      onAttempt: (request) => {
        setPending((prev) => (prev ? prev : request));
      },
    })
  );

  useEffect(() => {
    controller.setNavigate((href) => {
      if (routerRef.current) routerRef.current.push(href);
      else if (typeof window !== 'undefined') window.location.href = href;
    });
  }, [controller, router]);

  // 以 useLayoutEffect 於 commit 階段同步觸發 syncDirty，消除 passive effect 排程延遲
  useIsomorphicLayoutEffect(() => {
    controller.syncDirty(dirty);
  }, [dirty, controller]);

  // 元件真正卸載時釋放
  useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  const keepEditing = useCallback(() => {
    setPending(null);
    controller.keepEditing();
  }, [controller]);

  const discardAndLeave = useCallback(() => {
    setPending((currentPending) => {
      if (currentPending) {
        controller.discardAndLeave(currentPending, (href) => {
          if (routerRef.current) routerRef.current.push(href);
          else if (typeof window !== 'undefined') window.location.href = href;
        });
      }
      return null;
    });
    onDiscardRef.current();
  }, [controller]);

  return { pending: dirty ? pending : null, keepEditing, discardAndLeave };
}

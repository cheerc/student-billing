'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { installEarlyPopstateListener } from '@/lib/leave-guard-registry';
import { resetImportGuide, shouldHighlightResults, useImportGuide } from '@/lib/import-success-guide';

// 根版面載入時（Next 掛載之前）先安裝 popstate 先手監聽器，讓離頁守衛的處理器排在 Next 前面（09 §3.2）
installEarlyPopstateListener();

export function AppNav() {
  const pathname = usePathname();
  // #84：匯入成功後指向 03；抵達 03（/）即視為引導完成，永久清除、不復發。
  const guideActive = useImportGuide();
  useEffect(() => {
    if (pathname === '/') resetImportGuide();
  }, [pathname]);

  const isSchedule = pathname.startsWith('/settings');
  const isImports = pathname.startsWith('/imports');
  const isResults = pathname === '/';
  const isHistory = pathname.startsWith('/history');
  // 柔和靜態外框（非脈衝／非無限循環）：UI/UX Pro Max Continuous Animation —
  // 無限動畫只該用於載入指示器，不用於裝飾性元素。高亮表達「下一步在哪裡」，
  // 不是「發生了什麼」，因此不用 aria-live／role=alert，只靠既有項目名稱與連結語意。
  const highlightResults = shouldHighlightResults(guideActive, pathname);

  return (
    <aside className="side" aria-label="主要導覽">
      <div className="brand">
        <Link href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="brand-title" style={{ margin: 0, fontSize: '16px', fontWeight: 750, color: 'inherit' }}>
            學生收費核對工具
          </div>
          <small>CLASS & STUDENT REVIEW</small>
        </Link>
      </div>

      <nav className="nav-list" aria-label="系統流程步驟">
        <Link
          href="/settings?tab=schedule"
          className={`nav-item ${isSchedule ? 'active' : ''}`}
          aria-current={isSchedule ? 'page' : undefined}
        >
          <span className="step-num">01</span>
          <span className="step-label">課表設定</span>
        </Link>

        <Link
          href="/imports"
          className={`nav-item ${isImports ? 'active' : ''}`}
          aria-current={isImports ? 'page' : undefined}
        >
          <span className="step-num">02</span>
          <span className="step-label">匯入學生</span>
        </Link>

        <Link
          href="/"
          className={`nav-item ${isResults ? 'active' : ''} ${highlightResults ? 'nav-item-highlight' : ''}`}
          aria-current={isResults ? 'page' : undefined}
          data-testid="nav-item-results"
        >
          <span className="step-num">03</span>
          <span className="step-label">核對結果</span>
        </Link>
      </nav>

      <div className="sidefoot">
        <Link
          href="/history"
          className={`nav-item ${isHistory ? 'active' : ''}`}
          aria-current={isHistory ? 'page' : undefined}
        >
          <span className="step-label">匯入紀錄</span>
        </Link>
        <div className="sidefoot-hint">
          依日期或檔名，查過去匯入的名單與當時的結果
        </div>
      </div>
    </aside>
  );
}
export default AppNav;

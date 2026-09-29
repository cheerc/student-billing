'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function AppNav() {
  const pathname = usePathname();

  const isSchedule = pathname.startsWith('/settings');
  const isImports = pathname.startsWith('/imports');
  const isResults = pathname === '/';
  const isHistory = pathname.startsWith('/history');

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
          className={`nav-item ${isResults ? 'active' : ''}`}
          aria-current={isResults ? 'page' : undefined}
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
          依班級查看每位學生的天數與折扣
        </div>
      </div>
    </aside>
  );
}
export default AppNav;

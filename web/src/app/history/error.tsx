'use client';

import Link from 'next/link';

/**
 * 匯入紀錄載入失敗（UX21 失敗態）：白話說明、可重試、可離開；原始錯誤只放摺疊區。
 * 不假裝成功，也不顯示空表格。
 */
export default function HistoryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="history-page">
      <header className="page-header history-header">
        <div>
          <h1>匯入紀錄</h1>
        </div>
      </header>
      <div className="state-card state-error" role="alert">
        <h2 className="state-title">無法載入匯入紀錄</h2>
        <p className="state-desc">資料暫時讀不到，您的名單與核對結果沒有受影響。請重試；若仍失敗，可先回到核對結果。</p>
        <div className="state-actions">
          <button type="button" className="btn-primary" onClick={reset}>重試</button>
          <Link href="/" className="btn-secondary">回到核對結果</Link>
        </div>
        <details className="tech-info">
          <summary>技術資訊</summary>
          <pre className="tech-pre">{error.message}{error.digest ? `\n(${error.digest})` : ''}</pre>
        </details>
      </div>
    </div>
  );
}

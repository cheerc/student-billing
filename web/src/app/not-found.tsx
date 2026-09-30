import Link from 'next/link';

/**
 * 找不到頁面（網址打錯或已不存在）：白話說明並提供回到主要頁面的路，
 * 不顯示框架預設的英文 404 頁（09 §7：所有使用者可見狀態都要有中文說明與下一步）。
 */
export default function NotFound() {
  return (
    <div className="history-page">
      <header className="page-header history-header">
        <div>
          <h1>找不到這個頁面</h1>
        </div>
      </header>
      <div className="state-card">
        <h2 className="state-title">這個網址沒有對應的頁面</h2>
        <p className="state-desc">網址可能打錯了，或這個頁面已經不存在。您的名單與核對結果沒有受影響。</p>
        <div className="state-actions">
          <Link href="/" className="btn-primary">回到核對結果</Link>
          <Link href="/imports" className="btn-secondary">匯入學生</Link>
        </div>
      </div>
    </div>
  );
}

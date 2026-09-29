import Link from 'next/link';

/** 找不到這筆歷史紀錄（網址錯誤或資料已不存在）：說明原因並提供離開路徑。 */
export default function HistoryNotFound() {
  return (
    <div className="history-page">
      <header className="page-header history-header">
        <div>
          <h1>找不到這筆紀錄</h1>
        </div>
      </header>
      <div className="state-card" role="status">
        <p className="state-desc">這筆匯入紀錄不存在，或已經被移除。請回到匯入紀錄重新選擇。</p>
        <Link href="/history" className="btn-primary">回到匯入紀錄</Link>
      </div>
    </div>
  );
}

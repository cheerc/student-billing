/**
 * 匯入紀錄載入中（UX21 loading 態）：明確告知在載入，不顯示舊資料冒充完成。
 */
export default function HistoryLoading() {
  return (
    <div className="history-page">
      <header className="page-header history-header">
        <div>
          <h1>匯入紀錄</h1>
        </div>
      </header>
      <div className="state-card" role="status" aria-live="polite">
        <p className="state-desc">載入匯入紀錄中…</p>
      </div>
    </div>
  );
}

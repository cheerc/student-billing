import Link from 'next/link';

export default function ImportsPage() {
  return (
    <div className="empty-card">
      <div className="empty-icon">📤</div>
      <h2 className="empty-title">上傳 ERP 學生名單</h2>
      <p className="empty-desc">
        真實 XLSX 匯入與標頭驗證模組將於 T01 切片交付。
      </p>
      <div>
        <Link href="/" className="btn-primary">
          返回首頁
        </Link>
      </div>
    </div>
  );
}

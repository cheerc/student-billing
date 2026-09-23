import Link from 'next/link';
import { getDefaultDatabasePath } from '@/adapters/sqlite/db';

export default function HomePage() {
  const dbPath = getDefaultDatabasePath();

  return (
    <div className="empty-card">
      <div className="empty-icon">📁</div>
      <h2 className="empty-title">尚未匯入學生收費名單</h2>
      <p className="empty-desc">
        系統目前為初始空狀態。請點選下方按鈕上傳 ERP 學生名單試算表 (XLSX) 建立新批次，本工具不包含任何假示範資料。
      </p>

      <div className="path-box">
        <div className="path-label">本機資料庫與儲存路徑 (Local Storage Path)：</div>
        <div className="path-code">{dbPath}</div>
        <div style={{ marginTop: '6px', fontSize: '0.75rem', color: '#64748b' }}>
          資料目錄：student-billing/data/（受 .gitignore 保護，敏感個資絕不外流）
        </div>
      </div>

      <div>
        <Link href="/imports" className="btn-primary">
          前往匯入名單 (Upload XLSX)
        </Link>
      </div>
    </div>
  );
}

import Link from 'next/link';
import { getDatabase, getDefaultDatabasePath } from '@/adapters/sqlite';
import { getLatestReadyBatch } from '@/adapters/sqlite/import-repository';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { queryImportStudents } from '@/application/roster-query';
import { queryRunStudents } from '@/application/query-students';
import RosterView from '@/components/roster-view';
import ActiveRunView from '@/components/active-run-view';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const db = getDatabase();
  const dbPath = getDefaultDatabasePath();
  const currentActive = getCurrentActiveRun(db);

  // 若已有啟用的正式 Run，進入展示B核對總表
  if (currentActive.run && currentActive.activeRunId) {
    const activeRun = currentActive.run;
    const initialRunData = queryRunStudents(db, activeRun.id, { limit: 50 });

    const classRows = db
      .prepare(`
        SELECT DISTINCT base_name
        FROM student_enrollments
        WHERE import_id = ?
        ORDER BY base_name ASC
      `)
      .all(activeRun.importId) as { base_name: string }[];

    const availableClasses = classRows.map((r) => r.base_name);

    return (
      <div>
        <ActiveRunView
          runId={activeRun.id}
          revision={currentActive.revision}
          asOfDate={activeRun.asOfDate}
          initialAvailableClasses={availableClasses}
          initialData={initialRunData}
        />
      </div>
    );
  }

  // 若尚未啟用但有 ready 批次，呈現展示A名冊與「啟用計算」按鈕
  const latestBatch = getLatestReadyBatch(db);
  if (latestBatch) {
    const classRows = db
      .prepare(`
        SELECT DISTINCT base_name
        FROM student_enrollments
        WHERE import_id = ?
        ORDER BY base_name ASC
      `)
      .all(latestBatch.id) as { base_name: string }[];

    const availableClasses = classRows.map((r) => r.base_name);
    const initialData = queryImportStudents(db, latestBatch.id, { limit: 50 });

    return (
      <div>
        <RosterView
          importId={latestBatch.id}
          fileName={latestBatch.fileName}
          initialAvailableClasses={availableClasses}
          initialData={initialData}
          currentRevision={currentActive.revision}
        />
      </div>
    );
  }

  // 初始空狀態
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
          資料目錄：data/（受 .gitignore 保護，敏感個資絕不外流）
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

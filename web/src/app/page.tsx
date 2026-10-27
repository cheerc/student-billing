import Link from 'next/link';
import { getDatabase } from '@/adapters/sqlite';
import { getLatestSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { formatDateTime } from '@/lib/datetime';
import { getLatestReadyBatch } from '@/adapters/sqlite/import-repository';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { queryImportStudents } from '@/application/roster-query';
import { resolveResultsView } from '@/application/results-view';
import RosterView from '@/components/roster-view';
import ActiveRunView from '@/components/active-run-view';
import { findUnmappedClasses, getScheduleDeductions } from '@/application/schedule-deductions';
import { getImportBatch } from '@/adapters/sqlite/import-repository';
import { loadRunClassCategories } from '@/application/applicable-rate';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const rawParams = (await searchParams) ?? {};
  const db = getDatabase();
  const currentActive = getCurrentActiveRun(db);

  // 若已有啟用的正式 Run，進入展示B核對總表
  if (currentActive.run && currentActive.activeRunId) {
    const activeRun = currentActive.run;
    const classRows = db
      .prepare(`
        SELECT DISTINCT base_name
        FROM student_enrollments
        WHERE import_id = ?
        ORDER BY base_name ASC
      `)
      .all(activeRun.importId) as { base_name: string }[];

    const availableClasses = classRows.map((r) => r.base_name);
    const sourceBatch = getImportBatch(db, activeRun.importId);
    // 頁籤與兩頁籤各自的條件由網址還原（重新整理／返回不丟）；姓名搜尋不在網址
    const view = resolveResultsView(db, activeRun.id, rawParams);

    return (
      <div>
        <ActiveRunView
          key={activeRun.id}
          initialDeductions={getScheduleDeductions(db, { runId: activeRun.id })}
          runId={activeRun.id}
          revision={currentActive.revision}
          asOfDate={activeRun.asOfDate}
          source={{
            fileName: sourceBatch?.fileName ?? '（來源檔案已不存在）',
            importedAt: sourceBatch?.createdAt ?? activeRun.createdAt,
            updatedAt: activeRun.createdAt,
          }}
          unmappedClasses={findUnmappedClasses(db, activeRun.id, availableClasses)}
          classCategorySnapshots={loadRunClassCategories(db, activeRun.id)}
          initialData={view.data}
          initialOptions={view.options}
          initialView={view.view}
          initialFilters={view.filters}
          initialDeductionFilters={view.deductionFilters}
          initialNotices={{ invalid: view.invalid, pruned: view.pruned }}
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

  // 初始空狀態（09 §2）：初始首頁主動作「先確認課表」、次動作「匯入學生」；
  // 已儲存過課表則主動作改為「匯入學生」。seed 課表只說「已載入，請確認」，不假稱人員已確認。
  const savedSettings = getLatestSettingsVersion(db);

  return (
    <div>
      <header className="page-header" style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '0 0 6px' }}>學生收費核對工具</h1>
        <p className="note" style={{ margin: 0 }}>先確認課表，再匯入學生名單，就能依班級核對每位學生的天數與折扣。</p>
      </header>

      <div className="empty-card">
        <h2 className="empty-title">還沒有可核對的學生資料</h2>
        {savedSettings ? (
          <>
            <p className="empty-desc">
              {`課表已儲存（${formatDateTime(savedSettings.createdAt)}）。接著匯入學生名單，就能開始核對。`}
            </p>
            <div className="state-actions">
              <Link href="/imports" className="btn-primary">匯入學生</Link>
              <Link href="/settings?tab=schedule" className="btn-secondary">查看課表</Link>
            </div>
          </>
        ) : (
          <>
            <p className="empty-desc">已載入初始課表，請先確認課表；確認後再匯入學生名單。</p>
            <div className="state-actions">
              <Link href="/settings?tab=schedule" className="btn-primary">先確認課表</Link>
              <Link href="/imports" className="btn-secondary">匯入學生</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

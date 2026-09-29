import { notFound } from 'next/navigation';
import { getDatabase } from '@/adapters/sqlite';
import { getImportBatch } from '@/adapters/sqlite/import-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { findUnmappedClasses, getScheduleDeductions } from '@/application/schedule-deductions';
import { getRunDeductionsOrReason } from '@/application/history-view';
import { queryRunStudents } from '@/application/query-students';
import ActiveRunView from '@/components/active-run-view';
import { sanitizePathParam } from '@/contracts/security';

export const dynamic = 'force-dynamic';

/**
 * 歷史資料的唯讀檢視（specs/09 §5.2、§8.3；UX21）：
 * 學生總表與班級扣天都讀該 run 當時的資料與課表快照，不套用最新設定；
 * 快照資料不足時明示無法重建。整頁沒有任何寫入動作，也沒有「恢復為現行」。
 */
export default async function HistoryRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId: rawRunId } = await params;
  let runId: string;
  try {
    runId = sanitizePathParam(rawRunId, 'runId');
  } catch {
    notFound();
  }

  const db = getDatabase();
  const run = getCalculationRun(db, runId);
  if (!run) notFound();

  const batch = getImportBatch(db, run.importId);
  const initialData = queryRunStudents(db, run.id, { limit: 50 });
  const availableClasses = (
    db
      .prepare('SELECT DISTINCT base_name FROM student_enrollments WHERE import_id = ? ORDER BY base_name ASC')
      .all(run.importId) as { base_name: string }[]
  ).map((r) => r.base_name);

  const deductions = getRunDeductionsOrReason(db, run.id);

  return (
    <ActiveRunView
      mode="history"
      runId={run.id}
      revision={0}
      asOfDate={run.asOfDate}
      source={{
        fileName: batch?.fileName ?? '（來源檔案已不存在）',
        importedAt: batch?.createdAt ?? run.createdAt,
        updatedAt: run.createdAt,
      }}
      initialAvailableClasses={availableClasses}
      initialData={initialData}
      initialDeductions={deductions.status === 'ok' ? deductions.data : undefined}
      deductionsUnavailable={
        deductions.status === 'unavailable' ? { code: deductions.code, message: deductions.message } : undefined
      }
      unmappedClasses={findUnmappedClasses(db, run.id, availableClasses)}
    />
  );
}

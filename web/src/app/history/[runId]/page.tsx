import { notFound } from 'next/navigation';
import { getDatabase } from '@/adapters/sqlite';
import { getImportBatch } from '@/adapters/sqlite/import-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { findUnmappedClasses, getScheduleDeductions } from '@/application/schedule-deductions';
import { getRunDeductionsOrReason } from '@/application/history-view';
import { resolveResultsView } from '@/application/results-view';
import ActiveRunView from '@/components/active-run-view';
import { sanitizePathParam } from '@/contracts/security';

export const dynamic = 'force-dynamic';

/**
 * 歷史資料的唯讀檢視（specs/09 §5.2、§8.3；UX21）：
 * 學生總表與班級扣天都讀該 run 當時的資料與課表快照，不套用最新設定；
 * 快照資料不足時明示無法重建。整頁沒有任何寫入動作，也沒有「恢復為現行」。
 */
export default async function HistoryRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { runId: rawRunId } = await params;
  const rawParams = (await searchParams) ?? {};
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
  const view = resolveResultsView(db, run.id, rawParams);
  const availableClasses = (
    db
      .prepare('SELECT DISTINCT base_name FROM student_enrollments WHERE import_id = ? ORDER BY base_name ASC')
      .all(run.importId) as { base_name: string }[]
  ).map((r) => r.base_name);

  const deductions = getRunDeductionsOrReason(db, run.id);

  return (
    <ActiveRunView
      key={run.id}
      mode="history"
      runId={run.id}
      revision={0}
      asOfDate={run.asOfDate}
      source={{
        fileName: batch?.fileName ?? '（來源檔案已不存在）',
        importedAt: batch?.createdAt ?? run.createdAt,
        updatedAt: run.createdAt,
      }}
      initialData={view.data}
      initialOptions={view.options}
      initialView={view.view}
      initialFilters={view.filters}
      initialDeductionFilters={view.deductionFilters}
      initialNotices={{ invalid: view.invalid, pruned: view.pruned }}
      initialDeductions={deductions.status === 'ok' ? deductions.data : undefined}
      deductionsUnavailable={
        deductions.status === 'unavailable' ? { code: deductions.code, message: deductions.message } : undefined
      }
      unmappedClasses={findUnmappedClasses(db, run.id, availableClasses)}
      classCategorySnapshots={run.classCategories ?? null}
      classSemanticSnapshots={run.classSemantics ?? null}
      classCategoryRuleSetVersion={run.ruleSetVersion}
    />
  );
}

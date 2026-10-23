import { getDatabase } from '@/adapters/sqlite';
import { getLatestReadyBatch } from '@/adapters/sqlite/import-repository';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestSettingsVersion, buildSeedDraft, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { SEED_CLASSES, classifyErpDualTrack } from '@/domain/schedules/seed-manifest';
import { normalizeSettingsDraftSemantics } from '@/domain/classification/class-semantics';
import type { LegacySemanticMigrationCandidate } from '@/domain/classification/legacy-semantic-migration';
import { SettingsDraft } from '@/contracts/settings';
import SettingsEditor from '@/components/settings-editor';
import { getClassNameMatchReport } from '@/application/class-name-match-report';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const sp = (await searchParams) ?? {};
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const focusClass = first(sp.class)?.trim() || null;
  const initialTab = first(sp.tab) === 'mapping' ? 'mapping' : 'schedule';
  const db = getDatabase();
  const active = getCurrentActiveRun(db);
  const latestBatch = getLatestReadyBatch(db);
  const importId = active.activeImportId ?? latestBatch?.id ?? null;
  const hasActiveImport = Boolean(active.activeImportId);
  // 班名對應要檢視的名單：預設＝現行名單（無則最新一批）；網址 ?import= 指定另一批（匯入預覽「完整班名比對報告」連結，
  // 名單尚未啟用也能看）。只影響班名對應的統計與報告；儲存設定仍以現行名單為準（editor 的 importId 不變）。
  const requestedImportId = first(sp.import)?.trim() || null;
  const requestedBatchExists = requestedImportId
    ? Boolean(db.prepare("SELECT 1 FROM import_batches WHERE id = ? AND status = 'ready'").get(requestedImportId))
    : false;
  const reviewImportId = requestedBatchExists ? requestedImportId : importId;

  let erpBaseNames: string[] = [];
  const candidateCounts = new Map<string, { studentCount: number; tokenCount: number }>();

  if (reviewImportId) {
    const enrollmentRows = db
      .prepare(
        `SELECT base_name,
                COUNT(*) AS token_count,
                COUNT(DISTINCT person_code) AS student_count
           FROM student_enrollments WHERE import_id = ? GROUP BY base_name`
      )
      .all(reviewImportId) as Array<{ base_name: string; token_count: number; student_count: number }>;
    erpBaseNames = enrollmentRows.map((r) => r.base_name);
    for (const r of enrollmentRows) {
      candidateCounts.set(r.base_name, {
        studentCount: Number(r.student_count),
        tokenCount: Number(r.token_count),
      });
    }
  }

  const latest = getLatestSettingsVersion(db);
  const storedDraft = latest ? readStoredDraft(latest.contentJson) : null;
  const legacySemanticMigrationCandidates: LegacySemanticMigrationCandidate[] = storedDraft
    ? storedDraft.classes.flatMap((item) => {
        if (SEED_CLASSES.some((seed) => seed.baseName === item.baseName)) return [];
        const migrateSummaryDayRoles = item.summaryDayRoles === undefined &&
          item.summaryDayRolesStatus === undefined && item.summaryDayRolesSource === undefined;
        const migrateErpTierApplicability = item.erpTierApplicability === undefined &&
          item.erpTierApplicabilitySource === undefined;
        return migrateSummaryDayRoles || migrateErpTierApplicability
          ? [{ baseName: item.baseName, migrateSummaryDayRoles, migrateErpTierApplicability }]
          : [];
      })
    : [];
  const initialDraft: SettingsDraft = storedDraft
    ? normalizeSettingsDraftSemantics(storedDraft)
    : buildSeedDraft(SEED_CLASSES, {
        anqin: { start: 780, end: 960 },
        tutoring: { start: 990, end: 1170 },
      });

  // 雙軌對照視圖：初始 Seed 49 班盤點基準 + 當前 active classes 設定視圖 (D2)；
  // 候選由 D32-C 動態引擎以當批差集組裝（含去重人數／筆數，建議目標留空人工填）
  const dualTrack = classifyErpDualTrack(
    erpBaseNames,
    initialDraft.classes.map((c) => c.baseName),
    initialDraft.aliases,
    candidateCounts
  );

  // 班名比對報告：與 dualTrack 同一份設定（最新已儲存設定，尚無才是 seed）、同一份名單，兩處數字同源
  const classNameReport = reviewImportId
    ? getClassNameMatchReport(db, { importId: reviewImportId, scope: { kind: 'latest' } })
    : null;

  return (
    <div className="settings-page-container">
      <SettingsEditor
        importId={importId}
        currentRevision={active.revision}
        initialDraft={initialDraft}
        legacySemanticMigrationCandidates={legacySemanticMigrationCandidates}
        unmatched={dualTrack.activeView.unmatched}
        classNameReport={classNameReport}
        reportImportId={reviewImportId}
        matchedCount={dualTrack.activeView.matchedCount}
        candidates={dualTrack.candidates}
        lastAppliedRevision={latest?.revision ?? active.revision}
        lastAppliedAt={latest?.createdAt ?? null}
        hasActiveImport={hasActiveImport}
        initialTab={initialTab}
        focusClass={focusClass}
        currentRuleSetVersion={active.run?.ruleSetVersion ?? null}
      />
    </div>
  );
}

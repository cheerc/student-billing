import { getDatabase } from '@/adapters/sqlite';
import { getLatestReadyBatch } from '@/adapters/sqlite/import-repository';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestSettingsVersion, buildSeedDraft, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { SEED_CLASSES } from '@/domain/schedules/seed-manifest';
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
  const tabParam = first(sp.tab);
  // D62：舊連結 ?tab=mapping 相容導向 ?tab=sync
  const initialTab = (tabParam === 'mapping' || tabParam === 'sync') ? 'sync' : 'schedule';
  const db = getDatabase();
  const active = getCurrentActiveRun(db);
  const latestBatch = getLatestReadyBatch(db);
  const importId = active.activeImportId ?? latestBatch?.id ?? null;
  const hasActiveImport = Boolean(active.activeImportId);
  // 班名同步要檢視的名單：預設＝現行名單（無則最新一批）；網址 ?import= 指定另一批（匯入預覽的「前往班名同步」連結，
  // 名單尚未啟用也能看）。只影響班名同步的統計與報告；儲存設定仍以現行名單為準（editor 的 importId 不變）。
  const requestedImportId = first(sp.import)?.trim() || null;
  const requestedBatchExists = requestedImportId
    ? Boolean(db.prepare("SELECT 1 FROM import_batches WHERE id = ? AND status = 'ready'").get(requestedImportId))
    : false;
  const reviewImportId = requestedBatchExists ? requestedImportId : importId;

  const latest = getLatestSettingsVersion(db);
  const storedDraft = latest ? readStoredDraft(latest.contentJson) : null;
  const initialDraft: SettingsDraft = storedDraft
    ?? buildSeedDraft(SEED_CLASSES, {
        anqin: { start: 780, end: 960 },
        tutoring: { start: 990, end: 1170 },
      });

  // 班名同步報告：同一份設定（最新已儲存設定，尚無才是 seed）、同一份名單。
  // D62：單一差異表取代舊雙軌對照與候選清單，不再於 SSR 計算 classifyErpDualTrack／candidates。
  const classNameReport = reviewImportId
    ? getClassNameMatchReport(db, { importId: reviewImportId, scope: { kind: 'latest' } })
    : null;

  return (
    <div className="settings-page-container">
      <SettingsEditor
        importId={importId}
        currentRevision={active.revision}
        initialDraft={initialDraft}
        classNameReport={classNameReport}
        reportImportId={reviewImportId}
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

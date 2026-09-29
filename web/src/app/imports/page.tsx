import { getDatabase } from '@/adapters/sqlite';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { ImportsWorkflow } from '@/components/imports/imports-workflow';

export const dynamic = 'force-dynamic';

export default async function ImportsPage() {
  const db = getDatabase();
  const active = getCurrentActiveRun(db);
  const latestSettings = getLatestSettingsVersion(db);

  return (
    <div className="imports-page-wrapper">
      <ImportsWorkflow
        currentRevision={active.revision}
        lastScheduleSavedAt={latestSettings?.createdAt ?? null}
      />
    </div>
  );
}

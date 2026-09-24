import Link from 'next/link';
import { getDatabase } from '@/adapters/sqlite';
import { getLatestReadyBatch } from '@/adapters/sqlite/import-repository';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestSettingsVersion, buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { SEED_CLASSES, classifyErpBaseNames } from '@/domain/schedules/seed-manifest';
import { SettingsDraft } from '@/contracts/settings';
import SettingsEditor from '@/components/settings-editor';

export const dynamic = 'force-dynamic';

/** D18 已確認候選（列為候選供人工確認，軟體不自動批准） */
const D18_CANDIDATES = [
  {
    rawBaseName: '國小數學-一',
    targetBaseName: '國小數學-一A',
    reason: 'D18 確認事實：本次數學一班與一A為同班；preview 應展示 13 人各 -0.5 天、mismatch 5→18',
  },
];

export default async function SettingsPage() {
  const db = getDatabase();
  const active = getCurrentActiveRun(db);
  const latestBatch = getLatestReadyBatch(db);
  const importId = active.activeImportId ?? latestBatch?.id ?? null;

  if (!importId) {
    return (
      <div className="empty-card">
        <div className="empty-icon">⚙️</div>
        <h2 className="empty-title">尚無可設定的名單批次</h2>
        <p className="empty-desc">請先上傳 ERP 學生名單後再維護課程、時段與 alias 映射。</p>
        <div>
          <Link href="/imports" className="btn-primary">
            前往匯入名單
          </Link>
        </div>
      </div>
    );
  }

  const enrollmentRows = db
    .prepare('SELECT DISTINCT base_name FROM student_enrollments WHERE import_id = ?')
    .all(importId) as Array<{ base_name: string }>;
  const erpBaseNames = enrollmentRows.map((r) => r.base_name);
  const comparison = classifyErpBaseNames(erpBaseNames);

  const latest = getLatestSettingsVersion(db);
  const initialDraft: SettingsDraft = latest
    ? (JSON.parse(latest.contentJson) as SettingsDraft)
    : buildSeedDraft(SEED_CLASSES, {
        anqin: { start: 780, end: 960 },
        tutoring: { start: 990, end: 1170 },
      });

  return (
    <div>
      <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>課程、時段與 alias 設定</h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            先預覽影響（dry-run）再套用並重算；取消草稿不改任何 active 資料。
          </p>
        </div>
        <Link href="/" className="btn-secondary">
          返回核對總表
        </Link>
      </div>

      <SettingsEditor
        importId={importId}
        currentRevision={active.revision}
        initialDraft={initialDraft}
        unmatched={comparison.unmatched}
        seedNotAppeared={comparison.seedNotAppeared}
        matchedCount={comparison.matchedCount}
        candidates={D18_CANDIDATES}
      />
    </div>
  );
}

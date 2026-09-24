import Link from 'next/link';
import { getDatabase } from '@/adapters/sqlite';
import { getLatestReadyBatch } from '@/adapters/sqlite/import-repository';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestSettingsVersion, buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { SEED_CLASSES, classifyErpDualTrack } from '@/domain/schedules/seed-manifest';
import { SettingsDraft } from '@/contracts/settings';
import SettingsEditor from '@/components/settings-editor';

export const dynamic = 'force-dynamic';

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
    .prepare(
      `SELECT base_name,
              COUNT(*) AS token_count,
              COUNT(DISTINCT person_code) AS student_count
         FROM student_enrollments WHERE import_id = ? GROUP BY base_name`
    )
    .all(importId) as Array<{ base_name: string; token_count: number; student_count: number }>;
  const erpBaseNames = enrollmentRows.map((r) => r.base_name);
  // D32-C 人數口徑：去重人數 COUNT DISTINCT person_code（I19／preview 口徑）＋ token 筆數
  const candidateCounts = new Map(
    enrollmentRows.map((r) => [
      r.base_name,
      { studentCount: Number(r.student_count), tokenCount: Number(r.token_count) },
    ])
  );

  const latest = getLatestSettingsVersion(db);
  const initialDraft: SettingsDraft = latest
    ? (JSON.parse(latest.contentJson) as SettingsDraft)
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
        unmatched={dualTrack.activeView.unmatched}
        seedNotAppeared={dualTrack.activeView.seedNotAppeared}
        matchedCount={dualTrack.activeView.matchedCount}
        candidates={dualTrack.candidates}
        lastAppliedRevision={latest?.revision ?? active.revision}
        lastAppliedAt={latest?.createdAt ?? null}
      />
    </div>
  );
}

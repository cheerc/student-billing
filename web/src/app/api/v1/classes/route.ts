import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCalculationRun, getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestSettingsVersion, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { SettingsDraft } from '@/contracts/settings';
import { loadRunSnapshot } from '@/application/run-snapshot';
import { SEED_CLASSES } from '@/domain/schedules/seed-manifest';
import { sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

const seedSubjectMap = new Map<string, string>();
for (const cls of SEED_CLASSES) {
  seedSubjectMap.set(cls.baseName, cls.subject);
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const rawRunId = url.searchParams.get('runId');
    const db = getDatabase();

    let runId = rawRunId;
    if (runId) {
      runId = sanitizePathParam(runId, 'runId');
    } else {
      const active = getCurrentActiveRun(db);
      runId = active.activeRunId;
    }

    if (!runId) {
      return NextResponse.json({ error: '目前無已啟用之計算 run，且未指定 runId' }, { status: 400 });
    }

    const run = getCalculationRun(db, runId);
    if (!run) {
      return NextResponse.json({ error: `找不到計算 run: ${runId}` }, { status: 404 });
    }

    // 設定來源（D1 F-6）：
    //  - 明確指定 runId：讀「該 run 當時的設定快照」（run.scheduleVersionId），不用最新設定；快照缺失＝無法判定，不猜；
    //  - 未指定 runId（現行 run）：維持讀最新已儲存設定（尚無才用 seed）。
    const useRunSnapshot = Boolean(rawRunId);
    let draft: SettingsDraft | null;
    let snapshotStatus: 'ok' | 'unavailable' = 'ok';
    if (useRunSnapshot) {
      const snapshot = loadRunSnapshot(db, run.scheduleVersionId);
      if (snapshot) {
        // seed 快照＝該 run 用 seed 課表計算（無已儲存設定）；以 null 沿用下方 seed 判斷
        draft = snapshot.settingsRevision === null ? null : snapshot.draft;
      } else {
        draft = null;
        snapshotStatus = 'unavailable';
      }
    } else {
      const latestSettings = getLatestSettingsVersion(db);
      draft = latestSettings ? readStoredDraft(latestSettings.contentJson) : null;
    }
    const scheduleClasses = draft?.classes;
    const configuredClasses = new Set(scheduleClasses ? scheduleClasses.map((c) => c.baseName) : SEED_CLASSES.map((c) => c.baseName));
    const activeClasses = new Set(scheduleClasses ? scheduleClasses.filter((c) => c.active).map((c) => c.baseName) : SEED_CLASSES.map((c) => c.baseName));
    const aliasMap = new Map<string, string>();
    if (draft) {
      for (const a of draft.aliases) {
        aliasMap.set(a.rawBaseName, a.targetBaseName);
      }
    }

    // 查詢本批各班級及其去重學生數
    const rows = db
      .prepare(`
        SELECT se.base_name, COUNT(DISTINCT se.person_code) as student_count
        FROM student_enrollments se
        WHERE se.import_id = ?
        GROUP BY se.base_name
        ORDER BY se.base_name ASC
      `)
      .all(run.importId) as { base_name: string; student_count: number }[];

    const items = rows.map((r) => {
      if (snapshotStatus === 'unavailable') {
        // 該 run 當時的設定快照已不存在：對應狀態無法判定，不猜 mapped／unmapped
        return {
          baseName: r.base_name,
          targetBaseName: null,
          subject: '未設定',
          studentCount: r.student_count,
          mappingStatus: 'undetermined' as const,
          isConfigured: null,
          isActive: null,
        };
      }
      const targetName = aliasMap.get(r.base_name) || r.base_name;
      const subject = seedSubjectMap.get(targetName) || seedSubjectMap.get(r.base_name) || '未設定';
      const isConfigured = configuredClasses.has(targetName);
      const isActive = activeClasses.has(targetName);
      const isAliased = aliasMap.has(r.base_name);

      let mappingStatus: 'mapped' | 'unmapped' | 'aliased' = 'unmapped';
      if (isAliased) {
        mappingStatus = 'aliased';
      } else if (isConfigured) {
        mappingStatus = 'mapped';
      }

      return {
        baseName: r.base_name,
        targetBaseName: targetName,
        subject,
        studentCount: r.student_count,
        mappingStatus,
        isConfigured,
        isActive,
      };
    });

    return NextResponse.json(
      {
        runId,
        settingsScope: useRunSnapshot ? 'run_snapshot' : 'latest_settings',
        snapshotStatus,
        totalClasses: items.length,
        items,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCalculationRun, getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { SettingsDraft } from '@/contracts/settings';
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

    // 取得當前設定版本
    const latestSettings = getLatestSettingsVersion(db);
    const draft: SettingsDraft | null = latestSettings ? JSON.parse(latestSettings.contentJson) : null;
    const configuredClasses = new Set(draft ? draft.classes.map((c) => c.baseName) : SEED_CLASSES.map((c) => c.baseName));
    const activeClasses = new Set(draft ? draft.classes.filter((c) => c.active).map((c) => c.baseName) : SEED_CLASSES.map((c) => c.baseName));
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

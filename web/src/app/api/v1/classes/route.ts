import { NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { getLatestSettingsVersion, readStoredDraft, buildSeedDraft, draftToAliasMap } from '@/adapters/sqlite/settings-repository';
import { maskSensitiveInfo, SecurityError } from '@/contracts/security';
import type { ClassType } from '@/contracts/settings';

export async function GET() {
  try {
    const db = getDatabase();
    const active = getCurrentActiveRun(db);
    const runId = active.activeRunId;

    if (!runId || !active.run) {
      return NextResponse.json({ error: '目前無已啟用之計算 run' }, { status: 400 });
    }

    const run = active.run;
    const latestSettings = getLatestSettingsVersion(db);
    const draft = latestSettings ? readStoredDraft(latestSettings.contentJson) : buildSeedDraft();

    const classMap = new Map(draft.classes.map((c) => [c.baseName, c]));
    const aliasMap = draftToAliasMap(draft);
    const categorySnapshots = new Map((run.classCategories ?? []).map((c) => [c.base_name, c]));

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
      const baseName = r.base_name;
      const isAliased = aliasMap.has(baseName);
      const targetBaseName = aliasMap.get(baseName) || baseName;
      const targetClass = classMap.get(targetBaseName);
      const isConfigured = Boolean(targetClass);
      const isActive = targetClass ? targetClass.active : null;

      let mappingStatus: 'mapped' | 'unmapped' | 'aliased' = 'unmapped';
      if (isAliased) {
        mappingStatus = 'aliased';
      } else if (isConfigured) {
        mappingStatus = 'mapped';
      }

      const snap = categorySnapshots.get(baseName);
      let classType: ClassType | 'non_care' | null = null;
      let category: 'care' | 'math' | 'english' | 'none' | 'unset' = 'unset';
      let fixedFiveDays = false;

      if (snap) {
        classType = (snap.class_type as ClassType | 'non_care' | null) ?? null;
        category = (snap.category as 'care' | 'math' | 'english' | 'none' | 'unset') ?? 'unset';
        fixedFiveDays = snap.fixed_five_days === 1;
      } else if (targetClass) {
        classType = targetClass.classType ?? null;
        category = targetClass.category ?? 'unset';
        fixedFiveDays = targetClass.fixedFiveDays ?? false;
      }

      return {
        baseName,
        targetBaseName,
        classType,
        category,
        fixedFiveDays,
        mappingStatus,
        isConfigured,
        isActive,
        studentCount: r.student_count,
      };
    });

    return NextResponse.json(
      {
        activeRunId: runId,
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

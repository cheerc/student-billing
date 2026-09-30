import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { loadRunSnapshot } from '@/application/run-snapshot';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { StudentSnapshot, ParsedToken } from '@/domain/students';
import { sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId: rawRunId } = await context.params;
    const runId = sanitizePathParam(rawRunId, 'runId');
    const url = new URL(request.url);
    const againstRuleSet = url.searchParams.get('againstRuleSet');

    if (!againstRuleSet) {
      return NextResponse.json(
        { error: '缺少必要參數 againstRuleSet' },
        { status: 400 }
      );
    }

    if (againstRuleSet !== 'excel-v260922-compat') {
      return NextResponse.json(
        { error: `againstRuleSet 僅支援 'excel-v260922-compat'，不支援: ${againstRuleSet}` },
        { status: 400 }
      );
    }

    const db = getDatabase();
    const run = getCalculationRun(db, runId);
    if (!run) {
      return NextResponse.json({ error: `找不到 run: ${runId}` }, { status: 404 });
    }

    // 以該 run 當時的設定快照重算（D1 F-5）：alias 與時段覆寫與 run 實際計算所用的一致；
    // seed 課表的 run（scheduleVersionId＝seed-v250922）不帶覆寫。快照缺失就回 409，不改用最新設定或 seed 補算
    //（與 schedule-deductions 的既有契約相同）。
    const snapshot = loadRunSnapshot(db, run.scheduleVersionId);
    if (!snapshot) {
      return NextResponse.json(
        {
          error: `找不到該 run 當時的課表快照（版本 ${run.scheduleVersionId}）：資料不足，無法重建，不會改用最新設定補算。`,
          code: 'SNAPSHOT_UNAVAILABLE',
        },
        { status: 409 }
      );
    }
    const isSeedSnapshot = snapshot.settingsRevision === null;
    const snapshotContext = isSeedSnapshot
      ? {}
      : { aliasMap: draftToAliasMap(snapshot.draft), scheduleOverride: draftToScheduleOverride(snapshot.draft) };

    // 讀取該批次學生與報名
    const studentRows = db
      .prepare('SELECT * FROM imported_students WHERE import_id = ? ORDER BY source_row ASC')
      .all(run.importId) as any[];

    const enrollmentRows = db
      .prepare('SELECT * FROM student_enrollments WHERE import_id = ? ORDER BY person_code ASC, token_index ASC')
      .all(run.importId) as any[];

    const enrollmentsMap: Record<string, ParsedToken[]> = {};
    for (const r of enrollmentRows) {
      if (!enrollmentsMap[r.person_code]) {
        enrollmentsMap[r.person_code] = [];
      }
      enrollmentsMap[r.person_code].push({
        rawToken: r.raw_token,
        yearPrefix: r.year_prefix,
        baseName: r.base_name,
        groupFlag: r.group_flag,
        modifiers: r.modifiers ? JSON.parse(r.modifiers) : [],
        withdrawalDate: r.withdrawal_date,
        erpBillingTierRaw: r.erp_billing_tier_raw,
        erpBillingTier: r.erp_billing_tier,
        tierParseStatus: r.tier_parse_status,
        parseStatus: r.parse_status,
      });
    }

    const differences: any[] = [];

    for (const row of studentRows) {
      const enrollments = enrollmentsMap[row.person_code] || [];
      const student: StudentSnapshot = {
        personCode: row.person_code,
        name: row.name,
        branch: row.branch,
        gradeRaw: row.grade_raw,
        grade: row.grade,
        gradeStatus: row.grade_status,
        contact: row.contact,
        schoolInfo: row.school_info,
        tagsRaw: row.tags_raw,
        tags: row.tags_raw ? row.tags_raw.split(/[,;\s]+/).filter(Boolean) : [],
        notesRaw: row.notes_raw,
        enrollments,
        sourceRow: row.source_row,
      };

      const formalRuleSet = (run.ruleSetVersion as any) || 'erp-tag-v2';
      const formal = calculateStudentBilling(student, { ruleSetVersion: formalRuleSet, ...snapshotContext });
      const compat = calculateStudentBilling(student, { ruleSetVersion: 'excel-v260922-compat', ...snapshotContext });

      // 比較基本折扣率差異
      if (formal.baseDiscountBps !== compat.baseDiscountBps) {
        differences.push({
          personCode: student.personCode,
          name: student.name,
          sourceRow: student.sourceRow,
          field: 'baseDiscountBps',
          formalValue: formal.baseDiscountBps,
          compatValue: compat.baseDiscountBps,
          category: 'DISCOUNT_DIFFERENCE',
        });
      }

      // 比較安親天數差異
      if (formal.careDays.anqin.days !== compat.careDays.anqin.days) {
        differences.push({
          personCode: student.personCode,
          name: student.name,
          sourceRow: student.sourceRow,
          field: 'anqinDays',
          formalValue: formal.careDays.anqin.days,
          compatValue: compat.careDays.anqin.days,
          category: 'CARE_DAYS_DIFFERENCE',
        });
      }

      // 比較課輔天數差異
      if (formal.careDays.tutoring.days !== compat.careDays.tutoring.days) {
        differences.push({
          personCode: student.personCode,
          name: student.name,
          sourceRow: student.sourceRow,
          field: 'tutoringDays',
          formalValue: formal.careDays.tutoring.days,
          compatValue: compat.careDays.tutoring.days,
          category: 'CARE_DAYS_DIFFERENCE',
        });
      }
    }

    return NextResponse.json({
      runId,
      diagnosticAlgorithmVersion: 'v1',
      totalDifferences: differences.length,
      differences,
    });
  } catch (error) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message) }, { status: 500 });
  }
}

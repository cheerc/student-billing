import Database from 'better-sqlite3';
import crypto from 'crypto';
import { loadRunClassCategories, type RunClassCategorySnapshot } from '@/application/applicable-rate';
import { historicalRuleSetMetadata } from '@/domain/billing/rule-set';
import type { RunDiagnosticsSnapshot } from '@/contracts/run-diagnostics';
import {
  ClassTypeDefinitionSchema,
  ErpTierApplicabilitySchema,
  SemanticSettingSourceSchema,
  SummaryDayRoleSchema,
  SummaryDayRoleConditionSchema,
  type SummaryDayRoleCondition,
} from '@/contracts/settings';

export interface CalculationRunRecord {
  id: string;
  importId: string;
  scheduleVersionId: string;
  ruleSetVersion: string;
  numericPolicy: string;
  asOfDate: string;
  status: 'calculating' | 'completed';
  issueCounts: Record<string, number>;
  totalStudents: number;
  createdAt: string;
  /** NULL for pre-#161 rows. Present on in-memory executions only when its payload will be saved. */
  diagnosticAlgorithmVersion?: string | null;
  diagnostics?: RunDiagnosticsSnapshot;
  /**
   * 該 run 的類別快照（03 §5.3.4；issue #122）。
   *
   * 三態，語意互不相同，**不可互相取代**：
   *  - `undefined`：此 run 沒有快照概念（v1／v2）→ 讀模型走當前班名映射。
   *  - `[]`：是 v3 run，但沒有任何快照列 → 讀模型一律 `not_configured`（嚴禁以班名猜測）。
   *  - 有值：v3 run 的實際採用類別，讀模型以快照為準。
   *
   * 形狀即 `RunClassCategorySnapshot`（底線命名、`fixed_five_days` 為數字 0/1）——
   * 與 `applicableRateForClass` 的輸入同形，消費端不得自行轉型。
   */
  classCategories?: RunClassCategorySnapshot[];
  /** Semantic settings captured for this run after migration 0009; historical runs remain absent. */
  classSemantics?: RunClassSemanticSnapshot[];
}

export interface StudentCalculationRecord {
  id: string;
  runId: string;
  personCode: string;
  name: string;
  branch: string | null;
  grade: number | null;
  gradeRaw: string | null;
  subjectCount: number | null;
  baseDiscountBps: number | null;
  anqinDays: number | null;
  anqinDisplay: string | null;
  tutoringDays: number | null;
  tutoringDisplay: string | null;
  englishDays: number | null;
  mathDays: number | null;
  chineseDays: number | null;
  homeworkDays: number | null;
  intensiveEnglishDays: number | null;
  saturdayTutoringDays: number | null;
  applicableAnqinBps: number | null;
  applicableTutoringBps: number | null;
  applicableEnglishBps: number | null;
  applicableMathBps: number | null;
  tierMismatch: boolean;
  tierComparisons: any[];
  issues: any[];
  hasIssues: boolean;
  trace: any;
  createdAt: string;
}

export interface RunClassCategoryRecord {
  baseName: string;
  category: string;
  fixedFiveDays: number;
  mapped: number;
  source: string;
}

export interface RunClassSemanticRecord {
  baseName: string;
  resolvedBaseName: string;
  snapshotSchemaVersion: number;
  classTypeId: string | null;
  classTypeDefinitionJson: string | null;
  classTypeDefinitionHash: string | null;
  subject: string;
  subjectSource: string;
  category: string;
  categorySource: string;
  fixedFiveDays: number;
  summaryDayRolesJson: string;
  summaryDayRoleConditionsJson: string;
  summaryDayRolesStatus: string;
  summaryDayRolesSource: string;
  erpTierApplicability: string;
  erpTierApplicabilitySource: string;
}

export interface RunClassSemanticSnapshot extends Omit<RunClassSemanticRecord, 'summaryDayRolesJson' | 'summaryDayRoleConditionsJson' | 'classTypeDefinitionJson'> {
  summaryDayRoles: string[];
  summaryDayRoleConditions: SummaryDayRoleCondition[];
  classTypeDefinition: Record<string, unknown> | null;
}

export function saveCalculationRun(
  db: Database.Database,
  run: CalculationRunRecord,
  results: StudentCalculationRecord[],
  classCategories?: RunClassCategoryRecord[],
  classSemantics?: RunClassSemanticRecord[]
): void {
  if (run.diagnosticAlgorithmVersion != null || run.diagnostics) {
    throw new Error('新 run 不可寫入已退役的診斷快照');
  }
  if (run.ruleSetVersion === 'erp-tag-v4' && classSemantics === undefined) {
    throw new Error('v4 新 run 必須明確提供 classSemantics（空快照請傳入 []）');
  }

  const persist = db.transaction(() => {
  const insertRun = db.prepare(`
    INSERT INTO calculation_runs (
      id, import_id, schedule_version_id, rule_set_version, numeric_policy,
      as_of_date, status, issue_counts, total_students, created_at, diagnostic_algorithm_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertRun.run(
    run.id,
    run.importId,
    run.scheduleVersionId,
    run.ruleSetVersion,
    run.numericPolicy,
    run.asOfDate,
    run.status,
    JSON.stringify(run.issueCounts),
    run.totalStudents,
    run.createdAt,
    null
  );

  const insertResult = db.prepare(`
    INSERT INTO student_calculations (
      id, run_id, person_code, name, branch, grade, grade_raw,
      subject_count, base_discount_bps, anqin_days, anqin_display,
      tutoring_days, tutoring_display, english_days, math_days,
      chinese_days, homework_days, intensive_english_days, saturday_tutoring_days,
      applicable_anqin_bps, applicable_tutoring_bps, applicable_english_bps, applicable_math_bps,
      tier_mismatch, tier_comparisons, issues, has_issues, trace, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of results) {
    insertResult.run(
      r.id,
      r.runId,
      r.personCode,
      r.name,
      r.branch,
      r.grade,
      r.gradeRaw,
      r.subjectCount,
      r.baseDiscountBps,
      r.anqinDays,
      r.anqinDisplay,
      r.tutoringDays,
      r.tutoringDisplay,
      r.englishDays,
      r.mathDays,
      r.chineseDays,
      r.homeworkDays,
      r.intensiveEnglishDays,
      r.saturdayTutoringDays,
      r.applicableAnqinBps,
      r.applicableTutoringBps,
      r.applicableEnglishBps,
      r.applicableMathBps,
      r.tierMismatch ? 1 : 0,
      JSON.stringify(r.tierComparisons),
      JSON.stringify(r.issues),
      r.hasIssues ? 1 : 0,
      JSON.stringify(r.trace),
      r.createdAt
    );
  }

  // R2-1: 類別快照持久化 (categoryBasedBilling)，置於 calculation_runs 確定存在後執行，避免級聯刪除
  if (historicalRuleSetMetadata(run.ruleSetVersion).hasClassCategorySnapshot && classCategories && classCategories.length > 0) {
    const insertCategory = db.prepare(`
      INSERT OR REPLACE INTO run_class_categories (
        run_id, base_name, category, fixed_five_days, mapped, source
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of classCategories) {
      insertCategory.run(
        run.id,
        item.baseName,
        item.category,
        item.fixedFiveDays,
        item.mapped,
        item.source
      );
    }
  }

  if (run.ruleSetVersion === 'erp-tag-v4' && classSemantics !== undefined) {
    db.prepare('INSERT INTO run_semantics_snapshots (run_id, snapshot_schema_version) VALUES (?, 2)').run(run.id);
    const insertSemantics = db.prepare(`
      INSERT INTO run_class_semantics (
        run_id, base_name, resolved_base_name, snapshot_schema_version,
        class_type_id, class_type_definition_json, class_type_definition_hash,
        subject, subject_source, category, category_source, fixed_five_days,
        summary_day_roles_json, summary_day_role_conditions_json, summary_day_roles_status, summary_day_roles_source,
        erp_tier_applicability, erp_tier_applicability_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of classSemantics) {
      if (item.snapshotSchemaVersion !== 2) throw new Error(`Unsupported run semantics snapshot schema version ${item.snapshotSchemaVersion}`);
      insertSemantics.run(
        run.id,
        item.baseName,
        item.resolvedBaseName,
        item.snapshotSchemaVersion,
        item.classTypeId,
        item.classTypeDefinitionJson,
        item.classTypeDefinitionHash,
        item.subject,
        item.subjectSource,
        item.category,
        item.categorySource,
        item.fixedFiveDays,
        item.summaryDayRolesJson,
        item.summaryDayRoleConditionsJson,
        item.summaryDayRolesStatus,
        item.summaryDayRolesSource,
        item.erpTierApplicability,
        item.erpTierApplicabilitySource
      );
    }
  }

  });
  persist();
}

export function getCalculationRun(
  db: Database.Database,
  runId: string
): CalculationRunRecord | null {
  const row = db.prepare('SELECT * FROM calculation_runs WHERE id = ?').get(runId) as any;
  if (!row) return null;

  const record: CalculationRunRecord = {
    id: row.id,
    importId: row.import_id,
    scheduleVersionId: row.schedule_version_id,
    ruleSetVersion: row.rule_set_version,
    numericPolicy: row.numeric_policy,
    asOfDate: row.as_of_date,
    status: row.status,
    issueCounts: JSON.parse(row.issue_counts),
    totalStudents: row.total_students,
    createdAt: row.created_at,
    diagnosticAlgorithmVersion: row.diagnostic_algorithm_version ?? null,
  };

  // issue #122：v3 run 的類別快照必須由**載入層**帶出，而非各 route 自行補查。
  // 只在這裡載入，`GET /api/v1/runs/{id}`、`/api/v1/runs/current`、`/api/v1/classes`
  // 等所有消費端才不會各自補一次而漂移。
  //
  // 判定用能力旗標而非字面比較（03 §5.3.1 禁止 `=== 'erp-tag-v3'`）：
  // v3 但零列必須是 `[]`，否則讀模型會退回當前班名映射，
  // 正是 03 §5.3.4 明文禁止的猜測。v1／v2 沒有快照概念，維持 `undefined`。
  if (historicalRuleSetMetadata(record.ruleSetVersion).hasClassCategorySnapshot) {
    record.classCategories = loadRunClassCategories(db, runId);
  }

  if (record.ruleSetVersion === 'erp-tag-v4') {
    const marker = db.prepare(
      'SELECT snapshot_schema_version FROM run_semantics_snapshots WHERE run_id = ?'
    ).get(runId) as { snapshot_schema_version: number } | undefined;
    const semantics = db.prepare(
      'SELECT * FROM run_class_semantics WHERE run_id = ? ORDER BY base_name'
    ).all(runId) as any[];
    if (marker) {
      if (marker.snapshot_schema_version !== 1 && marker.snapshot_schema_version !== 2) {
        throw new Error(`Unsupported run semantics snapshot schema version ${marker.snapshot_schema_version}`);
      }
      record.classSemantics = semantics.map((item) => {
        if (item.snapshot_schema_version !== marker.snapshot_schema_version) {
          throw new Error(`Run semantic row schema does not match snapshot header for ${runId}`);
        }
        const classTypeDefinition = item.class_type_definition_json
          ? ClassTypeDefinitionSchema.parse(JSON.parse(item.class_type_definition_json))
          : null;
        if ((item.class_type_id === null && classTypeDefinition !== null) ||
            (item.class_type_id !== null && (!classTypeDefinition || classTypeDefinition.id !== item.class_type_id))) {
          throw new Error(`Run semantic class type id does not match its definition for ${runId}/${item.base_name}`);
        }
        if (classTypeDefinition) {
          const expectedHash = crypto.createHash('sha256').update(item.class_type_definition_json).digest('hex');
          if (expectedHash !== item.class_type_definition_hash) {
            throw new Error(`Run semantic definition hash mismatch for ${runId}/${item.base_name}`);
          }
        } else if (item.class_type_definition_hash !== null) {
          throw new Error(`Run semantic definition hash has no definition for ${runId}/${item.base_name}`);
        }
        let summaryDayRoles: unknown;
        try {
          summaryDayRoles = JSON.parse(item.summary_day_roles_json);
        } catch {
          throw new Error(`Run semantic roles JSON is invalid for ${runId}/${item.base_name}`);
        }
        if (!Array.isArray(summaryDayRoles) || summaryDayRoles.some((role) => !SummaryDayRoleSchema.safeParse(role).success)) {
          throw new Error(`Run semantic roles are invalid for ${runId}/${item.base_name}`);
        }
        let summaryDayRoleConditions: unknown;
        try {
          summaryDayRoleConditions = marker.snapshot_schema_version >= 2
            ? JSON.parse(item.summary_day_role_conditions_json)
            : [];
        } catch {
          throw new Error(`Run semantic role conditions JSON is invalid for ${runId}/${item.base_name}`);
        }
        if (!Array.isArray(summaryDayRoleConditions) ||
            summaryDayRoleConditions.some((condition) => !SummaryDayRoleConditionSchema.safeParse(condition).success || !summaryDayRoles.includes((condition as { role: string }).role))) {
          throw new Error(`Run semantic role conditions are invalid for ${runId}/${item.base_name}`);
        }
        if (!SemanticSettingSourceSchema.safeParse(item.subject_source).success ||
            !SemanticSettingSourceSchema.safeParse(item.summary_day_roles_source).success ||
            !SemanticSettingSourceSchema.safeParse(item.erp_tier_applicability_source).success) {
          throw new Error(`Run semantic source is invalid for ${runId}/${item.base_name}`);
        }
        if (!['configured', 'unset', 'unavailable'].includes(item.summary_day_roles_status)) {
          throw new Error(`Run semantic role status is invalid for ${runId}/${item.base_name}`);
        }
        if (!ErpTierApplicabilitySchema.safeParse(item.erp_tier_applicability).success) {
          throw new Error(`Run semantic tier applicability is invalid for ${runId}/${item.base_name}`);
        }
        if (!['care', 'math', 'english', 'none', 'unset'].includes(item.category) ||
            !['manual', 'seed', 'unset'].includes(item.category_source)) {
          throw new Error(`Run semantic category is invalid for ${runId}/${item.base_name}`);
        }
        if (typeof item.subject !== 'string' || ![0, 1].includes(item.fixed_five_days)) {
          throw new Error(`Run semantic scalar fields are invalid for ${runId}/${item.base_name}`);
        }
        return {
        baseName: item.base_name,
        resolvedBaseName: item.resolved_base_name,
        snapshotSchemaVersion: item.snapshot_schema_version,
        classTypeId: item.class_type_id,
        classTypeDefinition,
        classTypeDefinitionHash: item.class_type_definition_hash,
        subject: item.subject,
        subjectSource: item.subject_source,
        category: item.category,
        categorySource: item.category_source,
        fixedFiveDays: item.fixed_five_days,
        summaryDayRoles,
        summaryDayRoleConditions,
        summaryDayRolesStatus: item.summary_day_roles_status,
        summaryDayRolesSource: item.summary_day_roles_source,
        erpTierApplicability: item.erp_tier_applicability,
        erpTierApplicabilitySource: item.erp_tier_applicability_source,
        };
      });
    } else if (semantics.length > 0) {
      throw new Error(`Run semantic rows exist without a snapshot header for ${runId}`);
    }
  }

  return record;
}

export function getCurrentActiveRun(
  db: Database.Database
): { revision: number; activeImportId: string | null; activeRunId: string | null; run: CalculationRunRecord | null } {
  const state = db.prepare('SELECT * FROM active_state WHERE id = 1').get() as any;
  if (!state || !state.active_run_id) {
    return {
      revision: state ? state.revision : 0,
      activeImportId: state ? state.active_import_id : null,
      activeRunId: null,
      run: null,
    };
  }

  const run = getCalculationRun(db, state.active_run_id);
  return {
    revision: state.revision,
    activeImportId: state.active_import_id,
    activeRunId: state.active_run_id,
    run,
  };
}

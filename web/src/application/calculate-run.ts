import Database from 'better-sqlite3';
import crypto from 'crypto';
import { StudentSnapshot, ParsedToken } from '@/domain/students';
import { calculateStudentBilling, RuleSetVersion, ResolvedClassSession } from '@/domain/billing/billing-calculator';
import { CalculationRunRecord, StudentCalculationRecord, RunClassCategoryRecord, RunClassSemanticRecord } from '@/adapters/sqlite/runs-repository';
import seedData from '@/domain/schedules/schedule-seed.json';
import { SettingsDraft, DEFAULT_CLASS_TYPE_DEFINITIONS, legacyClassTypeForDefinition } from '@/contracts/settings';
import { todayInTaipei } from '@/lib/datetime';
import { resolveClassEnrollment, ClassSettingLookup } from '@/domain/classification/class-category';
import { TARGET_FORMAL_RULE_SET_VERSION } from '@/domain/billing/rule-set';
import { normalizeSettingsDraftSemantics } from '@/domain/classification/class-semantics';
import { SEED_CLASS_SEMANTICS } from '@/domain/classification/class-semantics';
import { projectSummaryDayValues } from './summary-day-values';
import {
  getLatestSettingsVersion,
  getSettingsPreview,
  getSettingsVersionById,
  buildSeedDraft,
  draftToAliasMap,
  draftToScheduleOverride,
  readStoredDraft,
} from '@/adapters/sqlite/settings-repository';

/** 尚無任何已儲存設定時的課表版本 id（seed 預設課表）。 */
export const SEED_SCHEDULE_VERSION_ID = 'seed-v250922';

const seedMap = new Map<string, any>();
for (const cls of seedData.classes) {
  seedMap.set(cls.baseName, cls);
}

/** 將設定草稿轉為計算管線與類別快照使用的 classSettingMap (D2a R2-2)。
 *  #113 follow-up：不計扣天已逐時段化（sessions[].skipDeduction → scheduleOverride），不再是班級屬性，
 *  因此這裡不再帶 skipDeduction。 */
export function buildClassSettingMap(draft: SettingsDraft): Map<string, ClassSettingLookup> {
  const map = new Map<string, ClassSettingLookup>();
  const normalizedDraft = normalizeSettingsDraftSemantics(draft);
  for (const c of normalizedDraft.classes) {
    const definition = normalizedDraft.classTypeDefinitions.find((item) => item.id === c.classTypeId);
    map.set(c.baseName, {
      semanticOnly: c.semanticOnly,
      classType: c.classType ?? (definition ? legacyClassTypeForDefinition(definition) : undefined),
      classTypeId: c.classTypeId,
      classTypeDefinition: definition,
      subject: c.subject,
      subjectSource: c.subjectSource,
      category: c.category,
      categorySource: c.categorySource,
      fixedFiveDays: c.fixedFiveDays,
      summaryDayRoles: c.summaryDayRoles,
      summaryDayRoleConditions: c.summaryDayRoleConditions,
      summaryDayRolesStatus: c.summaryDayRolesStatus,
      summaryDayRolesSource: c.summaryDayRolesSource,
      erpTierApplicability: c.erpTierApplicability,
      erpTierApplicabilitySource: c.erpTierApplicabilitySource,
    });
  }
  return map;
}

export interface CalculateRunOptions {
  scheduleVersionId?: string;
  ruleSetVersion?: RuleSetVersion | string;
  numericPolicy?: string;
  asOfDate?: string;
  /** T05: 設定覆寫（alias 映射與自訂時段），無則使用 seed 預設 */
  aliasMap?: Map<string, string>;
  scheduleOverride?: Map<string, ResolvedClassSession[]>;
  classSettings?: Map<string, ClassSettingLookup>;
  /** Stored, unexpired v4 preview authorization, supplied only by settings apply. */
  upgradePreviewId?: string;
}

/**
 * 解析最新已儲存設定供正式 run 計算使用（09 §8.2.1）。
 * 有已儲存設定版本時回傳其 id 與由其 draft 轉出的 alias／時段覆寫（與 apply 同一組轉換）；
 * 尚無任何已儲存設定時回傳 seed 版本 id 且不帶覆寫。
 * 呼叫端須在與 run 建立相同的交易內呼叫，使解析結果與 run 記錄的 scheduleVersionId 一致。
 */
export function resolveLatestSavedSettings(
  db: Database.Database
): Pick<CalculateRunOptions, 'scheduleVersionId' | 'aliasMap' | 'scheduleOverride' | 'classSettings'> {
  const latest = getLatestSettingsVersion(db);
  if (!latest) {
    const seedDraft = buildSeedDraft();
    return {
      scheduleVersionId: SEED_SCHEDULE_VERSION_ID,
      classSettings: buildClassSettingMap(seedDraft),
    };
  }
  const draft = readStoredDraft(latest.contentJson);
  return {
    scheduleVersionId: latest.id,
    aliasMap: draftToAliasMap(draft),
    scheduleOverride: draftToScheduleOverride(draft),
    classSettings: buildClassSettingMap(draft),
  };
}

export function executeCalculationRun(
  db: Database.Database,
  importId: string,
  runId: string,
  options: CalculateRunOptions = {}
): { run: CalculationRunRecord; results: StudentCalculationRecord[]; classCategories?: RunClassCategoryRecord[]; classSemantics?: RunClassSemanticRecord[] } {
  const scheduleVersionId = options.scheduleVersionId || SEED_SCHEDULE_VERSION_ID;
  const ruleSetVersion = options.ruleSetVersion || TARGET_FORMAL_RULE_SET_VERSION;
  if (ruleSetVersion !== TARGET_FORMAL_RULE_SET_VERSION) {
    throw new Error(
      `新計算 Run 僅支援 ${TARGET_FORMAL_RULE_SET_VERSION}；舊版資料請透過課表設定明確預覽並確認升級。`
    );
  }

  // The low-level run boundary is also used by application callers, so a caller-supplied v4
  // version cannot bypass the active-run upgrade gate. An old/unknown active run is writable
  // only when settings apply forwards the ID of the same stored, current, v4-target preview.
  const active = db.prepare('SELECT active_run_id, active_import_id, revision FROM active_state WHERE id = 1').get() as
    | { active_run_id: string | null; active_import_id: string | null; revision: number }
    | undefined;
  if (active?.active_run_id) {
    const activeRun = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(active.active_run_id) as
      | { rule_set_version: string }
      | undefined;
    if (!activeRun) {
      throw new Error(`現行 active Run「${active.active_run_id}」不存在，無法安全建立新 Run。`);
    }
    if (activeRun.rule_set_version !== TARGET_FORMAL_RULE_SET_VERSION) {
      const preview = options.upgradePreviewId ? getSettingsPreview(db, options.upgradePreviewId) : null;
      const expiresAtMs = preview?.expiresAt ? Date.parse(preview.expiresAt) : Number.NaN;
      const hasValidFutureExpiry = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
      if (
        !preview ||
        !hasValidFutureExpiry ||
        preview.targetRuleSetVersion !== TARGET_FORMAL_RULE_SET_VERSION ||
        preview.importId !== importId ||
        preview.importId !== active.active_import_id ||
        preview.expectedRevision !== active.revision
      ) {
        throw new Error(
          `現行 Run 使用 ${activeRun.rule_set_version}；建立新 Run 必須經由未過期、版本一致的 v4 明確升級預覽。`
        );
      }
    }
  }
  const numericPolicy = options.numericPolicy || 'integer-minute-rational-v1';
  const asOfDate = options.asOfDate || todayInTaipei();
  const now = new Date().toISOString();

  // R2-2: 由 executeCalculationRun 從已儲存設定或 seed 建立 classSettings，統一供給計算與快照 (同源)
  let classSettings = options.classSettings;
  if (!classSettings) {
    if (scheduleVersionId && scheduleVersionId !== SEED_SCHEDULE_VERSION_ID) {
      const ver = getSettingsVersionById(db, scheduleVersionId);
      if (ver) {
        const draft = readStoredDraft(ver.contentJson);
        classSettings = buildClassSettingMap(draft);
      }
    }
    if (!classSettings) {
      const seedDraft = buildSeedDraft();
      classSettings = buildClassSettingMap(seedDraft);
    }
  }

  // 1. 讀取學生快照
  const studentRows = db
    .prepare('SELECT * FROM imported_students WHERE import_id = ? ORDER BY source_row ASC')
    .all(importId) as any[];

  if (studentRows.length === 0) {
    throw new Error(`找不到匯入批次 ${importId} 之學生資料`);
  }

  // 2. 讀取報名快照
  const enrollmentRows = db
    .prepare('SELECT * FROM student_enrollments WHERE import_id = ? ORDER BY person_code ASC, token_index ASC')
    .all(importId) as any[];

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

  // 3. 逐一計算學生
  const results: StudentCalculationRecord[] = [];
  const issueCounts: Record<string, number> = {};

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

    // 正式軌計算
    const formal = calculateStudentBilling(student, {
      ruleSetVersion: ruleSetVersion as any,
      aliasMap: options.aliasMap,
      scheduleOverride: options.scheduleOverride,
      classSettings,
    });

    // Summary values follow the resolved semantic settings and selected class from this run.
    const summaryDayValues = projectSummaryDayValues(
      enrollments,
      classSettings,
      options.aliasMap,
      (resolvedBaseName) => {
        const seedClass = seedMap.get(resolvedBaseName);
        return seedClass?.sessions.length;
      },
      {
        english: formal.selection?.english?.selectedBaseName,
        math: formal.selection?.math?.selectedBaseName,
      }
    );

    const tierMismatch = formal.tierComparisons.some((c) => c.status === 'mismatch');
    const hasIssues = formal.issues.length > 0 || formal.tierComparisons.some((c) => c.needsReview);

    // 累計各問題碼數量
    for (const issue of formal.issues) {
      issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;
    }

    const issuesArr = [...formal.issues];
    Object.defineProperty(issuesArr, 'toString', {
      value: () => JSON.stringify(formal.issues),
      configurable: true,
      writable: true,
    });

    results.push({
      id: `${runId}_${student.personCode}`,
      runId,
      personCode: student.personCode,
      name: student.name,
      branch: student.branch,
      grade: student.grade,
      gradeRaw: student.gradeRaw,
      subjectCount: formal.subjectCount,
      baseDiscountBps: formal.baseDiscountBps,
      anqinDays: formal.careDays.anqin.days,
      anqinDisplay: formal.careDays.anqin.displayDays,
      tutoringDays: formal.careDays.tutoring.days,
      tutoringDisplay: formal.careDays.tutoring.displayDays,
      ...summaryDayValues,
      applicableAnqinBps: formal.applicableRates.anqin,
      applicableTutoringBps: formal.applicableRates.tutoring,
      applicableEnglishBps: formal.applicableRates.english,
      applicableMathBps: formal.applicableRates.math,
      tierMismatch,
      tierComparisons: formal.tierComparisons,
      issues: issuesArr,
      hasIssues,
      trace: {
        sourceRow: student.sourceRow,
        rawTags: student.tagsRaw,
        rawNotes: student.notesRaw,
        enrollments: student.enrollments,
        careDays: formal.careDays,
      },
      createdAt: now,
    });

  }

  const run: CalculationRunRecord = {
    id: runId,
    importId,
    scheduleVersionId,
    ruleSetVersion,
    numericPolicy,
    asOfDate,
    status: 'completed',
    issueCounts,
    totalStudents: results.length,
    createdAt: now,
  };

  // R2-1 & R2-2: 產生 run_class_categories 快照物件，供 saveCalculationRun 持久化
  let classCategories: RunClassCategoryRecord[] | undefined;
  let classSemantics: RunClassSemanticRecord[] | undefined;
  {
    const classCategoryMap = new Map<string, RunClassCategoryRecord>();
    const classSemanticMap = new Map<string, RunClassSemanticRecord>();

    for (const r of enrollmentRows) {
      if (!classCategoryMap.has(r.base_name)) {
        const resolved = resolveClassEnrollment(
          { rawToken: r.raw_token, baseName: r.base_name },
          options.aliasMap,
          classSettings
        );
        classCategoryMap.set(r.base_name, {
          baseName: r.base_name,
          category: resolved.category,
          fixedFiveDays: resolved.fixedFiveDays ? 1 : 0,
          mapped: resolved.mapped ? 1 : 0,
          // #157 Ruling 4：來源值域為 'manual' | 'unset'（舊 'auto' 不再寫入）。
          source: resolved.categorySource,
        });

        const semanticSetting = classSettings.get(resolved.resolvedBaseName) ?? classSettings.get(r.base_name);
        const seedSemantics = SEED_CLASS_SEMANTICS.get(resolved.resolvedBaseName);
        const classTypeId = semanticSetting?.classTypeId ?? seedSemantics?.classTypeId ?? null;
        const definition = semanticSetting?.classTypeDefinition ??
          (classTypeId ? DEFAULT_CLASS_TYPE_DEFINITIONS.find((item) => item.id === classTypeId) : undefined);
        const definitionJson = definition ? JSON.stringify(definition) : null;
        const roles = semanticSetting?.summaryDayRoles ?? seedSemantics?.summaryDayRoles ?? [];
        classSemanticMap.set(r.base_name, {
          baseName: r.base_name,
          resolvedBaseName: resolved.resolvedBaseName,
          snapshotSchemaVersion: 2,
          classTypeId,
          classTypeDefinitionJson: definitionJson,
          classTypeDefinitionHash: definitionJson
            ? crypto.createHash('sha256').update(definitionJson).digest('hex')
            : null,
          subject: semanticSetting?.subject ?? SEED_CLASS_SEMANTICS.get(resolved.resolvedBaseName)?.subject ?? '',
          subjectSource: semanticSetting?.subjectSource ?? (seedSemantics ? 'seed' : 'unset'),
          category: resolved.category,
          categorySource: resolved.categorySource,
          fixedFiveDays: resolved.fixedFiveDays ? 1 : 0,
          summaryDayRolesJson: JSON.stringify(roles),
          summaryDayRoleConditionsJson: JSON.stringify(semanticSetting?.summaryDayRoleConditions ?? []),
          summaryDayRolesStatus: semanticSetting?.summaryDayRolesStatus ?? (seedSemantics ? 'configured' : 'unavailable'),
          summaryDayRolesSource: semanticSetting?.summaryDayRolesSource ?? (seedSemantics ? 'seed' : 'unset'),
          erpTierApplicability: semanticSetting?.erpTierApplicability ?? seedSemantics?.erpTierApplicability ?? 'unset',
          erpTierApplicabilitySource: semanticSetting?.erpTierApplicabilitySource ?? (seedSemantics ? 'seed' : 'unset'),
        });
      }
    }

    classCategories = Array.from(classCategoryMap.values());
    classSemantics = Array.from(classSemanticMap.values());

    // D2c N-1：快照寫入點唯一。
    // 原本此處另有「若 calculation_runs 在呼叫前已存在（例如測試中先建好 run）就補寫快照」
    // 的分支，該分支只為測試而存在、且讓寫入點不唯一（與 saveCalculationRun 的正式寫入並行）。
    // 已移除：快照一律由 saveCalculationRun 在 calculation_runs 確定存在之後寫入，
    // 既避免 run_class_categories 的 ON DELETE CASCADE 級聯刪除，也讓寫入點只有一處。
    // 呼叫端契約不變：executeCalculationRun 仍在回傳物件中帶 classCategories。
  }

  return { run, results, classCategories, classSemantics };
}

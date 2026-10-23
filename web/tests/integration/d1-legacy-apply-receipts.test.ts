import { describe, it, expect } from 'vitest';
import { activateBatch, activeState, makeStudent, saveRun, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';
import { getClassNameMatchReport, resolvePreviousRosterProvenance } from '@/application/class-name-match-report';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { saveCalculationRun, type StudentCalculationRecord } from '@/adapters/sqlite/runs-repository';

/**
 * D1 r2 B3：舊版 apply receipt 的溯源（specs/03 §5.2.4、Q12）。
 *
 * 舊資料庫（35c8bde 之前寫入）的 apply 收據形狀，逐版本以 git history 查證（apply-settings.ts）：
 *   - 一律建立 run：payload＝{ settingsVersionId, runId:<字串>, revision, totalStudents, mismatchCount[, appliedAt] }，
 *     沒有 mode 欄位，且 idempotency_records.run_id＝該 runId（不是 NULL）；appliedAt 自 5daef9c 起才有。
 *   - 2bea9b8／f4f8260／5daef9c 的 apply 會 UPDATE active_state SET active_import_id＝該次名單、active_run_id、revision；
 *     dd9f08d 起只寫 active_run_id 與 revision（名單由 server 依 active_state 決定）。
 *   - 沒有任何版本寫出過「無 mode、run_id 為 NULL」的收據；mode:'settings_only'＋run_id NULL 從 35c8bde 才有。
 * 判定原則（fail-closed，依 evidence，不依欄位缺席）：
 *   (a) 真實舊形狀＝無 mode、payload.runId 為字串、row.run_id＝payload.runId：該 run 必須存在、其名單批次必須存在；
 *       run 的名單＝當時現行名冊 → 併入該 episode；不同於當時現行名冊（舊版曾能切換名單）→ 只有被後續收據或現行狀態
 *       佐證時才算切換，否則整段歷史無法判定。
 *   其餘一律 unavailable：無 mode 且無 runId 的形狀（歷史上從未寫出過）、run 不存在、row.run_id 與 payload 不一致、
 *       無 mode 但 row 與 payload 各執一詞、或來歷不明的收據，皆不得填補 revision gap，一律 fail-closed 為 unavailable。
 * 全部使用合成資料（不含真實名單）；收據以 SQL 直接寫入，因為現行 code 已無法產生這些舊形狀。
 */

const T = (n: number) => `2026-09-0${n}T08:00:00.000Z`;

interface LegacyOpts {
  key: string;
  revision: number;
  runId: string;
  importId: string;
  /** 5daef9c 起才有 appliedAt；2bea9b8／f4f8260 沒有 */
  appliedAt?: string | null;
  /** 2bea9b8／f4f8260／5daef9c 的 apply 一併切換 active_import_id；dd9f08d 不會 */
  switchesRoster?: boolean;
  /** 反例用：run 不建立（模擬 run 已不存在） */
  skipRun?: boolean;
  /** 反例用：row.run_id 與 payload.runId 不一致 */
  rowRunId?: string | null;
}

/** 依舊版 apply-settings.ts 的行為寫入一筆 legacy apply：run、收據、active_state。 */
function insertLegacyApply(db: ReturnType<ReturnType<typeof useGlobalTempDb>['db']>, o: LegacyOpts) {
  if (!o.skipRun) {
    const now = T(o.revision);
    const students = db.prepare(
      'SELECT person_code, name, branch, grade, grade_raw, source_row FROM imported_students WHERE import_id = ? ORDER BY source_row'
    ).all(o.importId) as Array<{
      person_code: string; name: string; branch: string | null; grade: number | null; grade_raw: string | null; source_row: number;
    }>;
    const results: StudentCalculationRecord[] = students.map((student) => ({
      id: `${o.runId}_${student.person_code}`, runId: o.runId, personCode: student.person_code, name: student.name,
      branch: student.branch, grade: student.grade, gradeRaw: student.grade_raw, subjectCount: 1,
      baseDiscountBps: 10000, anqinDays: null, anqinDisplay: null, tutoringDays: 5, tutoringDisplay: '5',
      englishDays: null, mathDays: null, chineseDays: null, homeworkDays: null, intensiveEnglishDays: null,
      saturdayTutoringDays: null, applicableAnqinBps: 10000, applicableTutoringBps: 10000,
      applicableEnglishBps: 10000, applicableMathBps: 10000, tierMismatch: false, tierComparisons: [],
      issues: [], hasIssues: false, trace: { sourceRow: student.source_row, rawTags: '', rawNotes: '', enrollments: [] },
      createdAt: now,
    }));
    saveCalculationRun(db, {
      id: o.runId, importId: o.importId, scheduleVersionId: 'seed-v250922', ruleSetVersion: 'erp-tag-v2',
      numericPolicy: 'integer-minute-rational-v1', asOfDate: '2026-09-15', status: 'completed', issueCounts: {},
      totalStudents: results.length, createdAt: now,
    }, results);
  }
  const payload: Record<string, unknown> = {
    settingsVersionId: `setv_${o.key}`,
    runId: o.runId,
    revision: o.revision,
    totalStudents: 1,
    mismatchCount: 0,
  };
  if (o.appliedAt !== null) payload.appliedAt = o.appliedAt ?? T(o.revision);
  const rowRunId = o.rowRunId === undefined ? o.runId : o.rowRunId;
  db.prepare(
    'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(o.key, `h_${o.key}`, rowRunId, JSON.stringify(payload), T(o.revision));
  if (o.switchesRoster) {
    db.prepare('UPDATE active_state SET active_import_id = ?, active_run_id = ?, revision = ? WHERE id = 1').run(
      o.importId,
      o.runId,
      o.revision
    );
  } else {
    db.prepare('UPDATE active_state SET active_run_id = ?, revision = ? WHERE id = 1').run(o.runId, o.revision);
  }
}

/** Explicitly upgrade historical synthetic runs before a later ordinary activation. */
function explicitlyUpgradeActiveRun(db: ReturnType<ReturnType<typeof useGlobalTempDb>['db']>, key: string) {
  const state = activeState(db);
  const importId = state.active_import_id;
  if (!importId) throw new Error('Expected a synthetic active import before upgrade');
  const preview = previewSettingsChange(db, importId, {
    draft: buildSeedDraft(),
    expectedRevision: state.revision,
    targetRuleSetVersion: 'erp-tag-v4',
  });
  applySettingsPreview(db, {
    previewId: preview.previewId,
    expectedRevision: state.revision,
    idempotencyKey: `explicit-v4-upgrade-${key}`,
  });
}

describe('D1 r2 B3：舊版 apply receipt 的名冊溯源', () => {
  const ctx = useGlobalTempDb('sb-d1-legacy-');

  function seedAC() {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_A', 'A.xlsx', T(1), [makeStudent('a1', ['國小數學-一A']), makeStudent('a2', ['國小數學-一A'])]);
    saveSyntheticBatch(db, 'imp_C', 'C.xlsx', T(2), [makeStudent('c1', ['國小數學-一A'])]);
    return db;
  }

  it('(a) 真實舊形狀（dd9f08d：同名冊、有 appliedAt）與無 appliedAt 的變體：整段歷史仍可證，A 無前份；其後啟用 C 的前份為 A', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1（真實 activate 收據）
    insertLegacyApply(db, { key: 'legacy-1', revision: 2, runId: 'run_legacy_1', importId: 'imp_A' });
    insertLegacyApply(db, { key: 'legacy-2', revision: 3, runId: 'run_legacy_2', importId: 'imp_A', appliedAt: null });
    explicitlyUpgradeActiveRun(db, 'legacy-receipt-sequence-a');

    const resA = resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'latest' });
    expect(resA, '舊 apply 收據不得讓整段歷史變成 unavailable；A 是第一份現行名冊 → none').toEqual({ status: 'none', importId: null });
    const reportA = getClassNameMatchReport(db, { importId: 'imp_A', scope: { kind: 'latest' } });
    expect(reportA.previousRosterStatus).toBe('none');

    // 舊 apply 產生的 run 屬於 A 的 episode（無前份）
    expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'run', runId: 'run_legacy_1' })).toEqual({ status: 'none', importId: null });
    expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'run', runId: 'run_legacy_2' })).toEqual({ status: 'none', importId: null });

    // 舊收據之後明確升級 A，再啟用 C：C 的前份是 A。
    activateBatch(db, 'imp_C', 'k-act-C');
    expect(activeState(db).revision).toBe(5);
    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' })).toEqual({ status: 'ok', importId: 'imp_A' });
    // 舊 apply 的 run 仍錨定在 A 的 episode，不隨現在 active 漂移
    expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'run', runId: 'run_legacy_2' })).toEqual({ status: 'none', importId: null });
  });

  it('(a) 舊版（2bea9b8～5daef9c）apply 曾切換現行名冊：A 啟用後 legacy apply 切到 C，且現行狀態佐證 → C 的前份為 A，A 的前份為 C（檢視另一份時）', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    insertLegacyApply(db, { key: 'legacy-switch', revision: 2, runId: 'run_legacy_C', importId: 'imp_C', switchesRoster: true });

    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }), '現行狀態（active import／run）佐證 legacy apply 切到 C → C 的前份是 A').toEqual({
      status: 'ok',
      importId: 'imp_A',
    });
    expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'latest' }), '檢視非現行的 A：上一份現行名冊是目前現行的 C').toEqual({
      status: 'ok',
      importId: 'imp_C',
    });
    // 該 legacy run 屬於 C 的 episode，前份是 A
    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'run', runId: 'run_legacy_C' })).toEqual({ status: 'ok', importId: 'imp_A' });
  });

  it('(a) 舊版 apply 是第一個事件（尚無任何 activate）且現行狀態佐證：C 是第一份現行名冊 → none；無 appliedAt 的 2bea9b8 形狀亦同', () => {
    const db = seedAC();
    insertLegacyApply(db, { key: 'legacy-first', revision: 1, runId: 'run_legacy_first', importId: 'imp_C', switchesRoster: true, appliedAt: null });

    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' })).toEqual({ status: 'none', importId: null });
  });

  it('(a) 仍為 v2 的 legacy switch 後，普通 activate 必須先要求明確 v4 升級', () => {
    const db = seedAC();
    saveSyntheticBatch(db, 'imp_D', 'D.xlsx', T(3), [makeStudent('d1', ['國小數學-一A'])]);
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    insertLegacyApply(db, { key: 'legacy-switch', revision: 2, runId: 'run_legacy_C', importId: 'imp_C', switchesRoster: true });
    expect(() => activateBatch(db, 'imp_D', 'k-act-D')).toThrow(/預覽並確認升級至 erp-tag-v4/);
    expect(activeState(db).active_import_id).toBe('imp_C');
  });

  it('(a) 反例：payload.runId 有值但 run 不存在 → unavailable（不因「無 mode」就信任）', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A');
    insertLegacyApply(db, { key: 'legacy-missing-run', revision: 2, runId: 'run_gone', importId: 'imp_A', skipRun: true });

    expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
  });

  it('(a) 反例：row.run_id 與 payload.runId 不一致，或 row.run_id 為 NULL 但 payload 有 runId → unavailable', () => {
    const dbMismatch = seedAC();
    activateBatch(dbMismatch, 'imp_A', 'k-act-A');
    insertLegacyApply(dbMismatch, { key: 'legacy-mismatch', revision: 2, runId: 'run_x', importId: 'imp_A', rowRunId: 'run_other' });
    expect(resolvePreviousRosterProvenance(dbMismatch, 'imp_A', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
  });

  it('(a) 反例：row.run_id 為 NULL 但 payload.runId 有值（各執一詞的無 mode 收據）→ unavailable', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A');
    insertLegacyApply(db, { key: 'legacy-null-row', revision: 2, runId: 'run_x', importId: 'imp_A', rowRunId: null });
    expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
  });

  it('R2-1 反例：無 mode、row.run_id 為 NULL、payload 無 runId 的防禦形狀不得被視為 settings_only，歷史必須 fail-closed unavailable', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    db.prepare(
      'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'legacy-null-run',
      'h',
      null,
      JSON.stringify({ settingsVersionId: 'setv_old', runId: null, revision: 2, totalStudents: null, mismatchCount: null, appliedAt: T(2) }),
      T(2)
    );
    db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

    expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
    const reportA = getClassNameMatchReport(db, { importId: 'imp_A', scope: { kind: 'latest' } });
    expect(reportA.previousRosterStatus).toBe('unavailable');

    activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
    const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
    expect(reportC.previousRosterStatus).toBe('unavailable');
  });

  it('R2-1 gap 填補反例（primary probe X1）：僅 {revision:2} 的收據不得填補 revision gap 使其後啟用判定為可證歷史', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    db.prepare(
      'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('unknown-X1', 'h', null, JSON.stringify({ revision: 2 }), T(2));
    db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

    activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
    const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
    expect(reportC.previousRosterStatus).toBe('unavailable');
  });

  it('R2-1 gap 填補反例（primary probe X2）：帶任意欄位 {revision:2, foo:"bar"} 的收據不得填補 revision gap', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    db.prepare(
      'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('unknown-X2', 'h', null, JSON.stringify({ revision: 2, foo: 'bar' }), T(2));
    db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

    activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
    const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
    expect(reportC.previousRosterStatus).toBe('unavailable');
  });

  it('R2-1 gap 填補反例（primary probe X3）：r1 K1 形狀 {runId:null,…} 的收據不得填補 revision gap', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    db.prepare(
      'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'unknown-X3',
      'h',
      null,
      JSON.stringify({ settingsVersionId: 's', runId: null, revision: 2, totalStudents: null, mismatchCount: null }),
      T(2)
    );
    db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

    activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
    const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
    expect(reportC.previousRosterStatus).toBe('unavailable');
  });

  it('R2-1 gap 填補反例（對照組）：同一 revision 2 若完全沒有收據（真正的 gap），結果同樣為 unavailable', () => {
    const dbGap = seedAC();
    activateBatch(dbGap, 'imp_A', 'k-act-A'); // rev 1
    dbGap.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run(); // revision 變為 2，但無收據
    activateBatch(dbGap, 'imp_C', 'k-act-C'); // rev 3
    expect(resolvePreviousRosterProvenance(dbGap, 'imp_C', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
    const reportGap = getClassNameMatchReport(dbGap, { importId: 'imp_C', scope: { kind: 'latest' } });
    expect(reportGap.previousRosterStatus).toBe('unavailable');
  });

  it('K2 守衛（維持 unavailable）：有 run、active_state 有現行名單但完全沒有任何收據 → 不猜歷史', () => {
    const db = seedAC();
    saveRun(db, 'run_B', 'imp_C', 'seed-v250922', T(3));
    db.prepare('UPDATE active_state SET active_import_id = ?, active_run_id = ?, revision = 1 WHERE id = 1').run('imp_C', 'run_B');

    expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' })).toEqual({ status: 'unavailable', importId: null });
  });

  it('B-1 反例 Y1：mode 為 settings_only 卻帶 runId 字串（內部矛盾收據）不得被接受，C 的上一份名冊必須 fail-closed unavailable', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    db.prepare(
      'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'settings-only-with-runId',
      'h',
      null,
      JSON.stringify({ mode: 'settings_only', settingsVersionId: 's', runId: 'run_x', revision: 2, totalStudents: null, mismatchCount: null, appliedAt: T(2) }),
      T(2)
    );
    db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

    activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
    expect(
      resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
      'settings_only 帶 runId 字串屬內部矛盾收據，不得填補 revision gap，C 的前份名冊必須為 unavailable'
    ).toEqual({ status: 'unavailable', importId: null });
    const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
    expect(reportC.previousRosterStatus).toBe('unavailable');
  });

  it('B-1 反例 S0：mode 為 settings_only 卻缺 runId 欄位（未對齊生產者 runId: null 契約）不得被接受，C 的上一份名冊必須 fail-closed unavailable', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    db.prepare(
      'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'settings-only-missing-runId',
      'h',
      null,
      JSON.stringify({ mode: 'settings_only', settingsVersionId: 's', revision: 2 }),
      T(2)
    );
    db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

    activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
    expect(
      resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
      'settings_only 缺少 runId: null 契約欄位，不得填補 revision gap，C 的前份名冊必須為 unavailable'
    ).toEqual({ status: 'unavailable', importId: null });
    const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
    expect(reportC.previousRosterStatus).toBe('unavailable');
  });

  it('B-1 正向案例：真實 settings_only 收據（對齊生產者 runId: null 契約、row.run_id 為 NULL）正常被接受為可證歷史', () => {
    const db = seedAC();
    activateBatch(db, 'imp_A', 'k-act-A'); // rev 1
    db.prepare(
      'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'settings-only-real',
      'h',
      null,
      JSON.stringify({ mode: 'settings_only', settingsVersionId: 's', runId: null, revision: 2, totalStudents: null, mismatchCount: null, appliedAt: T(2) }),
      T(2)
    );
    db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

    activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
    expect(
      resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
      '合法的 settings_only 收據可證名冊延續，C 的前份名冊為 A'
    ).toEqual({ status: 'ok', importId: 'imp_A' });
    const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
    expect(reportC.previousRosterStatus).toBe('ok');
    expect(reportC.previousRoster?.importId).toBe('imp_A');
  });

  describe('D1 follow-up 補強：上一份名冊 resolver 跨筆一致性（R4-1、R4-2、N-G）', () => {
    it('R4-1 反例 probe G1：with_students 收據的 run 不屬於當時現行名冊（run.importId !== currentEpisode.importId）不得被併入，名冊必須 fail-closed unavailable', () => {
      const db = seedAC();
      activateBatch(db, 'imp_A', 'k-act-A'); // rev 1 (episode A)
      activateBatch(db, 'imp_C', 'k-act-C'); // rev 2 (episode C)

      // 在 imp_A 上建一個 run_A_app，其 import_id 為 imp_A（非當時現行名冊 imp_C）
      saveRun(db, 'run_A_app', 'imp_A', 'seed-v250922', T(3));
      db.prepare(
        'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'with-students-wrong-roster',
        'h',
        'run_A_app',
        JSON.stringify({
          mode: 'with_students',
          settingsVersionId: 's',
          runId: 'run_A_app',
          revision: 3,
          totalStudents: 1,
          mismatchCount: 0,
          appliedAt: T(3),
        }),
        T(3)
      );
      db.prepare('UPDATE active_state SET active_run_id = ?, revision = 3 WHERE id = 1').run('run_A_app');

      // latest 查 C 的上一份名冊：因 rev 3 with_students run 名冊不屬於 episode C，必須 fail-closed unavailable
      expect(
        resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
        'with_students 的 run 所屬名冊與當時 episode 不一致，整段歷史必須 unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
      const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
      expect(reportC.previousRosterStatus).toBe('unavailable');

      // run scope 查該 run_A_app：同樣必須為 unavailable，不得誤認歸入 episode C 回 ok/imp_A
      expect(
        resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'run', runId: 'run_A_app' }),
        'run scope 查不一致 run 亦必須 fail-closed unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
    });

    it('R4-1 反例 probe G1b：在 A 現行期間插入指涉 C 名冊 run 的 with_students 收據，其後啟用 D 必須 fail-closed unavailable', () => {
      const db = seedAC();
      saveSyntheticBatch(db, 'imp_D', 'D.xlsx', T(3), [makeStudent('d1', ['國小數學-一A'])]);
      activateBatch(db, 'imp_A', 'k-act-A'); // rev 1 (episode A)

      // 在 imp_C 上建 run_C_rogue（非當時現行名冊 imp_A）
      saveRun(db, 'run_C_rogue', 'imp_C', 'seed-v250922', T(2));
      db.prepare(
        'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'with-students-G1b',
        'h',
        'run_C_rogue',
        JSON.stringify({
          mode: 'with_students',
          settingsVersionId: 's',
          runId: 'run_C_rogue',
          revision: 2,
          totalStudents: 1,
          mismatchCount: 0,
          appliedAt: T(2),
        }),
        T(2)
      );
      db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

      activateBatch(db, 'imp_D', 'k-act-D'); // rev 3
      expect(
        resolvePreviousRosterProvenance(db, 'imp_D', { kind: 'latest' }),
        '歷史中存在名冊不一致之 with_students 收據，D 的上一份名冊必須 fail-closed unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
      const reportD = getClassNameMatchReport(db, { importId: 'imp_D', scope: { kind: 'latest' } });
      expect(reportD.previousRosterStatus).toBe('unavailable');
    });

    it('R4-2 反例 probe G2：with_students 收據重用先前 activate 收據之 runId（填補 gap 企圖），必須 fail-closed unavailable', () => {
      const db = seedAC();
      const actA = activateBatch(db, 'imp_A', 'k-act-A'); // rev 1, runId: actA.runId

      // rev 2 with_students 重用 actA.runId
      db.prepare(
        'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'with-students-reuse-runId',
        'h',
        actA.runId,
        JSON.stringify({
          mode: 'with_students',
          settingsVersionId: 's',
          runId: actA.runId,
          revision: 2,
          totalStudents: 1,
          mismatchCount: 0,
          appliedAt: T(2),
        }),
        T(2)
      );
      db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

      activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
      expect(
        resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
        '跨收據重用 runId 屬偽造／毀損資料，不得填補 revision gap，C 的前份名冊必須 unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
      const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
      expect(reportC.previousRosterStatus).toBe('unavailable');
    });

    it('R4-2 反例 probe G2b：activate 收據重用前一筆 activate 收據之 runId，必須 fail-closed unavailable', () => {
      const db = seedAC();
      const actA = activateBatch(db, 'imp_A', 'k-act-A'); // rev 1, runId: actA.runId

      // rev 2 activate 收據再次使用 actA.runId
      db.prepare(
        'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'activate-reuse-runId',
        'h',
        actA.runId,
        JSON.stringify({
          status: 'completed',
          activeImportId: 'imp_A',
          activeRunId: actA.runId,
          runId: actA.runId,
          revision: 2,
        }),
        T(2)
      );
      db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

      activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
      expect(
        resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
        'activate 收據重用既有 runId 必須 fail-closed unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
      const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
      expect(reportC.previousRosterStatus).toBe('unavailable');
    });

    it('R4-2 反例 probe G2c：legacy apply 收據重用先前 activate 收據之 runId，必須 fail-closed unavailable', () => {
      const db = seedAC();
      const actA = activateBatch(db, 'imp_A', 'k-act-A'); // rev 1, runId: actA.runId

      // rev 2 legacy apply 收據重用 actA.runId（run 已存在於 DB，skipRun: true）
      insertLegacyApply(db, { key: 'legacy-reuse-runId', revision: 2, runId: actA.runId, importId: 'imp_A', skipRun: true });

      activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
      expect(
        resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
        'legacy apply 收據重用既有 runId 必須 fail-closed unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
      const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
      expect(reportC.previousRosterStatus).toBe('unavailable');
    });

    it('N-G 反例：with_students 混入 activate 鑑別欄位（status 或 activeImportId）時不得被接受，必須 fail-closed unavailable', () => {
      const db = seedAC();
      activateBatch(db, 'imp_A', 'k-act-A'); // rev 1

      saveRun(db, 'run_A_app2', 'imp_A', 'seed-v250922', T(2));
      // 混入 status: 'completed' 與 activeImportId
      db.prepare(
        'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'with-students-mixed-fields',
        'h',
        'run_A_app2',
        JSON.stringify({
          mode: 'with_students',
          settingsVersionId: 's',
          runId: 'run_A_app2',
          revision: 2,
          totalStudents: 1,
          mismatchCount: 0,
          appliedAt: T(2),
          status: 'completed',
          activeImportId: 'imp_A',
        }),
        T(2)
      );
      db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

      activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
      expect(
        resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
        'with_students 混入 activate 鑑別欄位屬畸形收據，不得填補 revision gap，C 的前份名冊必須 unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
      const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
      expect(reportC.previousRosterStatus).toBe('unavailable');
    });

    it('N-G 反例：settings_only 混入 activate 鑑別欄位（status 或 activeImportId）時不得被接受，必須 fail-closed unavailable', () => {
      const db = seedAC();
      activateBatch(db, 'imp_A', 'k-act-A'); // rev 1

      // 混入 activeImportId
      db.prepare(
        'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'settings-only-mixed-fields',
        'h',
        null,
        JSON.stringify({
          mode: 'settings_only',
          settingsVersionId: 's',
          runId: null,
          revision: 2,
          totalStudents: null,
          mismatchCount: null,
          appliedAt: T(2),
          activeImportId: 'imp_A',
        }),
        T(2)
      );
      db.prepare('UPDATE active_state SET revision = 2 WHERE id = 1').run();

      activateBatch(db, 'imp_C', 'k-act-C'); // rev 3
      expect(
        resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
        'settings_only 混入 activate 鑑別欄位屬畸形收據，不得填補 revision gap，C 的前份名冊必須 unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
      const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
      expect(reportC.previousRosterStatus).toBe('unavailable');
    });

    it('N-G 反例：activate 混入 mode 欄位時不得被接受為 activate，必須 fail-closed unavailable', () => {
      const db = seedAC();
      saveRun(db, 'run_A_act1', 'imp_A', 'seed-v250922', T(1), 'erp-tag-v4');

      // activate 收據混入 mode: 'with_students'
      db.prepare(
        'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'activate-mixed-mode',
        'h',
        'run_A_act1',
        JSON.stringify({
          status: 'completed',
          activeImportId: 'imp_A',
          activeRunId: 'run_A_act1',
          runId: 'run_A_act1',
          revision: 1,
          mode: 'with_students',
        }),
        T(1)
      );
      db.prepare('UPDATE active_state SET active_import_id = ?, active_run_id = ?, revision = 1 WHERE id = 1').run(
        'imp_A',
        'run_A_act1'
      );

      activateBatch(db, 'imp_C', 'k-act-C');
      expect(
        resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' }),
        'activate 混入 mode 欄位屬畸形收據，C 的前份名冊必須 unavailable'
      ).toEqual({ status: 'unavailable', importId: null });
    });

    it('正向驗收：合法 with_students（run 名冊等於當前 episode、runId 全域唯一）與 activate 序列正常可證', () => {
      const db = seedAC();
      activateBatch(db, 'imp_A', 'k-act-A'); // rev 1 (episode A)

      // 在 imp_A 上建全新 run_A_app2，runId 不重複且名冊等於 episode A
      saveRun(db, 'run_A_app2', 'imp_A', 'seed-v250922', T(2), 'erp-tag-v4');
      db.prepare(
        'INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'with-students-legit',
        'h',
        'run_A_app2',
        JSON.stringify({
          mode: 'with_students',
          settingsVersionId: 's',
          runId: 'run_A_app2',
          revision: 2,
          totalStudents: 1,
          mismatchCount: 0,
          appliedAt: T(2),
        }),
        T(2)
      );
      db.prepare('UPDATE active_state SET active_run_id = ?, revision = 2 WHERE id = 1').run('run_A_app2');

      // 此時 A 仍在同一 episode，前份為 none
      expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'latest' })).toEqual({ status: 'none', importId: null });
      expect(resolvePreviousRosterProvenance(db, 'imp_A', { kind: 'run', runId: 'run_A_app2' })).toEqual({ status: 'none', importId: null });

      // 其後啟用 C：C 的前份為 A
      activateBatch(db, 'imp_C', 'k-act-C');
      expect(resolvePreviousRosterProvenance(db, 'imp_C', { kind: 'latest' })).toEqual({ status: 'ok', importId: 'imp_A' });
      const reportC = getClassNameMatchReport(db, { importId: 'imp_C', scope: { kind: 'latest' } });
      expect(reportC.previousRosterStatus).toBe('ok');
      expect(reportC.previousRoster?.importId).toBe('imp_A');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { queryRunStudents } from '@/application/query-students';
import { queryStudentOptions } from '@/application/query-student-options';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { GET as studentsGET } from '@/app/api/v1/runs/[runId]/students/route';
import { getRequest, activateBatch, makeStudent, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';
import { parseResultsState, pruneResultsState } from '@/lib/results-state';

const RETIRED_ONLY = 'NUMERIC_POLICY_DIFFERENCE';
const REAL_ISSUE = 'CONFLICTING_NOTE_SOURCE';

describe('Issue #159 PR-1: historical actionable issue projection', () => {
  const ctx = useGlobalTempDb('sb-issue-159-actionable-');

  it('keeps raw history readable while actionable filters, facets, and stale UI URLs ignore retired-only issues', async () => {
    const db = ctx.db();
    const importId = 'imp_159_historical_projection';
    saveSyntheticBatch(db, importId, 'synthetic.xlsx', '2026-10-23T08:00:00.000Z', [
      makeStudent('SYNTH_CLEAR', []),
      makeStudent('SYNTH_LEGACY', []),
      makeStudent('SYNTH_MIXED', []),
      makeStudent('SYNTH_TIER_REVIEW', []),
    ]);
    const { runId } = activateBatch(db, importId, 'k-159-historical-projection');

    const setHistory = db.prepare(`UPDATE student_calculations
      SET issues = ?, has_issues = ?, tier_comparisons = ?
      WHERE run_id = ? AND person_code = ?`);
    setHistory.run('[]', 0, '[]', runId, 'SYNTH_CLEAR');
    setHistory.run(JSON.stringify([{ code: RETIRED_ONLY, message: 'historical diagnostic only' }]), 1, '[]', runId, 'SYNTH_LEGACY');
    setHistory.run(JSON.stringify([
      { code: RETIRED_ONLY, message: 'historical diagnostic only' },
      { code: REAL_ISSUE, message: 'synthetic business warning' },
    ]), 1, '[]', runId, 'SYNTH_MIXED');
    setHistory.run('[]', 1, JSON.stringify([{ status: 'unavailable', needsReview: true }]), runId, 'SYNTH_TIER_REVIEW');
    db.prepare('UPDATE calculation_runs SET issue_counts = ? WHERE id = ?').run(JSON.stringify({
      [RETIRED_ONLY]: 2,
      [REAL_ISSUE]: 1,
    }), runId);

    const all = queryRunStudents(db, runId, { limit: 100 });
    const byCode = new Map(all.items.map((item) => [item.personCode, item]));
    expect(byCode.get('SYNTH_LEGACY')).toMatchObject({
      issues: [{ code: RETIRED_ONLY, message: 'historical diagnostic only' }],
      hasIssues: true,
      actionableIssues: [],
      actionableHasIssues: false,
    });
    expect(byCode.get('SYNTH_MIXED')).toMatchObject({
      actionableIssues: [{ code: REAL_ISSUE, message: 'synthetic business warning' }],
      actionableHasIssues: true,
    });
    expect(byCode.get('SYNTH_TIER_REVIEW')).toMatchObject({
      issues: [],
      hasIssues: true,
      actionableHasIssues: true,
    });
    expect(all.stats.issuesCount).toBe(2);
    expect(queryRunStudents(db, runId, { hasIssues: true }).items.map((item) => item.personCode).sort())
      .toEqual(['SYNTH_MIXED', 'SYNTH_TIER_REVIEW']);
    expect(queryRunStudents(db, runId, { hasIssues: false }).items.map((item) => item.personCode).sort())
      .toEqual(['SYNTH_CLEAR', 'SYNTH_LEGACY']);

    const options = queryStudentOptions(db, runId, {}).options;
    expect(options.issueCode.map((option) => option.value)).not.toContain(RETIRED_ONLY);
    expect(options.issueCode.map((option) => option.value)).toContain(REAL_ISSUE);
    expect(options.hasIssues.find((option) => option.value === 'true')?.count).toBe(2);

    const staleUrl = parseResultsState({ issueCode: RETIRED_ONLY });
    const restored = pruneResultsState(staleUrl, options);
    expect(restored.filters.issueCode).toBeUndefined();
    expect(restored.pruned).toHaveLength(1);

    const rawResponse = await studentsGET(
      getRequest(`http://127.0.0.1:3000/api/v1/runs/${runId}/students?issueCode=${RETIRED_ONLY}`),
      { params: Promise.resolve({ runId }) }
    );
    expect(rawResponse.status).toBe(200);
    const raw = await rawResponse.json();
    expect(raw.items).toHaveLength(2);
    expect(raw.items.every((item: any) => item.hasIssues && item.issues.some((issue: any) => issue.code === RETIRED_ONLY))).toBe(true);
    expect(raw.items.find((item: any) => item.personCode === 'SYNTH_LEGACY')?.actionableHasIssues).toBe(false);
    expect(getCalculationRun(db, runId)?.issueCounts).toEqual({ [RETIRED_ONLY]: 2, [REAL_ISSUE]: 1 });
  });
});

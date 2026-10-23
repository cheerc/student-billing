import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StudentCalculationItem } from '@/application/query-students';
import DetailDrawer from '@/components/detail-drawer';
import SummaryTable from '@/components/summary-table';

const retiredIssue = { code: 'NUMERIC_POLICY_DIFFERENCE', message: 'synthetic retired diagnostic' };
const businessIssue = { code: 'CONFLICTING_NOTE_SOURCE', message: 'synthetic business warning' };

const student = (over: Record<string, unknown> = {}) => ({
  id: 'calc_synthetic', runId: 'run_synthetic', personCode: 'SYNTH_UI', name: 'Synthetic UI student',
  branch: 'Synthetic', grade: 4, gradeRaw: '4', subjectCount: 1, baseDiscountBps: 10000,
  anqinDays: null, anqinDisplay: '—', tutoringDays: 5, tutoringDisplay: '5',
  englishDays: null, mathDays: null, chineseDays: null, homeworkDays: null,
  intensiveEnglishDays: null, saturdayTutoringDays: null,
  applicableAnqinBps: null, applicableTutoringBps: null, applicableEnglishBps: null, applicableMathBps: null,
  tierMismatch: false, tierComparisons: [], issues: [retiredIssue], hasIssues: true,
  actionableIssues: [], actionableHasIssues: false,
  trace: { rawTags: '', rawNotes: null }, createdAt: '2026-10-23T00:00:00.000Z',
  enrollments: [], sourceRow: 1, classText: null,
  ...over,
}) as unknown as StudentCalculationItem;

const visible = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, '');

function renderSummary(item: StudentCalculationItem): string {
  return renderToStaticMarkup(React.createElement(SummaryTable, {
    students: [item], loading: false, onSelectStudent: () => {},
  }));
}

function renderDrawer(item: StudentCalculationItem): string {
  return visible(renderToStaticMarkup(React.createElement(DetailDrawer, {
    student: item, onClose: () => {},
  })));
}

describe('Issue #159 PR-1: actionable issues drive visible UI warnings', () => {
  it('legacy-only persisted warning has no actionable badge or detail list', () => {
    const legacyOnly = student();
    expect(renderSummary(legacyOnly)).not.toContain('數值政策差異');
    expect(renderSummary(legacyOnly)).toContain('—');
    expect(renderDrawer(legacyOnly)).not.toContain('待確認事項');
  });

  it('mixed business issue and tier review remain visible and actionable', () => {
    const mixed = student({
      issues: [retiredIssue, businessIssue],
      actionableIssues: [businessIssue],
      actionableHasIssues: true,
    });
    expect(renderSummary(mixed)).toContain('備註衝突');
    expect(renderDrawer(mixed)).toContain('備註衝突');
    expect(renderDrawer(mixed)).not.toContain('數值政策差異');

    const tierReview = student({
      issues: [], hasIssues: true,
      tierComparisons: [{ status: 'unavailable', needsReview: true, issues: [] }],
      actionableIssues: [], actionableHasIssues: true,
    });
    expect(renderSummary(tierReview)).toContain('待核對');
    expect(renderDrawer(tierReview)).not.toContain('待確認事項');
  });
});

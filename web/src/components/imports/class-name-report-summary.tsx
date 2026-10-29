import React from 'react';
import type { ClassNameReportSummary } from '@/application/class-name-match-report';

/** 匯入預覽的單一班名同步摘要（04 UX47）：只顯示差異數字與完整清單連結。 */
export function ClassNameReportSummaryCard({ summary }: { summary: ClassNameReportSummary }) {
  return (
    <section className="class-name-report-summary" aria-label="班名同步摘要">
      <div className="class-name-report-summary-title">班名同步</div>
      <p className="class-name-report-summary-copy">
        {`名冊有 ${summary.mismatchCount} 個班名與課表不一致（其中 ${summary.unmappedCount} 個尚未對應，影響 ${summary.unmappedStudents} 位學生）`}
      </p>
      <a className="class-name-report-summary-link" href={summary.reportPath}>
        前往班名同步 →
      </a>
    </section>
  );
}

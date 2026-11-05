import React from 'react';
import type { ClassNameReportSummary } from '@/application/class-name-match-report';

/**
 * 匯入預覽的班名同步摘要（04 UX47）：只顯示差異數字。
 * D64／UX121：啟用前不放任何導向他頁的連結，呼叫端傳 `showLink={false}`；連結改由完成畫面提供（UX122）。
 */
export function ClassNameReportSummaryCard({
  summary,
  showLink = true,
}: {
  summary: ClassNameReportSummary;
  showLink?: boolean;
}) {
  return (
    <section className="class-name-report-summary" aria-label="班名同步摘要">
      <div className="class-name-report-summary-title">班名同步</div>
      <p className="class-name-report-summary-copy">
        {`名冊有 ${summary.mismatchCount} 個班名與課表不一致（其中 ${summary.unmappedCount} 個尚未對應，影響 ${summary.unmappedStudents} 位學生）`}
      </p>
      {showLink && (
        <a className="class-name-report-summary-link" href={summary.reportPath}>
          前往班名同步 →
        </a>
      )}
    </section>
  );
}

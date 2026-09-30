import React from 'react';
import type { ClassNameReportSummary } from '@/application/class-name-match-report';
import { formatDateTime } from '@/lib/datetime';

/**
 * 匯入預覽的班名比對摘要（04 §8 UX47；「使用這份名單」之前）：
 * 兩份清單的班數與影響人數，並連到課表設定「班名對應」的完整報告。完整清單不放這裡。
 */
export function ClassNameReportSummaryCard({ summary }: { summary: ClassNameReportSummary }) {
  const { previousRoster } = summary;
  return (
    <section className="class-name-report-summary" aria-label="班名比對摘要">
      <div className="class-name-report-summary-title">班名比對</div>
      <ul>
        <li>
          米豆奶有／系統無：<strong>{summary.rosterOnlyClassCount} 個班</strong>，影響{' '}
          <strong>{summary.rosterOnlyStudentCount} 位學生</strong>（名冊有這些班名，但還沒有對應到課表）
        </li>
        <li>
          系統有／本次名冊無：<strong>{summary.systemOnlyClassCount} 個班</strong>
          {summary.previousRosterStatus === 'unavailable' ? (
            <>。無法判定上一份現行名冊（歷史記錄不完整）</>
          ) : previousRoster && summary.systemOnlyPreviousRosterStudentCount !== null ? (
            <>
              。上一份名單（{previousRoster.fileName}，{formatDateTime(previousRoster.createdAt)} 建立）在這{' '}
              {summary.systemOnlyClassCount} 個班共有 {summary.systemOnlyPreviousRosterStudentCount} 位學生
            </>
          ) : (
            <>。沒有上一份名單可參考</>
          )}
        </li>
      </ul>
      <a className="class-name-report-summary-link" href={summary.reportPath}>
        查看完整班名比對報告
      </a>
    </section>
  );
}

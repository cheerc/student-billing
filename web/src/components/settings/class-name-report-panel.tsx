import React from 'react';
import type { ClassNameMatchReport } from '@/application/class-name-match-report';
import { formatDateTime } from '@/lib/datetime';

/**
 * 班名比對報告（課表設定「班名對應」；04 §8 UX44–UX46；09 §3.3）。
 * 兩份清單並排、預設展開（不收合）；每份都標出影響的不重複學生數。純呈現，數字全由 read model 提供。
 * D1 不顯示「類別」。
 *
 * 清單用 ARIA 表格（role=table／row／cell）而不是 <table>：下方「待確認米豆奶班名」可編輯表沿用既有 `.mapping-table`，
 * 兩者分開，既有以 `.mapping-table`、`tr` 選取該表的操作與測試不會誤選到報告清單。
 */

const ALIAS_NOTE =
  '已建立別名對應的米豆奶班名，在左邊算「已對應」；右邊只看名冊有沒有直接用該班名報名，' +
  '所以只靠別名覆蓋、名冊沒有直接報名的系統班，仍會列在右邊，並標出由哪些別名覆蓋。';

export function ClassNameReportPanel({ report }: { report: ClassNameMatchReport }) {
  if (report.snapshotStatus === 'unavailable' || !report.rosterOnly || !report.systemOnly) {
    return (
      <section className="card class-name-report" aria-label="班名比對報告">
        <div className="toolbar">
          <span style={{ fontWeight: 600 }}>班名比對報告</span>
        </div>
        <p className="note" style={{ padding: '12px 20px' }}>
          找不到這次計算當時的課表設定，無法判定班名對應；系統不會改用現在的課表猜測。
        </p>
      </section>
    );
  }

  const { rosterOnly, systemOnly, previousRoster } = report;
  const previousLabel = previousRoster
    ? `上一份名單是「${previousRoster.fileName}」（${formatDateTime(previousRoster.createdAt)} 建立）；人數是該班在那份名單的學生數，供對照名冊變動。`
    : '沒有上一份名單可參考，所以不顯示人數。';

  return (
    <section className="card class-name-report" aria-label="班名比對報告">
      <div className="toolbar">
        <span style={{ fontWeight: 600 }}>班名比對報告</span>
        <span className="note end">
          比對這份名單與目前課表設定的班名（已對應 {report.matchedCount} 個名冊班名）
        </span>
      </div>
      <p className="note class-name-report-alias-note">{ALIAS_NOTE}</p>

      <div className="class-name-report-grid">
        <section className="class-name-report-list" aria-label="米豆奶有／系統無">
          <h3>米豆奶有／系統無</h3>
          <p className="note">
            {rosterOnly.length} 個班，影響 {report.rosterOnlyStudents} 位學生。名冊有這些班名，但還沒有對應到課表；
            請在下方「待確認米豆奶班名」建立對應。
          </p>
          {rosterOnly.length === 0 ? (
            <div className="class-name-report-empty">✓ 名冊的班名都已對應到課表。</div>
          ) : (
            <div role="table" aria-label="米豆奶班名清單" className="class-name-report-table cols-2">
              <div role="row" className="class-name-report-row class-name-report-head">
                <div role="columnheader">米豆奶班名</div>
                <div role="columnheader">學生數／筆數</div>
              </div>
              {rosterOnly.map((c) => (
                <div role="row" key={c.baseName} className="class-name-report-row">
                  <div role="cell" style={{ fontWeight: 600 }}>
                    {c.baseName}
                  </div>
                  <div role="cell">
                    {c.students} 人 <span className="subtle">（{c.tokens} 筆）</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="class-name-report-list" aria-label="系統有／本次名冊無">
          <h3>系統有／本次名冊無</h3>
          <p className="note">
            {systemOnly.length} 個班。這些班在課表設定裡，但本次名冊沒有人用該班名報名（系統不會自動停用）。
            {previousRoster && report.systemOnlyPreviousRosterStudents !== null
              ? `上一份名單在這些班共有 ${report.systemOnlyPreviousRosterStudents} 位學生。`
              : ''}
          </p>
          <p className="note">{previousLabel}</p>
          {systemOnly.length === 0 ? (
            <div className="class-name-report-empty">✓ 課表裡的每個班，本次名冊都有人報名。</div>
          ) : (
            <div role="table" aria-label="系統班名清單" className="class-name-report-table cols-3">
              <div role="row" className="class-name-report-row class-name-report-head">
                <div role="columnheader">系統班名</div>
                <div role="columnheader">上一份名單人數</div>
                <div role="columnheader">備註</div>
              </div>
              {systemOnly.map((c) => (
                <div role="row" key={c.baseName} className="class-name-report-row">
                  <div role="cell" style={{ fontWeight: 600 }}>
                    {c.baseName}
                  </div>
                  <div role="cell">{c.previousRosterStudents === null ? '—' : `${c.previousRosterStudents} 人`}</div>
                  <div role="cell">
                    {!c.active && <span className="pill">已停用</span>}
                    {c.aliasCoveredBy.length > 0 && (
                      <span className="subtle">由別名覆蓋：{c.aliasCoveredBy.join('、')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

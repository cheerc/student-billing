import React from 'react';
import { CARE_WINDOWS, CARE_WINDOW_WEEKDAYS } from '@/domain/schedules/overlap-calculator';
import { minutesToTimeString } from '@/contracts/settings';

/**
 * 09 §3.1／06 D33／04 UX24：
 * 照顧時段窗口摘要列（安親、課輔）。
 * 窗口為 ruleSet 固定參數（安親週一至五 13:00–16:00、課輔週一至五 16:30–19:30），
 * 嚴格唯讀，不提供任何編輯輸入框或調整時段按鈕。
 */
export function WindowSummary() {
  const anqinStart = minutesToTimeString(CARE_WINDOWS.anqin.start);
  const anqinEnd = minutesToTimeString(CARE_WINDOWS.anqin.end);
  const tutoringStart = minutesToTimeString(CARE_WINDOWS.tutoring.start);
  const tutoringEnd = minutesToTimeString(CARE_WINDOWS.tutoring.end);
  const weekdaysStr = `週${CARE_WINDOW_WEEKDAYS[0]}–週${CARE_WINDOW_WEEKDAYS[CARE_WINDOW_WEEKDAYS.length - 1]}`;

  return (
    <div className="windows-bar" role="region" aria-label="照顧時段窗口摘要">
      <div className="window-item">
        <span className="window-dot dot-anqin" aria-hidden="true" />
        <span className="window-title">安親窗口</span>
        <span className="window-days">{weekdaysStr}</span>
        <strong className="window-time">{anqinStart}–{anqinEnd}</strong>
      </div>
      <div className="window-item">
        <span className="window-dot dot-tutoring" aria-hidden="true" />
        <span className="window-title">課輔窗口</span>
        <span className="window-days">{weekdaysStr}</span>
        <strong className="window-time">{tutoringStart}–{tutoringEnd}</strong>
      </div>
      <div className="window-hint">
        <span>固定系統窗口（不可編輯），各堂課表與此窗口重疊即行扣天</span>
      </div>
    </div>
  );
}
export default WindowSummary;

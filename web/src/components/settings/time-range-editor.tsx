'use client';

import React from 'react';
import { timeStringToMinutes } from '@/contracts/settings';
import { TimeField24 } from './time-field24';

export interface PendingTimeDraft {
  startTime: string;
  endTime: string;
  message: string;
}

export interface CommittedTimeRange {
  startTime: string;
  endTime: string;
  startMinutes: number | null;
  endMinutes: number | null;
}

interface TimeRangeEditorProps {
  value: { startTime: string; endTime: string };
  pending?: PendingTimeDraft;
  resetGeneration?: number;
  onPendingChange?: (pending: PendingTimeDraft | null) => void;
  onCommit: (value: CommittedTimeRange) => void;
  startLabel: string;
  endLabel: string;
  startTriggerLabel: string;
  endTriggerLabel: string;
  startSliderLabel: string;
  endSliderLabel: string;
  startClassName?: string;
  endClassName?: string;
  errorClassName?: string;
}

function parseEndpoint(value: string): number | null | 'invalid' {
  if (value === '') return null;
  if (!/^\d{2}:\d{2}$/.test(value)) return 'invalid';
  return timeStringToMinutes(value) ?? 'invalid';
}

function validatePair(startTime: string, endTime: string): string | null {
  const start = parseEndpoint(startTime);
  const end = parseEndpoint(endTime);
  if (start === 'invalid' || end === 'invalid') return '時間需使用 24 小時制 HH:mm，範圍為 00:00 至 23:59。';
  if (start !== null && end !== null && end <= start) return '結束時間必須晚於起始時間。';
  return null;
}

/** Keeps both visible endpoints together until a valid pair (including legal blanks) can commit. */
export function TimeRangeEditor({
  value,
  pending,
  resetGeneration = 0,
  onPendingChange,
  onCommit,
  startLabel,
  endLabel,
  startTriggerLabel,
  endTriggerLabel,
  startSliderLabel,
  endSliderLabel,
  startClassName = 'input-time',
  endClassName = 'input-time',
  errorClassName = '',
}: TimeRangeEditorProps) {
  const startTime = pending?.startTime ?? value.startTime;
  const endTime = pending?.endTime ?? value.endTime;

  const update = (field: 'startTime' | 'endTime', nextValue: string) => {
    const nextStart = field === 'startTime' ? nextValue : startTime;
    const nextEnd = field === 'endTime' ? nextValue : endTime;
    const message = validatePair(nextStart, nextEnd);
    if (message) {
      onPendingChange?.({ startTime: nextStart, endTime: nextEnd, message });
      return;
    }

    onPendingChange?.(null);
    onCommit({
      startTime: nextStart,
      endTime: nextEnd,
      startMinutes: parseEndpoint(nextStart) as number | null,
      endMinutes: parseEndpoint(nextEnd) as number | null,
    });
  };

  return (
    <div className={`time-range-editor ${errorClassName}`}>
      <div className="time-inputs-pair">
        <TimeField24
          value={startTime}
          resetGeneration={resetGeneration}
          onChange={(nextValue) => update('startTime', nextValue)}
          label={startLabel}
          triggerLabel={startTriggerLabel}
          sliderLabel={startSliderLabel}
          popoverKey="start"
          className={startClassName}
          onPreviewStart={() => onPendingChange?.({
            startTime,
            endTime,
            message: '滑桿調整尚未完成。',
          })}
        />
        <span className="time-separator">—</span>
        <TimeField24
          value={endTime}
          resetGeneration={resetGeneration}
          onChange={(nextValue) => update('endTime', nextValue)}
          label={endLabel}
          triggerLabel={endTriggerLabel}
          sliderLabel={endSliderLabel}
          popoverKey="end"
          className={endClassName}
          onPreviewStart={() => onPendingChange?.({
            startTime,
            endTime,
            message: '滑桿調整尚未完成。',
          })}
        />
      </div>
      {pending && (
        <div className="pending-time-error" role="alert" data-pending-time-error="">
          {pending.message} 請修正或復原時間後再確認。
        </div>
      )}
    </div>
  );
}

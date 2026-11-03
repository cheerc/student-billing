'use client';

import React from 'react';

export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '未定' },
  { value: '一', label: '週一' },
  { value: '二', label: '週二' },
  { value: '三', label: '週三' },
  { value: '四', label: '週四' },
  { value: '五', label: '週五' },
  { value: '六', label: '週六' },
  { value: '日', label: '週日' },
];

export interface WeekdaySelectProps {
  value: string;
  onChange: (value: string) => void;
  'aria-label': string;
  className?: string;
  disabled?: boolean;
}

/** Shared weekday input. Unknown legacy values stay visible until a person corrects them. */
export function WeekdaySelect({ value, onChange, className, disabled, ...ariaProps }: WeekdaySelectProps) {
  const isLegacyValue = value !== '' && !WEEKDAY_OPTIONS.some((option) => option.value === value);

  return (
    <select
      {...ariaProps}
      className={className}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {WEEKDAY_OPTIONS.map((option) => (
        <option key={option.value || 'blank'} value={option.value}>
          {option.label}
        </option>
      ))}
      {isLegacyValue && <option value={value}>需確認：{value}</option>}
    </select>
  );
}

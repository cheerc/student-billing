'use client';

import React from 'react';

export interface YesNoRadioGroupProps {
  label: string;
  name: string;
  value: boolean;
  onChange?: (val: boolean) => void;
  disabled?: boolean;
}

/**
 * D61：共用「是／否」膠囊單選元件（取代舊核取方塊與下拉選單）。
 * 符合 WCAG 2.2 AA /ui-ux-pro-max 規範：
 * - 每側點擊熱區 min-width: 34px, min-height: 28px
 * - 選中「是」藍底藍字，選中「否」灰底深灰字，對比度 > 6.5:1
 * - 清晰的 :focus-visible 外框
 * - 支援鍵盤左右/上下方向鍵導航切換
 */
export function YesNoRadioGroup({
  label,
  name,
  value,
  onChange,
  disabled = false,
}: YesNoRadioGroupProps): React.JSX.Element {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || !onChange) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (value === true) onChange(false);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (value === false) onChange(true);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`yes-no-radio-group ${disabled ? 'disabled' : ''}`}
      onKeyDown={handleKeyDown}
    >
      <label
        className={`yes-no-option yes-option ${value === true ? 'selected' : ''}`}
      >
        <input
          type="radio"
          name={name}
          value="true"
          checked={value === true}
          onChange={() => onChange?.(true)}
          disabled={disabled}
          className="yes-no-radio-input"
        />
        <span>是</span>
      </label>
      <label
        className={`yes-no-option no-option ${value === false ? 'selected' : ''}`}
      >
        <input
          type="radio"
          name={name}
          value="false"
          checked={value === false}
          onChange={() => onChange?.(false)}
          disabled={disabled}
          className="yes-no-radio-input"
        />
        <span>否</span>
      </label>
    </div>
  );
}

export default YesNoRadioGroup;

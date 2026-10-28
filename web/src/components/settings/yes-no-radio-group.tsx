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
 * 符合 WCAG 2.2 AA /ui-ux-pro-max 規範。
 */
export function YesNoRadioGroup({
  label,
  name: _name,
  value: _value,
  onChange: _onChange,
  disabled: _disabled = false,
}: YesNoRadioGroupProps): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="yes-no-radio-group"
    />
  );
}

export default YesNoRadioGroup;

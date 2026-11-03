'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { timeStringToMinutes } from '@/contracts/settings';

interface TimeParts {
  hour: number;
  minute: number;
}

function partsOf(value: string): TimeParts {
  const minutes = timeStringToMinutes(value);
  return minutes === null
    ? { hour: 0, minute: 0 }
    : { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

function formatParts(parts: TimeParts): string {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export interface TimeField24Props {
  value: string;
  onChange: (value: string) => void;
  label: string;
  triggerLabel: string;
  sliderLabel: string;
  popoverKey: 'start' | 'end';
  onPreviewStart?: () => void;
  className?: string;
  placeholder?: string;
}

/** A text HH:mm field paired with independent 24-hour and minute sliders in native popover UI. */
export function TimeField24({
  value,
  onChange,
  label,
  triggerLabel,
  sliderLabel,
  popoverKey,
  onPreviewStart,
  className = 'input-time',
  placeholder = 'HH:mm',
}: TimeField24Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const suppressInputFocusOpenRef = useRef(false);
  const previewDirtyRef = useRef(false);
  const pendingOpenFrameRef = useRef<number | null>(null);
  const openAnchorRef = useRef<HTMLElement | null>(null);
  const commitPreviewRef = useRef<() => void>(() => undefined);
  const restoreFocusRef = useRef<() => void>(() => undefined);
  const sourceValueRef = useRef(value);
  const [localParts, setLocalParts] = useState<{ sourceValue: string; parts: TimeParts }>(() => ({
    sourceValue: value,
    parts: partsOf(value),
  }));
  const parts = localParts.sourceValue === value ? localParts.parts : partsOf(value);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (sourceValueRef.current === value) return;
    sourceValueRef.current = value;
    previewDirtyRef.current = false;
  }, [value]);

  const closePopover = useCallback(() => {
    if (pendingOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingOpenFrameRef.current);
      pendingOpenFrameRef.current = null;
    }
    const popover = popoverRef.current;
    if (popover?.matches(':popover-open')) popover.hidePopover();
    setPopoverOpen(false);
  }, []);

  useEffect(() => {
    if (!popoverOpen) return;
    const closeOnScroll = () => closePopover();
    window.addEventListener('scroll', closeOnScroll, true);
    return () => window.removeEventListener('scroll', closeOnScroll, true);
  }, [popoverOpen, closePopover]);

  const openPopover = (anchor: HTMLElement | null = triggerRef.current) => {
    if (popoverRef.current?.matches(':popover-open') || pendingOpenFrameRef.current !== null) return;
    const rect = anchor?.getBoundingClientRect();
    if (!rect || !popoverRef.current) return;
    setLocalParts({ sourceValue: value, parts: partsOf(value) });
    const width = 250;
    const height = 170;
    const modalBounds = anchor?.closest('dialog.add-class-dialog')?.getBoundingClientRect();
    const minLeft = modalBounds ? modalBounds.left + 8 : 8;
    const maxLeft = Math.min(window.innerWidth - width - 8, modalBounds ? modalBounds.right - width - 8 : Infinity);
    const left = Math.max(minLeft, Math.min(rect.left, maxLeft));
    const below = rect.bottom + 6;
    const above = rect.top - height - 6;
    const top = modalBounds
      ? below + height <= modalBounds.bottom - 8
        ? below
        : above >= modalBounds.top + 8
          ? above
          : Math.max(modalBounds.top + 8, Math.min(below, modalBounds.bottom - height - 8))
      : below + height <= window.innerHeight - 8
        ? below
        : Math.max(8, above);
    setPopoverStyle({ left, top, width });
    openAnchorRef.current = anchor;
    // Focus and click can both request an open in one interaction. Defer the top-layer
    // operation until that focus stack settles so native popover auto-dismiss is not re-entered.
    pendingOpenFrameRef.current = window.requestAnimationFrame(() => {
      pendingOpenFrameRef.current = null;
      const popover = popoverRef.current;
      if (
        !popover ||
        !openAnchorRef.current?.isConnected ||
        document.activeElement !== openAnchorRef.current ||
        popover.matches(':popover-open')
      ) return;
      popover.showPopover();
      setPopoverOpen(true);
    });
  };

  const commitSliderPreview = useCallback(() => {
    if (!previewDirtyRef.current) return;
    previewDirtyRef.current = false;
    onChange(formatParts(parts));
  }, [onChange, parts]);

  const restoreAnchorFocus = useCallback(() => {
    const anchor = openAnchorRef.current?.isConnected ? openAnchorRef.current : triggerRef.current;
    if (!anchor) return;
    const suppressInputOpen = anchor === inputRef.current;
    if (suppressInputOpen) {
      suppressInputFocusOpenRef.current = true;
      window.requestAnimationFrame(() => {
        suppressInputFocusOpenRef.current = false;
      });
    }
    anchor.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    commitPreviewRef.current = commitSliderPreview;
    restoreFocusRef.current = restoreAnchorFocus;
  }, [commitSliderPreview, restoreAnchorFocus]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !popoverRef.current?.matches(':popover-open')) return;
      event.preventDefault();
      event.stopPropagation();
      commitPreviewRef.current();
      restoreFocusRef.current();
      closePopover();
    };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [closePopover]);

  const updatePart = (key: keyof TimeParts, rawValue: string) => {
    const next = { ...parts, [key]: Number(rawValue) };
    if (!previewDirtyRef.current) onPreviewStart?.();
    previewDirtyRef.current = true;
    setLocalParts({ sourceValue: value, parts: next });
  };

  return (
    <span className="time-field24">
      <input
        ref={inputRef}
        type="text"
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          setLocalParts({ sourceValue: event.target.value, parts: partsOf(event.target.value) });
          onChange(event.target.value);
        }}
        onFocus={() => {
          if (suppressInputFocusOpenRef.current) {
            suppressInputFocusOpenRef.current = false;
            return;
          }
          openPopover(inputRef.current);
        }}
        onClick={() => openPopover(inputRef.current)}
        aria-label={label}
        inputMode="text"
        autoComplete="off"
      />
      <button
        ref={triggerRef}
        type="button"
        className="time-field24-trigger"
        aria-label={triggerLabel}
        aria-expanded={popoverOpen}
        onClick={() => openPopover(triggerRef.current)}
      >
        ▾
      </button>
      <div
        ref={popoverRef}
        popover="auto"
        className="time-field-popover"
        data-time-popover={popoverKey}
        style={popoverStyle}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
            commitSliderPreview();
            closePopover();
          }
        }}
        onToggle={(event) => {
          const toggle = event.nativeEvent as ToggleEvent;
          const isOpen = toggle.newState === 'open';
          setPopoverOpen(isOpen);
          if (!isOpen) {
            if (pendingOpenFrameRef.current !== null) {
              window.cancelAnimationFrame(pendingOpenFrameRef.current);
              pendingOpenFrameRef.current = null;
            }
            if (previewDirtyRef.current) commitSliderPreview();
          }
        }}
      >
        <label>
          <span>小時</span>
          <input
            type="range"
            min="0"
            max="23"
            step="1"
            value={parts.hour}
            aria-label={`${sliderLabel} 小時`}
            onInput={(event) => updatePart('hour', event.currentTarget.value)}
            onPointerUp={commitSliderPreview}
            onPointerCancel={commitSliderPreview}
            onTouchEnd={commitSliderPreview}
            onKeyUp={commitSliderPreview}
            onBlur={commitSliderPreview}
          />
          <output>{String(parts.hour).padStart(2, '0')}</output>
        </label>
        <label>
          <span>分鐘</span>
          <input
            type="range"
            min="0"
            max="59"
            step="1"
            value={parts.minute}
            aria-label={`${sliderLabel} 分鐘`}
            onInput={(event) => updatePart('minute', event.currentTarget.value)}
            onPointerUp={commitSliderPreview}
            onPointerCancel={commitSliderPreview}
            onTouchEnd={commitSliderPreview}
            onKeyUp={commitSliderPreview}
            onBlur={commitSliderPreview}
          />
          <output>{String(parts.minute).padStart(2, '0')}</output>
        </label>
        <div className="time-field24-preview" aria-live="polite">
          {formatParts(parts)}
        </div>
      </div>
    </span>
  );
}

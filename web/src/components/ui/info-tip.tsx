'use client';

import React, { useEffect, useId, useRef, useState } from 'react';

/**
 * 說明 tooltip（specs/09 §6）：hover、focus、click 皆可開，Esc 可關；
 * 內容以 role="tooltip" 呈現並用 aria-describedby 關聯到觸發按鈕，鍵盤與螢幕閱讀器都讀得到。
 * 取代「只有 title 屬性」的做法（title 只有滑鼠 hover 才看得到）。
 *
 * 開啟規則：
 *   - 滑鼠移入／鍵盤聚焦 → 開；移出／失焦 → 關
 *   - 點擊 → 固定開啟（觸控裝置的點一下）；再點一次 → 關
 *   - Esc → 關（直到下一次移入或聚焦）
 *   - 固定開啟時，點擊元件外面 → 關
 * 阻擋錯誤與需確認的後果不可只放在這裡（09 §6）；這裡只放補充說明。
 */
interface InfoTipProps {
  /** 觸發按鈕的名稱（螢幕閱讀器念出，例如「合計折扣說明」） */
  label: string;
  /** 說明內容（短句、數值） */
  children: React.ReactNode;
  /** 觸發按鈕上顯示的內容；預設為 ⓘ（純符號，名稱由 label 提供） */
  trigger?: React.ReactNode;
  /** icon＝圓形 ⓘ 按鈕；plain＝觸發內容本身（例如「待補」徽章）就是按鈕，不加外框 */
  variant?: 'icon' | 'plain';
  className?: string;
}

export function InfoTip({ label, children, trigger = 'ⓘ', variant = 'icon', className }: InfoTipProps) {
  const id = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const open = pinned || ((hover || focus) && !dismissed);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setDismissed(true);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (pinned && rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPinned(false);
        setDismissed(true);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, pinned]);

  return (
    <span
      ref={rootRef}
      className={`infotip${className ? ` ${className}` : ''}`}
      onMouseEnter={() => {
        setHover(true);
        setDismissed(false);
      }}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className={`infotip-btn${variant === 'plain' ? ' infotip-btn-plain' : ''}`}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => {
          setFocus(true);
          setDismissed(false);
        }}
        onBlur={() => setFocus(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (pinned) {
            setPinned(false);
            setDismissed(true);
          } else {
            setPinned(true);
            setDismissed(false);
          }
        }}
      >
        {trigger}
      </button>
      {open && (
        <span role="tooltip" id={id} className="infotip-bubble">
          {children}
        </span>
      )}
    </span>
  );
}

export default InfoTip;

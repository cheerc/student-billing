'use client';

import React, { useRef } from 'react';

/**
 * 頁籤列（specs/09 §6「頁籤鍵盤可操作」，WAI-ARIA Authoring Practices 的 tabs 模式）：
 *   - role="tablist"／"tab"、aria-selected、aria-controls 指向對應的 tabpanel
 *   - roving tabindex：Tab 只停在選中的頁籤，左右方向鍵／Home／End 在頁籤間移動並切換
 *   - Enter／Space 對按鈕原本就有效
 * 面板由呼叫端以 tabPanelProps() 標出，讓 tab 與 tabpanel 互相對應。
 */
export interface TabItem {
  key: string;
  label: React.ReactNode;
}

export const tabId = (prefix: string, key: string) => `${prefix}-tab-${key}`;
export const panelId = (prefix: string, key: string) => `${prefix}-panel-${key}`;

/** 給 tabpanel 容器展開用的屬性。 */
export function tabPanelProps(prefix: string, key: string) {
  return { role: 'tabpanel' as const, id: panelId(prefix, key), 'aria-labelledby': tabId(prefix, key) };
}

interface TabListProps {
  label: string;
  idPrefix: string;
  tabs: TabItem[];
  selected: string;
  onSelect: (key: string) => void;
}

export function TabList({ label, idPrefix, tabs, selected, onSelect }: TabListProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    onSelect(next.key);
    refs.current[next.key]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight') move(index + 1);
    else if (e.key === 'ArrowLeft') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(tabs.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => {
        const isSelected = t.key === selected;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idPrefix, t.key)}
            aria-selected={isSelected}
            aria-controls={isSelected ? panelId(idPrefix, t.key) : undefined}
            tabIndex={isSelected ? 0 : -1}
            className={isSelected ? 'selected' : ''}
            onClick={() => onSelect(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export default TabList;

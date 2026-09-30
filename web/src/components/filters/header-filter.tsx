'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NONE } from '@/lib/results-filters';

/**
 * Excel 式表頭篩選（specs/09 §5.1；D36 六點）。學生總表與班級扣天共用同一個元件。
 *
 * 語意：
 *   - 面板內的勾選是「草稿」，按「確定」才套用；「取消」／Esc／點面板外＝保留原條件。
 *   - 沒有任何勾選＝未設篩選（全部）；先按「取消全選」再確定＝0 筆（`~none`）；勾選部分選項＝該欄 OR。
 *   - 「全選搜尋結果」只加入目前搜尋命中的選項，不清掉搜尋範圍外既有的勾選。
 *   - 選項是資料值本身，「(空白)」與「班名無法解析」是兩個不同的選項，皆不是空字串。
 *
 * 可及性：觸發鈕有名稱與展開狀態；面板 role=dialog、可鍵盤操作（搜尋→全選搜尋結果→取消全選→選項→取消→確定，
 * Tab 在面板內循環）；Esc 關閉且焦點回到觸發鈕；面板以 portal＋fixed 定位並夾在視窗內，
 * 不被 sticky 表頭或 overflow 裁切，確定／取消固定在面板底部，短視窗仍看得到。
 */

export interface FilterOption {
  /** 傳給 API／網址的 wire 值 */
  value: string;
  /** 顯示名稱（同一分區內唯一，不是空字串） */
  label: string;
  /** 去重人數（或班級數） */
  count?: number;
}

export interface FilterSection {
  /** 對應到條件的 key（例如 enrollmentKey） */
  key: string;
  /** 多分區面板才顯示的分區名 */
  title?: string;
  options: FilterOption[];
}

export type SectionValues = Record<string, string[] | undefined>;

interface HeaderFilterProps {
  /** 欄名（觸發鈕名稱為「{欄名}篩選」，面板名稱為「{欄名}篩選面板」） */
  column: string;
  sections: FilterSection[];
  /** 目前已套用的條件（各分區的 wire 值；`['~none']`＝取消全選） */
  value: SectionValues;
  onApply: (next: SectionValues) => void;
}

interface Draft {
  checked: Set<string>;
  none: boolean;
}

const MARGIN = 8;
const PANEL_WIDTH = 320;

interface Position {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  width: number;
}

/** 把面板夾在視窗內：優先放在觸發鈕下方，下方不夠且上方較寬裕時翻到上方；高度不足時內部清單捲動。 */
export function computePanelPosition(rect: { left: number; top: number; bottom: number }, vw: number, vh: number): Position {
  const width = Math.min(PANEL_WIDTH, vw - MARGIN * 2);
  const left = Math.min(Math.max(rect.left, MARGIN), Math.max(MARGIN, vw - width - MARGIN));
  const below = vh - rect.bottom - MARGIN - 4;
  const above = rect.top - MARGIN - 4;
  if (below >= 260 || below >= above) {
    const top = Math.min(Math.max(rect.bottom + 4, MARGIN), vh - 200);
    return { left, top, maxHeight: Math.max(200, Math.min(480, vh - top - MARGIN)), width };
  }
  return { left, bottom: Math.max(MARGIN, vh - rect.top + 4), maxHeight: Math.max(200, Math.min(480, above)), width };
}

function initialDraft(sections: FilterSection[], value: SectionValues): Record<string, Draft> {
  const draft: Record<string, Draft> = {};
  for (const s of sections) {
    const wires = value[s.key] ?? [];
    draft[s.key] = wires[0] === NONE ? { checked: new Set(), none: true } : { checked: new Set(wires), none: false };
  }
  return draft;
}

interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
}

export function HeaderFilter({ column, sections, value, onApply }: HeaderFilterProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<AnchorRect>({ left: 0, top: 0, bottom: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const panelId = useId();
  const active = sections.some((s) => (value[s.key]?.length ?? 0) > 0);

  const close = useCallback((restore: boolean) => {
    restoreFocus.current = restore;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      btnRef.current?.focus();
    }
  }, [open]);

  return (
    <span className="hf-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`hf-trigger${active ? ' hf-active' : ''}`}
        aria-label={`${column}篩選`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-filter-active={active ? 'true' : 'false'}
        onClick={() => {
          if (open) {
            close(true);
            return;
          }
          const r = btnRef.current?.getBoundingClientRect();
          if (r) setAnchorRect({ left: r.left, top: r.top, bottom: r.bottom });
          setOpen(true);
        }}
      >
        <span className="hf-caret" aria-hidden="true" />
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <FilterPanel
            id={panelId}
            column={column}
            sections={sections}
            value={value}
            anchor={btnRef}
            initialRect={anchorRect}
            onClose={close}
            onApply={(next) => {
              onApply(next);
              close(true);
            }}
          />,
          document.body
        )}
    </span>
  );
}

interface PanelProps {
  id: string;
  column: string;
  sections: FilterSection[];
  value: SectionValues;
  anchor: React.RefObject<HTMLButtonElement | null>;
  initialRect: AnchorRect;
  onClose: (restoreFocus: boolean) => void;
  onApply: (next: SectionValues) => void;
}

function FilterPanel({ id, column, sections, value, anchor, initialRect, onClose, onApply }: PanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<Record<string, Draft>>(() => initialDraft(sections, value));
  const [search, setSearch] = useState('');
  const [rect, setRect] = useState<AnchorRect>(initialRect);
  const titleId = `${id}-title`;
  const pos = computePanelPosition(rect, window.innerWidth, window.innerHeight);

  useEffect(() => {
    searchRef.current?.focus();
    // 視窗縮放或表格捲動時，面板跟著觸發鈕重新夾在視窗內
    const reposition = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setRect({ left: r.left, top: r.top, bottom: r.bottom });
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchor]);

  // 點面板與觸發鈕以外＝取消（保留原條件），不搶回焦點
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onClose]);

  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      sections.map((s) => ({
        ...s,
        options: needle ? s.options.filter((o) => o.label.toLowerCase().includes(needle)) : s.options,
      })),
    [sections, needle]
  );

  const setChecked = (sectionKey: string, optionValue: string, on: boolean) => {
    setDraft((d) => {
      const cur = d[sectionKey] ?? { checked: new Set<string>(), none: false };
      const checked = new Set(cur.checked);
      if (on) checked.add(optionValue);
      else checked.delete(optionValue);
      return { ...d, [sectionKey]: { checked, none: false } };
    });
  };

  const selectAllResults = () => {
    setDraft((d) => {
      const next = { ...d };
      for (const s of visible) {
        const cur = next[s.key] ?? { checked: new Set<string>(), none: false };
        const checked = new Set(cur.checked);
        for (const o of s.options) checked.add(o.value);
        next[s.key] = { checked, none: false };
      }
      return next;
    });
  };

  const clearAll = () => {
    setDraft(() => Object.fromEntries(sections.map((s) => [s.key, { checked: new Set<string>(), none: true }])));
  };

  const confirm = () => {
    const next: SectionValues = {};
    for (const s of sections) {
      const d = draft[s.key];
      if (!d) continue;
      if (d.none) next[s.key] = [NONE];
      else if (d.checked.size > 0) next[s.key] = [...d.checked];
      else next[s.key] = undefined;
    }
    onApply(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onClose(true);
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])') ?? []
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const style: React.CSSProperties = {
    position: 'fixed',
    left: pos.left,
    top: pos.top,
    bottom: pos.bottom,
    width: pos.width,
    maxHeight: pos.maxHeight,
  };
  const totalVisible = visible.reduce((n, s) => n + s.options.length, 0);

  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={`${column}篩選面板`}
      aria-modal="false"
      className="hf-panel"
      style={style}
      onKeyDown={onKeyDown}
    >
      <div className="hf-head">
        <div className="hf-title" id={titleId}>{column}</div>
        <input
          ref={searchRef}
          type="text"
          className="hf-search"
          aria-label={`搜尋${column}選項`}
          placeholder="輸入關鍵字過濾選項"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="hf-actions">
          <button type="button" className="hf-link" onClick={selectAllResults}>全選搜尋結果</button>
          <button type="button" className="hf-link" onClick={clearAll}>取消全選</button>
        </div>
      </div>

      <div className="hf-list" data-filter-list>
        {visible.map((s) => {
          const d = draft[s.key];
          return (
            <fieldset key={s.key} className="hf-section" data-filter-section={s.key}>
              {s.title ? <legend className="hf-legend">{s.title}</legend> : null}
              {s.options.map((o) => (
                <label key={o.value} className="hf-option" data-filter-option={o.label}>
                  <input
                    type="checkbox"
                    checked={d?.checked.has(o.value) ?? false}
                    onChange={(e) => setChecked(s.key, o.value, e.target.checked)}
                  />
                  <span className="hf-option-label">{o.label}</span>
                  {o.count !== undefined ? <span className="hf-option-count" data-filter-count>{o.count}</span> : null}
                </label>
              ))}
            </fieldset>
          );
        })}
        {totalVisible === 0 ? <p className="hf-empty" role="status">沒有符合關鍵字的選項</p> : null}
        {sections.some((s) => draft[s.key]?.none) ? (
          <p className="hf-none-note" role="status">已取消全選：按「確定」會顯示 0 筆</p>
        ) : null}
      </div>

      <div className="hf-foot">
        <button type="button" className="btn-secondary" onClick={() => onClose(true)}>取消</button>
        <button type="button" className="btn-primary" onClick={confirm}>確定</button>
      </div>
    </div>
  );
}

export interface ChipItem {
  id: string;
  column: string;
  label: string;
  onRemove: () => void;
}

/** 表格上方已套用條件：可逐一移除，另有「清除全部」（09 §5.1 第 4 點）。沒有條件時不顯示。 */
export function FilterChips({ items, onClearAll }: { items: ChipItem[]; onClearAll: () => void }) {
  if (items.length === 0) return null;
  return (
    <div className="hf-chips" role="group" aria-label="已套用的篩選條件">
      {items.map((it) => (
        <span key={it.id} className="hf-chip">
          <span className="hf-chip-text">{it.column}：{it.label}</span>
          <button type="button" className="hf-chip-remove" aria-label={`移除 ${it.column}：${it.label}`} onClick={it.onRemove}>
            <span aria-hidden="true">✕</span>
          </button>
        </span>
      ))}
      <button type="button" className="hf-clear-all" onClick={onClearAll}>清除全部</button>
    </div>
  );
}

export default HeaderFilter;

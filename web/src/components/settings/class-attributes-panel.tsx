'use client';

import React from 'react';
import {
  CATEGORY_LABELS,
  type ClassAttributesView,
} from '@/domain/classification/class-attributes';
import type { ClassCategory } from '@/domain/classification/class-category';

const CATEGORY_ORDER: ClassCategory[] = ['care', 'math', 'english', 'none'];

interface ClassAttributesPanelProps {
  /** 班名 → 有效屬性（已含 auto 偵測結果與來源） */
  attributes: Map<string, ClassAttributesView>;
  /** 畫面搜尋／星期篩選後的列，代表使用者此刻在看的班 */
  visibleClassNames: string[];
  onSelectCategory: (className: string, category: ClassCategory) => void;
  onToggleFixedFiveDays: (className: string, fixed: boolean) => void;
  onRestoreAuto: (className: string) => void;
}

/**
 * D2b 2（D37 1a）：課表每個班級顯示自動偵測的折扣類別與「天數固定 5 天」旗標，
 * 兩項各自可手動覆寫、可恢復自動。手動後改班名不再重新偵測（由 draft 欄位承載）。
 *
 * 可及性：每個控制項都有可讀標籤（鍵盤可達），來源狀態不只靠顏色，
 * 以文字「自動」／「手動」標示（09 §6）。
 */
export function ClassAttributesPanel({
  attributes,
  visibleClassNames,
  onSelectCategory,
  onToggleFixedFiveDays,
  onRestoreAuto,
}: ClassAttributesPanelProps) {
  const names = [...new Set(visibleClassNames)].filter((n) => attributes.has(n));
  if (names.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: '20px' }} data-class-attributes-panel="">
      <div className="toolbar">
        <span style={{ fontWeight: 600 }}>折扣類別與固定 5 天（{names.length} 個班級）</span>
        <span className="note end">預設依班名自動偵測；可手動指定，或恢復自動</span>
      </div>
      <div className="scroll table-scroll-container">
        <table className="mapping-table">
          <thead>
            <tr>
              <th>班級名稱</th>
              <th>列入多科折扣</th>
              <th>來源</th>
              <th>天數固定 5 天</th>
              <th>來源</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const a = attributes.get(name)!;
              const categoryManual = a.categorySource === 'manual';
              const fixedManual = a.fixedSource === 'manual';
              return (
                <tr key={name} data-class-attribute-row={name}>
                  <td style={{ fontWeight: 600 }}>{name}</td>
                  <td>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <span className="subtle" style={{ fontSize: '11px' }}>列入多科折扣</span>
                      <select
                        value={a.category}
                        aria-label={`${name} 的列入多科折扣`}
                        data-category-select={name}
                        onChange={(e) => onSelectCategory(name, e.target.value as ClassCategory)}
                      >
                        {CATEGORY_ORDER.map((c) => (
                          <option key={c} value={c}>
                            {CATEGORY_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </td>
                  <td>
                    <span className={categoryManual ? 'pill warn' : 'pill'} data-category-source={name}>
                      {categoryManual ? '手動' : '自動'}
                    </span>
                  </td>
                  <td>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={a.fixedFiveDays}
                        aria-label={`${name} 的天數固定 5 天`}
                        data-fixed-five-toggle={name}
                        onChange={(e) => onToggleFixedFiveDays(name, e.target.checked)}
                      />
                      <span>固定 5 天</span>
                    </label>
                  </td>
                  <td>
                    <span className={fixedManual ? 'pill warn' : 'pill'} data-fixed-source={name}>
                      {fixedManual ? '手動' : '自動'}
                    </span>
                  </td>
                  <td>
                    {categoryManual || fixedManual ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        aria-label={`${name} 恢復自動`}
                        data-restore-auto={name}
                        onClick={() => onRestoreAuto(name)}
                      >
                        恢復自動
                      </button>
                    ) : (
                      <span className="subtle">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default ClassAttributesPanel;

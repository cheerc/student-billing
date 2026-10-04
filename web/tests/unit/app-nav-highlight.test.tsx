import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppNav } from '@/components/app-nav';
import { announceImportActivated, resetImportGuide } from '@/lib/import-success-guide';

/**
 * #84：匯入成功後，側邊欄「03 核對結果」加上柔和靜態高亮，把 01→02→03 的導覽心智接續起來。
 *
 * UI/UX Pro Max 對應原則：Continuous Animation（Severity: Medium）——無限循環動畫只該用於
 * 載入指示器，不用於裝飾性元素。故這裡是靜態 box-shadow 外框，不是脈衝或彈跳。
 *
 * 高亮只加在帶 href="/" 的那一列；不可用 aria-live／role="alert" 當作唯一線索：
 * 它要表達的是「下一步在哪裡」，用類別表達、並讓輔助科技讀到既有的項目名稱與連結語意。
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/imports',
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const render = () => renderToStaticMarkup(React.createElement(AppNav));

/**
 * 側邊欄三步驟區塊中指向 03 的那一列 <a>…</a>。
 * 品牌連結也連到 href="/"（<a style=… href="/">），且屬性輸出順序不固定，
 * 故以 data-testid 鎖定（E2E 與本檔共用同一個定位策略）。
 */
const resultsItem = (html: string) =>
  html.match(/<a [^>]*data-testid="nav-item-results"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';

describe('側邊欄導覽：01→02→03 與「03 核對結果」引導（#84）', () => {
  it('三步驟導覽齊全，各連到正確路徑', () => {
    const html = render();

    expect(html).toMatch(/href="\/settings\?tab=schedule"[^>]*>[\s\S]*?01[\s\S]*?課表設定/);
    expect(html).toMatch(/href="\/imports"[^>]*>[\s\S]*?02[\s\S]*?匯入學生/);
    expect(html).toMatch(/href="\/"[^>]*>[\s\S]*?03[\s\S]*?核對結果/);
  });

  it('未匯入成功時不高亮 03（不可對每個使用者永久顯示下一步提示）', () => {
    resetImportGuide();

    expect(render()).not.toContain('nav-item-highlight');
  });

  it('匯入成功後，「03 核對結果」那一列帶 nav-item-highlight', () => {
    announceImportActivated();

    const item = resultsItem(render());

    expect(item).toContain('nav-item-highlight');
    // 只有 03 被高亮；01／02 不受影響（否則會指向已完成或未開始的步驟）
    expect(render().match(/nav-item-highlight/g) ?? []).toHaveLength(1);
    // 高亮不得改變可及名稱與連結語意
    expect(item).toContain('03');
    expect(item).toContain('核對結果');
    expect(item).not.toContain('role="alert"');
    expect(item).not.toContain('aria-live');
  });
});
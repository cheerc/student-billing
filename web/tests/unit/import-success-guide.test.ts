import { describe, it, expect, afterEach } from 'vitest';
import {
  announceImportActivated,
  isImportGuideActive,
  resetImportGuide,
  shouldHighlightResults,
  subscribeImportGuide,
} from '@/lib/import-success-guide';

/**
 * #84：匯入成功後的導覽引導狀態（純邏輯層）。
 *
 * 業務語意：使用者在 02 按下「使用這份名單」後，畫面要指向前往 03 核對結果；
 * 一旦抵達 03（pathname === '/'），引導即完成並永久清除，之後不再復發。
 *
 * UI/UX Pro Max 對應原則（決定「靜態而非動畫」的理由）：
 *   - Continuous Animation（Severity: Medium）：無限循環動畫只該用於載入指示器，
 *     不用於裝飾性元素。故高亮是靜態外框，不是脈衝。
 *   - Reduced Motion（Severity: High）：若日後加入任何動效，必須尊重 prefers-reduced-motion。
 */

describe('#84 匯入成功導引：純邏輯', () => {
  afterEach(() => resetImportGuide());

  it('未匯入前不引導；匯入成功後才引導', () => {
    resetImportGuide();

    expect(isImportGuideActive()).toBe(false);
    expect(shouldHighlightResults(isImportGuideActive(), '/imports')).toBe(false);

    announceImportActivated();

    expect(isImportGuideActive()).toBe(true);
    expect(shouldHighlightResults(isImportGuideActive(), '/imports')).toBe(true);
  });

  it('引導只在 02 匯入頁高亮 03；抵達 03（/）後自動消除（不覆蓋目前頁自身的 active 狀態）', () => {
    expect(shouldHighlightResults(true, '/imports')).toBe(true);
    expect(shouldHighlightResults(true, '/')).toBe(false);
  });

  it('跳到其他頁面不顯示引導：指向 03 的提示不該出現在無關頁面', () => {
    expect(shouldHighlightResults(true, '/settings')).toBe(false);
    expect(shouldHighlightResults(true, '/history')).toBe(false);
  });

  it('抵達 03 後引導永久清除，回到匯入頁也不復發（避免同一個提示反覆出現）', () => {
    announceImportActivated();
    resetImportGuide(); // AppNav 在 pathname === '/' 時呼叫

    expect(isImportGuideActive()).toBe(false);
    expect(shouldHighlightResults(isImportGuideActive(), '/imports')).toBe(false);
  });

  it('announceImportActivated 通知所有訂閱者；訂閱者可取消訂閱', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeImportGuide((v) => seen.push(v));

    announceImportActivated();
    unsubscribe();
    announceImportActivated();
    resetImportGuide();

    expect(seen).toEqual([true]);
  });
});
'use client';

import { useEffect, useState } from 'react';

/**
 * #84：匯入成功後的導覽引導狀態（跨元件的純前端狀態）。
 *
 * 業務語意：使用者完成 02 匯入後，系統要把他引向 03 核對結果。引導只存在於
 * 「完成匯入」到「抵達 03」之間；抵達 03 之後永久清除，同一個提示不復發。
 *
 * 為什麼需要跨元件狀態：側邊欄（AppNav）與匯入工作流（ImportsWorkflow）是兩個不相親的元件樹，
 * 匯入成功只發生在其中一個。要讓「側邊欄知道剛剛匯入成功」又不把狀態倒灌進 URL 或資料層，
 * 用一個模組級的極小訂閱（與本專案既有的 leave-guard-registry 同一手法）。
 *
 * 本模組不碰任何業務資料：不寫 DB、不呼叫 API，純粹是「剛發生過什麼」的 UI 提示狀態。
 */

type Listener = (active: boolean) => void;

let active = false;
const listeners = new Set<Listener>();

/** 使用者完成匯入。側邊欄據此高亮「03 核對結果」。 */
export function announceImportActivated(): void {
  active = true;
  for (const listener of listeners) listener(active);
}

/**
 * 引導已完成或不需要（抵達 03、或任何非匯入頁的切換），清除並通知訂閱者。
 * 不會讓後續的匯入失效：下一次 announceImportActivated 仍可重新開啟。
 */
export function resetImportGuide(): void {
  if (!active) return;
  active = false;
  for (const listener of listeners) listener(active);
}

export function isImportGuideActive(): boolean {
  return active;
}

export function subscribeImportGuide(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 是否該在目前頁高亮「03 核對結果」。
 * 指引只在匯入頁顯示：指向 03 的提示出現在課表設定或匯入紀錄上是誤導。
 */
export function shouldHighlightResults(guideActive: boolean, pathname: string): boolean {
  return guideActive && pathname.startsWith('/imports');
}

/**
 * 元件用的訂閱 hook：跨元件的「匯入完成」事件。
 * 不在 effect 內同步 setState（那是把外部系統的現況搬進來，不是回應變更）：
 * 掛載時以模組現況當初始值，之後只由訂閱回呼更新。
 */
export function useImportGuide(): boolean {
  const [on, setOn] = useState(active);
  useEffect(() => subscribeImportGuide(setOn), []);
  return on;
}
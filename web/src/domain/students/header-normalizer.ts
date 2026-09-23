export const REQUIRED_HEADERS = [
  '所屬分校',
  '所屬班級',
  '姓名',
  '年級',
  '人員代碼',
  '標籤',
  '備註',
] as const;

export const OPTIONAL_HEADERS = [
  '聯絡方式',
  '就學資料',
] as const;

export type RequiredHeader = typeof REQUIRED_HEADERS[number];

export interface HeaderMatchResult {
  isValid: boolean;
  headerRowIndex: number;
  indices: Record<string, number>;
  missingRequired: string[];
  duplicateHeaders: string[];
  extraHeaders: string[];
}

/**
 * 正規化單一標頭文字（去除 BOM、前後空白、換行）。
 */
export function normalizeHeader(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/^﻿/, '')
    .replace(/[\r\n]+/g, '')
    .trim();
}

/**
 * 檢查並比對傳入列的所有儲存格是否包含完整必要標頭。
 */
export function matchHeaders(
  rowValues: (string | null | undefined)[],
  rowIndex = 1
): HeaderMatchResult {
  const indices: Record<string, number> = {};
  const duplicateHeaders: string[] = [];
  const seenHeaders = new Set<string>();
  const extraHeaders: string[] = [];

  const requiredSet = new Set<string>(REQUIRED_HEADERS);
  const optionalSet = new Set<string>(OPTIONAL_HEADERS);

  rowValues.forEach((val, idx) => {
    const norm = normalizeHeader(val);
    if (!norm) return;

    if (seenHeaders.has(norm)) {
      if (!duplicateHeaders.includes(norm)) {
        duplicateHeaders.push(norm);
      }
    } else {
      seenHeaders.add(norm);
      indices[norm] = idx;
    }

    if (!requiredSet.has(norm) && !optionalSet.has(norm)) {
      extraHeaders.push(norm);
    }
  });

  const missingRequired = REQUIRED_HEADERS.filter((h) => indices[h] === undefined);

  const isValid = missingRequired.length === 0 && duplicateHeaders.length === 0;

  return {
    isValid,
    headerRowIndex: rowIndex,
    indices,
    missingRequired,
    duplicateHeaders,
    extraHeaders,
  };
}

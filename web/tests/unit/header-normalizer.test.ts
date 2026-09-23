import { describe, it, expect } from 'vitest';
import {
  normalizeHeader,
  matchHeaders,
  REQUIRED_HEADERS,
} from '@/domain/students/header-normalizer';

describe('標頭正規化與比對測試 (I03, I04)', () => {
  it('應能正規化標頭（去除 BOM、前後空白、換行）', () => {
    expect(normalizeHeader('﻿姓名')).toBe('姓名');
    expect(normalizeHeader(' 所屬班級 \n')).toBe('所屬班級');
    expect(normalizeHeader('人員代碼\r\n')).toBe('人員代碼');
  });

  it('I03: 正確比對必要標頭，允許欄位重排與未知多餘欄', () => {
    const rowValues = [
      '其他非必要欄位',
      '所屬班級',
      '姓名',
      '人員代碼',
      '年級',
      '標籤',
      '備註',
      '所屬分校',
      '自訂多餘欄位',
    ];

    const match = matchHeaders(rowValues);
    expect(match.isValid).toBe(true);
    expect(match.missingRequired).toHaveLength(0);
    expect(match.extraHeaders).toContain('其他非必要欄位');
    expect(match.extraHeaders).toContain('自訂多餘欄位');
    expect(match.indices['姓名']).toBe(2);
    expect(match.indices['人員代碼']).toBe(3);
  });

  it('I03: 缺失必要標頭時應判定為無效，並列出缺漏清單', () => {
    const rowValues = ['姓名', '年級', '備註']; // 缺少 人員代碼、所屬班級、所屬分校、標籤
    const match = matchHeaders(rowValues);
    expect(match.isValid).toBe(false);
    expect(match.missingRequired).toContain('人員代碼');
    expect(match.missingRequired).toContain('所屬班級');
    expect(match.missingRequired).toContain('所屬分校');
    expect(match.missingRequired).toContain('標籤');
  });

  it('I03: 重複必要標頭應被判定為錯誤', () => {
    const rowValues = [
      '所屬分校',
      '所屬班級',
      '姓名',
      '人員代碼',
      '人員代碼', // 重複
      '年級',
      '標籤',
      '備註',
    ];
    const match = matchHeaders(rowValues);
    expect(match.isValid).toBe(false);
    expect(match.duplicateHeaders).toContain('人員代碼');
  });
});

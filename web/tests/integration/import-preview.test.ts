import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { generateImportPreview } from '@/application/import-preview';

describe('匯入預覽 Application 服務測試 (import-preview)', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

  it('應能正確生成匯入預覽摘要、去重人數統計與雜湊', async () => {
    const buf = fs.readFileSync(fixturePath);
    const preview = await generateImportPreview(buf, 'conforming-fixture.xlsx');

    expect(preview.previewId).toBeDefined();
    expect(preview.fileName).toBe('conforming-fixture.xlsx');
    expect(preview.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // 477 / 384 / 93 驗證
    expect(preview.stats.totalStudents).toBe(477);
    expect(preview.stats.studentsWithClass).toBe(384);
    expect(preview.stats.studentsWithoutClass).toBe(93);

    // 離班標記人數
    expect(preview.stats.withdrawnStudentsCount).toBeGreaterThan(0);

    // 學生清單預覽
    expect(preview.students).toHaveLength(477);

    // 待設定班名清單
    expect(preview.pendingClasses.length).toBeGreaterThan(0);
  });

  it('相同內容不同檔名應產生相同的 contentHash', async () => {
    const buf = fs.readFileSync(fixturePath);
    const p1 = await generateImportPreview(buf, 'file-a.xlsx');
    const p2 = await generateImportPreview(buf, 'file-b.xlsx');

    expect(p1.fileHash).toBe(p2.fileHash);
    expect(p1.contentHash).toBe(p2.contentHash);
  });
});

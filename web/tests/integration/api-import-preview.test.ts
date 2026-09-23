import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { POST } from '@/app/api/v1/imports/preview/route';

describe('API: POST /api/v1/imports/preview', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

  it('上傳合法 ERP 試算表應回傳 200 與預覽資料', async () => {
    const fileBytes = fs.readFileSync(fixturePath);
    const blob = new Blob([fileBytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const formData = new FormData();
    formData.append('file', blob, 'sample.xlsx');

    const request = new Request('http://127.0.0.1:3000/api/v1/imports/preview', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.previewId).toBeDefined();
    expect(data.stats.totalStudents).toBe(477);
    expect(data.stats.studentsWithClass).toBe(384);
    expect(data.stats.studentsWithoutClass).toBe(93);
    expect(data.students).toHaveLength(477);
  });

  it('未提供檔案時應回傳 400', async () => {
    const formData = new FormData();
    const request = new Request('http://127.0.0.1:3000/api/v1/imports/preview', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('未提供上傳檔案');
  });
});

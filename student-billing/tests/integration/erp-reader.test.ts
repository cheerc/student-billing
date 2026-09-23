import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readErpWorkbook, ErpReaderError } from '@/adapters/xlsx/erp-reader';

describe('ERP XLSX 讀取器整合測試 (I01–I06, I13)', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

  it('I01: 保形匿名 ERP fixture 應讀出 477 筆學生，384 有班、93 無班，人員代碼唯一', async () => {
    const buf = fs.readFileSync(fixturePath);
    const result = await readErpWorkbook(buf, { fileName: 'test-erp.xlsx' });

    expect(result.totalRows).toBe(477);
    expect(result.studentsWithClass).toBe(384);
    expect(result.studentsWithoutClass).toBe(93);
    expect(result.students).toHaveLength(477);

    // 檢查人員代碼唯一性
    const codes = new Set(result.students.map((s) => s.personCode));
    expect(codes.size).toBe(477);

    // 檢查工作表名稱與標頭列
    expect(result.sheetName).toBe('Sheet1');
    expect(result.headerRowIndex).toBe(1);
    expect(result.issues).toHaveLength(0);
  });

  it('I02: 欄位重排與隱藏欄支援', async () => {
    // 建立一個欄位重排且隱藏所屬班級欄位的 workbook
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');

    // 重排標頭順序：人員代碼、姓名、所屬分校、備註、標籤、年級、所屬班級
    ws.addRow(['人員代碼', '姓名', '所屬分校', '備註', '標籤', '年級', '所屬班級']);
    ws.getColumn(7).hidden = true; // 隱藏班級欄

    ws.addRow(['STU001', '張同學', '校本部', '備註內容', '兄弟姊妹', '三年級', '國小輔導-三年級[團]']);
    ws.addRow(['STU002', '李同學', '校本部', '', '', '四年級', '']);

    const buf = await wb.xlsx.writeBuffer();
    const result = await readErpWorkbook(Buffer.from(buf));

    expect(result.totalRows).toBe(2);
    expect(result.studentsWithClass).toBe(1);
    expect(result.studentsWithoutClass).toBe(1);

    const s1 = result.students[0];
    expect(s1.personCode).toBe('STU001');
    expect(s1.name).toBe('張同學');
    expect(s1.tagsRaw).toBe('兄弟姊妹');
    expect(s1.notesRaw).toBe('備註內容');
    expect(s1.enrollments).toHaveLength(1);
    expect(s1.enrollments[0].baseName).toBe('國小輔導-三年級');
  });

  it('I03: 缺失必要標頭或重複標頭應拋錯拒絕，未知多餘欄應被保留記錄於 extraHeaders', async () => {
    // 1. 缺失必要標頭 (缺少 人員代碼)
    const wbMissing = new ExcelJS.Workbook();
    const wsMissing = wbMissing.addWorksheet('Sheet1');
    wsMissing.addRow(['所屬分校', '所屬班級', '姓名', '年級', '標籤', '備註']); // 缺少人員代碼
    wsMissing.addRow(['分校A', '班級A', '王同學', '一年級', '', '']);
    const bufMissing = await wbMissing.xlsx.writeBuffer();

    await expect(readErpWorkbook(Buffer.from(bufMissing))).rejects.toThrowError(
      /缺少必要標頭/
    );

    // 2. 重複標頭 (兩個 姓名)
    const wbDup = new ExcelJS.Workbook();
    const wsDup = wbDup.addWorksheet('Sheet1');
    wsDup.addRow(['人員代碼', '姓名', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    const bufDup = await wbDup.xlsx.writeBuffer();

    await expect(readErpWorkbook(Buffer.from(bufDup))).rejects.toThrowError(
      /重複標頭/
    );

    // 3. 未知多餘欄位應被允許
    const wbExtra = new ExcelJS.Workbook();
    const wsExtra = wbExtra.addWorksheet('Sheet1');
    wsExtra.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註', '自訂欄位X']);
    wsExtra.addRow(['STU001', '王同學', '分校A', '班級A', '一年級', '', '', '額外資料']);
    const bufExtra = await wbExtra.xlsx.writeBuffer();
    const resExtra = await readErpWorkbook(Buffer.from(bufExtra));
    expect(resExtra.extraHeaders).toContain('自訂欄位X');
    expect(resExtra.totalRows).toBe(1);
  });

  it('I04: 標頭上方有標題列時自動辨識標頭列；多個候選工作表時列出候選', async () => {
    // 標頭前有 3 列標題與空列
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['機構學生名冊 2026 年度']);
    ws.addRow([]);
    ws.addRow(['匯出日期：2026-09-23']);
    ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    ws.addRow(['STU001', '測試生', '本部', '國小數學-三A[團]', '三年級', '', '']);

    const buf = await wb.xlsx.writeBuffer();
    const result = await readErpWorkbook(Buffer.from(buf));
    expect(result.headerRowIndex).toBe(4);
    expect(result.totalRows).toBe(1);

    // 多個有效工作表候選
    const wbMulti = new ExcelJS.Workbook();
    const ws1 = wbMulti.addWorksheet('學生名冊A');
    ws1.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    ws1.addRow(['STU001', 'A生', '本部', '', '一年級', '', '']);

    const ws2 = wbMulti.addWorksheet('學生名冊B');
    ws2.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    ws2.addRow(['STU002', 'B生', '本部', '', '二年級', '', '']);

    const bufMulti = await wbMulti.xlsx.writeBuffer();
    const resultMulti = await readErpWorkbook(Buffer.from(bufMulti));
    expect(resultMulti.candidateSheets).toHaveLength(2);
    expect(resultMulti.candidateSheets).toContain('學生名冊A');
    expect(resultMulti.candidateSheets).toContain('學生名冊B');
  });

  it('I05: 隱藏列、篩選列與空白列處理，不以 max_row 當筆數', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);

    // 第 2 列：正常
    ws.addRow(['STU001', '學生1', '本部', '班級1', '一年級', '', '']);
    // 第 3 列：隱藏列
    const r3 = ws.addRow(['STU002', '學生2', '本部', '班級2', '二年級', '', '']);
    r3.hidden = true;
    // 第 4 列：完全空白列
    ws.addRow([]);
    // 第 5 列：只有空白字串
    ws.addRow(['   ', '', '', '', '', '', '']);
    // 第 6 列：正常
    ws.addRow(['STU003', '學生3', '本部', '', '三年級', '', '']);

    const buf = await wb.xlsx.writeBuffer();
    const result = await readErpWorkbook(Buffer.from(buf));

    // 雖然總共有 6 列，但實際有效學生數應只有 3 筆 (STU001, STU002, STU003)
    expect(result.totalRows).toBe(3);
    expect(result.students.map((s) => s.personCode)).toEqual(['STU001', 'STU002', 'STU003']);
  });

  it('I06: 同名不同代碼保持兩人；同代碼重複應拒絕 (422)', async () => {
    // 1. 同名不同代碼
    const wbSameName = new ExcelJS.Workbook();
    const wsSameName = wbSameName.addWorksheet('Sheet1');
    wsSameName.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    wsSameName.addRow(['STU001', '陳小明', '本部', '', '一年級', '', '']);
    wsSameName.addRow(['STU002', '陳小明', '二校', '', '二年級', '', '']);
    const bufSameName = await wbSameName.xlsx.writeBuffer();

    const resSameName = await readErpWorkbook(Buffer.from(bufSameName));
    expect(resSameName.totalRows).toBe(2);
    expect(resSameName.students).toHaveLength(2);

    // 2. 同代碼兩列 (重複代碼)
    const wbDupCode = new ExcelJS.Workbook();
    const wsDupCode = wbDupCode.addWorksheet('Sheet1');
    wsDupCode.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    wsDupCode.addRow(['STU001', '陳小明', '本部', '', '一年級', '', '']);
    wsDupCode.addRow(['STU001', '陳小華', '本部', '', '一年級', '', '']);
    const bufDupCode = await wbDupCode.xlsx.writeBuffer();

    await expect(readErpWorkbook(Buffer.from(bufDupCode))).rejects.toThrowError(
      /重複人員代碼/
    );
  });

  it('I13: 安全與邊界防護（大小限制、ZIP 展開防護、加密檔、公式單元格拒絕、rich text 轉換）', async () => {
    // 1. 必要欄位含有公式時拒絕
    const wbFormula = new ExcelJS.Workbook();
    const wsFormula = wbFormula.addWorksheet('Sheet1');
    wsFormula.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    const row2 = wsFormula.addRow(['STU001', '公式生', '本部', '', '一年級', '', '']);
    row2.getCell(2).value = { formula: '="公式姓名"' };
    const bufFormula = await wbFormula.xlsx.writeBuffer();

    await expect(readErpWorkbook(Buffer.from(bufFormula))).rejects.toThrowError(
      /包含公式/
    );

    // 2. Rich Text 儲存型態明確文字化（不能是 [object Object]）
    const wbRich = new ExcelJS.Workbook();
    const wsRich = wbRich.addWorksheet('Sheet1');
    wsRich.addRow(['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註']);
    const rowRich = wsRich.addRow(['STU001', '', '本部', '', '一年級', '', '']);
    rowRich.getCell(2).value = {
      richText: [{ text: '陳' }, { text: '大', font: { bold: true } }, { text: '明' }],
    };
    const bufRich = await wbRich.xlsx.writeBuffer();
    const resRich = await readErpWorkbook(Buffer.from(bufRich));
    expect(resRich.students[0].name).toBe('陳大明');
    expect(resRich.students[0].name).not.toContain('[object Object]');

    // 3. 非 XLSX 檔案拒絕
    const fakeTextBuf = Buffer.from('This is a plain text file, not XLSX');
    await expect(readErpWorkbook(fakeTextBuf)).rejects.toThrowError(
      /不合法的 XLSX/
    );

    // 4. 超過單檔大小限制 (測試傳入自訂 maxFileSize)
    const sampleBuf = fs.readFileSync(fixturePath);
    await expect(
      readErpWorkbook(sampleBuf, { maxFileSizeBytes: 100 })
    ).rejects.toThrowError(/超過大小限制/);
  });
});

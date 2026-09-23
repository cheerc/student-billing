import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

/**
 * 依據 specs/04 §2 規範，由本地真實 ERP 來源檔就地替換文字，
 * 產生保留 100% inlineStr、無 sharedStrings、缺 <dimension>、
 * 且徹底消除姓名、代碼、電話等敏感個資的保形匿名測試 fixture。
 */
async function generateConformingFixture() {
  const realFilePath = '/Users/cheerc/Projects/student-billing/嘉義縣私立資優生文教機構.xlsx';
  if (!fs.existsSync(realFilePath)) {
    console.error('Source file not found at:', realFilePath);
    process.exit(1);
  }

  const buf = fs.readFileSync(realFilePath);
  const zip = await JSZip.loadAsync(buf);

  // 1. 處理工作表 sheet1.xml
  const sheetFile = zip.file('xl/worksheets/sheet1.xml');
  if (!sheetFile) {
    throw new Error('sheet1.xml not found in zip');
  }

  let xml = await sheetFile.async('text');

  // 對每一列進行匿名化替換
  // 匹配 <row ... r="2"> ... </row>
  xml = xml.replace(/<row\s+r="(\d+)"[^>]*>(.*?)<\/row>/gs, (match, rowStr, rowContent) => {
    const rowNum = parseInt(rowStr, 10);
    if (rowNum === 1) {
      // 標頭列保持原樣
      return match;
    }

    const stuIndex = rowNum - 1;
    const anonName = `學生${String(stuIndex).padStart(3, '0')}`;
    const anonCode = `STU${String(stuIndex).padStart(4, '0')}`;
    const anonPhone = `0900000${String(stuIndex).padStart(3, '0')}`;

    let newRowContent = rowContent;

    // 替換 C 欄 (姓名)
    newRowContent = newRowContent.replace(
      /(<c[^>]*r="C\d+"[^>]*><is><t[^>]*>)(.*?)(<\/t><\/is><\/c>)/s,
      `$1${anonName}$3`
    );

    // 替換 D 欄 (聯絡方式)
    newRowContent = newRowContent.replace(
      /(<c[^>]*r="D\d+"[^>]*><is><t[^>]*>)(.*?)(<\/t><\/is><\/c>)/s,
      `$1${anonPhone}$3`
    );

    // 替換 E 欄 (就學資料)
    newRowContent = newRowContent.replace(
      /(<c[^>]*r="E\d+"[^>]*><is><t[^>]*>)(.*?)(<\/t><\/is><\/c>)/s,
      `$1測試學校$3`
    );

    // 替換 G 欄 (人員代碼)
    newRowContent = newRowContent.replace(
      /(<c[^>]*r="G\d+"[^>]*><is><t[^>]*>)(.*?)(<\/t><\/is><\/c>)/s,
      `$1${anonCode}$3`
    );

    // 替換 I 欄 (備註) 敏感資訊，若備註含特定關鍵字則保留關鍵字
    newRowContent = newRowContent.replace(
      /(<c[^>]*r="I\d+"[^>]*><is><t[^>]*>)(.*?)(<\/t><\/is><\/c>)/s,
      (_cMatch: string, prefix: string, noteText: string, suffix: string) => {
        let anonymizedNote = `匿名備註_${stuIndex}`;
        if (noteText.includes('園內生') || noteText.includes('幼幼班')) {
          anonymizedNote = `(弟弟園內幼幼班) ${anonymizedNote}`;
        }
        return `${prefix}${anonymizedNote}${suffix}`;
      }
    );

    return `<row r="${rowNum}">${newRowContent}</row>`;
  });

  zip.file('xl/worksheets/sheet1.xml', xml);

  // 2. 清理中繼資料 (移除原作者、最後修改者等資訊)
  if (zip.file('docProps/core.xml')) {
    zip.file(
      'docProps/core.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Anonymized Student Billing Fixture</dc:title>
  <dc:creator>System</dc:creator>
</cp:coreProperties>`
    );
  }

  const outDir = path.resolve(__dirname, '../tests/fixtures');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, 'conforming-erp-fixture.xlsx');
  const outBuf = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(outPath, outBuf);
  console.log('Conforming fixture generated successfully at:', outPath);
  console.log('Size:', outBuf.length, 'bytes');
}

generateConformingFixture().catch((err) => {
  console.error(err);
  process.exit(1);
});

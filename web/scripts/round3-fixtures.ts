import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { execFileSync } from 'child_process';

const HEADERS = ['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註'];
const ALIAS = { rawBaseName: '國小國語文-小三四', targetBaseName: '國小國語文-小三小四' };

/** 所有資料均在程式內合成，不讀既有名冊、fixture 或 legacy generator。 */
function rowsFor(batch: string, size: number): string[][] {
  const rows = [HEADERS];
  const classes = [batch === 'A' ? '國小輔導-一A[團]' : `${ALIAS.rawBaseName}[團]`, '國小數學-一A[團]', '[團]', ''];
  for (let index = 0; index < size; index++) {
    const tags = batch === 'C' && index === 2 ? '特殊折扣85折' : '';
    rows.push([`R3_${String(index + 1).padStart(3, '0')}`, `合成驗收${batch}${index + 1}`, '合成分校', classes[index], '一年級', tags, '']);
  }
  return rows;
}

const xmlEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 正規 OOXML；文字皆 inlineStr、無 sharedStrings、無 dimension。 */
async function workbook(rows: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  const sheetRows = rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`).join('')}</row>`).join('');
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function resolvedTarget(target: string): string {
  const suffix: string[] = [];
  let existing = path.resolve(target);
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('輸出路徑沒有可用的父目錄');
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('用法：npx tsx scripts/round3-fixtures.ts [--out <repo 外的新目錄>]');
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1])) throw new Error('請使用 --out <repo 外的新目錄>，或 --help 查看說明');
  const out = resolvedTarget(args[1] ?? path.join(os.homedir(), 'Downloads/student-billing-round3-fixtures'));
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const commonGitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  const sourceRepo = fs.realpathSync(path.dirname(commonGitDir));
  const inRepo = [repo, sourceRepo].some((root) => {
    const relative = path.relative(root, out);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (inRepo || out.split(path.sep).includes('data')) {
    throw new Error('輸出不可在 repo／data 內；請用 --out 指定 repo 外的新目錄');
  }
  const batches = ['A', 'B', 'C'].map((batch, index) => ({ batch, file: `round3-${batch}.xlsx`, students: index + 2 }));
  const paths = [...batches.map((batch) => path.join(out, batch.file)), path.join(out, 'manifest.json')];
  if (paths.some((file) => fs.existsSync(file))) throw new Error('目標已有驗收檔，不覆寫；請用 --out 指定另一個新目錄');
  fs.mkdirSync(out, { recursive: true });
  for (const batch of batches) {
    fs.writeFileSync(path.join(out, batch.file), await workbook(rowsFor(batch.batch, batch.students)), { flag: 'wx' });
    console.log(`${batch.file}：${batch.students} 人（全合成）；${path.join(out, batch.file)}`);
  }
  // 預期來自上述明列的列資料，不以產品 parser 輸出產生摘要。
  const manifest = {
    synthetic: true,
    batches,
    f03: {
      zeroDays: { status: 'unreachable', reason: '現行 seed 場次均為正值、未命中數學／美語退回2；儲存空課表不改八項總表的 seed 場次來源；安親／課輔有3.5／3天下限。不用null或零科數冒充0天。' },
      zeroSubjects: { batch: 'B', personCode: 'R3_003', expected: 0 },
      falseValue: { batch: 'B', personCode: 'R3_003', field: 'tierMismatch', expected: false },
      nullRates: { batch: 'C', personCode: 'R3_004', expected: null },
      specialRate: { batch: 'C', personCode: 'R3_003', expectedBps: 8500 },
      courseRateVsBase: { status: 'not-covered', reason: '本套未含不同基本率／課程率的優惠對照，不據此簽核該子項；需另用對照案例' },
    },
    unparsed: { batch: 'B', personCode: 'R3_003', rawToken: '[團]', students: 1 },
    alias: ALIAS,
    usage: { A: '2人；空環境啟用與重啟', B: '3人；零科數／false／非空解析失敗與有效班名對應', C: '4人；null／特殊率；內容不同，用於 A→B→C 前份名冊辨識' },
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(`摘要：${path.join(out, 'manifest.json')}；A=2人、B=3人、C=4人；B 有1位非空解析失敗原文`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

/**
 * 帳務比對工具：把網頁系統（米豆奶匯出 run）與米豆奶財務報表 XLSX 逐生比對，
 * 產出 HTML 差異報告（預設輸出到 ~/Downloads/，檔案不會進 Git）。
 *
 * 用法（**必須走 npm 入口，不可直接用 node 跑**）：
 *   cd web
 *   npm run billing:compare -- --xlsx <財務報表.xlsx> [--out <報告.html>] [--base http://127.0.0.1:3000]
 *
 * 為何需要 npm 入口：本檔 import 產品領域層的 TS，而 token-parser.ts 內部使用
 * 無副檔名 import（'./types'），Node 的 ESM resolver 無法解析，裸 node 會
 * ERR_MODULE_NOT_FOUND。npm 入口走既有 tsx，可正確解析（review F-minor-1）。
 *
 * 設計原則：
 *   - 不在本檔案內寫死任何學生姓名或個資；差異原因一律由資料推導（見 buildNotes）。
 *   - 報表與名單存在時間差，差異不預設任何一邊正確；僅標示可由資料佐證的可能成因。
 *   - **不在此複寫產品的班名／級距／離班解析**，一律取 API 或產品解析器已解析好的值。
 *     複寫必然漂移（review F-NEW-2 曾漏 [5]、把 [Starter] 默默當成 5 天；
 *     review F-minor-2 曾以自訂 regex 重複偵測離班標記而與產品寫法分歧）。
 *   - 依 CLAUDE.md §4，所有 npm/node 指令需在 web/ 目錄內執行。
 */
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { parseSingleClassToken } from '../src/domain/students/token-parser.ts';

const SHEET_NAME = '班級營收狀況';

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { base: 'http://127.0.0.1:3000' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--xlsx' && value) { args.xlsx = value; i++; }
    else if (key === '--out' && value) { args.out = value; i++; }
    else if (key === '--base' && value) { args.base = value.replace(/\/$/, ''); i++; }
    else if (key === '--help' || key === '-h') { args.help = true; }
  }
  return args;
}

// ---------------------------------------------------------------- Excel 解析

/**
 * 折扣明細 → bps（10000 = 無折扣）。只認「課程費 NN折」為課程適用率；其餘視為獨立優惠項。
 * rateParseStatus：'parsed' 認得格式、'none' 全是獨立優惠項、'unknown' 見到課程費字樣卻認不出數字。
 * unknown 必須與「確定無折扣」區分：前者是報表格式變了，不能當成沒折扣（review F3）。
 */
const RATE_PATTERNS = [
  [/課程費\s*95\s*折/, 9500],
  [/課程費\s*9\s*折/, 9000],
  [/課程費\s*85\s*折/, 8500],
  [/課程費\s*8\s*折/, 8000],
  [/課程費\s*7\s*折/, 7000],
];

function bpsToLabel(bps) {
  if (bps === null || bps === undefined) return '-';
  if (bps === 10000) return '無折扣 (100%)';
  const zhe = (bps / 1000).toFixed(1).replace(/\.0$/, '');
  return `${zhe}折 (${bps / 100}%)`;
}

/**
 * 學費明細 → 週收費天數。
 *
 * 級距解讀**直接複用產品解析器** `parseSingleClassToken`，不在此複寫一份。
 * 理由（review F-NEW-2）：本檔先前自建 KNOWN_TIERS 白名單並漏掉 `[5]`，
 * 且只挑數字開頭的修飾，導致 `[Starter]` 這類未知修飾被默默當成全週 5 天——
 * 而產品端對未知修飾明確回 erpBillingTier=null + needs_review。複寫即漂移，
 * 故刪除複寫版本，只保留產品輸出到「報表顯示文字」的轉譯。
 *
 * Node 24 原生支援 `import './x.ts'`，故 .mjs 可直接引用 TS 領域層，無需建置步驟。
 */
export function parseTuition(detail) {
  if (!detail) {
    return { days: null, daysRaw: '無學費項', className: null, isHomework: false, sessions: null, tierStatus: 'none' };
  }
  const [head, tail] = detail.split(' - ');
  const className = (head || '').trim();
  const sessionMatch = (tail || '').match(/(\d+)\s*堂課/);
  const sessions = sessionMatch ? parseInt(sessionMatch[1], 10) : null;

  // 寫功課依規則不列入折扣計算，且固定 5 天（02 §8 R13／R14、§9.4 Q7-A）
  if (className.includes('寫功課')) {
    return { days: 5, daysRaw: '寫功課(5天)', className, isHomework: true, sessions, tierStatus: 'homework' };
  }

  const parsed = parseSingleClassToken(className);
  const tierStatus = parsed.tierParseStatus;
  const days = parsed.erpBillingTier;

  let daysRaw;
  if (days === null) {
    // 產品端刻意不給值（未知修飾 / 不適用）。此處不得代為猜 5。
    daysRaw = tierStatus === 'unavailable' ? `無法解析級距(${parsed.erpBillingTierRaw ?? '未知修飾'})` : '無級距值';
  } else if (tierStatus === 'defaulted') {
    daysRaw = '5'; // 無後綴，產品端 defaulted 為 5
  } else {
    daysRaw = String(days);
  }

  return { days, daysRaw, className, isHomework: false, sessions, tierStatus };
}

export function parseDiscounts(details) {
  let rateBps = 10000;
  let rateDetail = null;
  const extraDiscounts = [];
  for (const d of details) {
    const hit = RATE_PATTERNS.find(([re]) => re.test(d));
    if (hit) {
      rateBps = hit[1];
      rateDetail = d;
    } else {
      extraDiscounts.push(d);
    }
  }
  // 見到「課程費」字樣卻無任何白名單命中 → 報表出現新格式，不可當成無折扣（review F-NEW-4）。
  // 判定放在迴圈之後，讓結果與明細順序無關：
  // 「未知格式 + 已解析格式」並存時，只要有任何一筆認不出，就維持 unknown。
  const unparsedCourseFee = details.filter(
    (d) => /課程費/.test(d) && !RATE_PATTERNS.some(([re]) => re.test(d)),
  );
  const rateParseStatus = rateDetail === null
    ? (details.some((d) => /課程費/.test(d)) ? 'unknown' : 'none')
    : (unparsedCourseFee.length > 0 ? 'unknown' : 'parsed');
  return { rateBps, rateDetail, rateParseStatus, unparsedCourseFee, extraDiscounts };
}

function readReport(worksheet) {
  const students = new Map();
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = row.getCell(1).text?.trim();
    if (!name) return;
    const entry = students.get(name) || {
      name, tuition: null, discounts: [], other: [], otherDiscounts: [],
      billNo: null, billDate: null, billStatus: null,
    };
    const detail = row.getCell(4).text?.trim();
    const subject = row.getCell(7).text?.trim();
    entry.billNo ??= row.getCell(2).text?.trim();
    entry.billDate ??= row.getCell(3).text?.trim();
    entry.billStatus ??= row.getCell(8).text?.trim();
    if (subject === '學費') entry.tuition = detail;
    else if (subject === '折扣') {
      entry.discounts.push(detail);
      // 折扣科目內，未被「課程費 NN折」認列者（如普測優惠、訂金）為額外獨立折扣項
      if (detail && !RATE_PATTERNS.some(([re]) => re.test(detail))) entry.otherDiscounts.push(detail);
    } else entry.other.push(detail);
    students.set(name, entry);
  });
  return students;
}

// ---------------------------------------------------------------- Web API

async function fetchRunStudents(base) {
  const infoRes = await fetch(`${base}/api/v1/runs/current`);
  const info = await infoRes.json();
  const runId = info.activeRunId || info.run?.id;
  if (!runId) throw new Error('找不到 active run，請先在網頁建立匯出並執行計算。');

  const students = [];
  let cursor = null;
  while (true) {
    let url = `${base}/api/v1/runs/${runId}/students?limit=200`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`查詢學生失敗 (${res.status}): ${JSON.stringify(await res.json())}`);
    const data = await res.json();
    students.push(...data.items);
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return { runId, students };
}

/**
 * 配對鍵：去掉括號英文名後的中文姓名。
 * 兩邊都必須過同一個正規化，否則索引端去括號、查詢端用原文會整批配對失敗，
 * 且失敗會被誤標成「名單已無此人」（review F1）。
 */
export function normalizeName(name) {
  // 同時接受半形與全形括號：名單由本工具產生（半形），報表來自外部系統，可能為全形
  return String(name ?? '').replace(/\s*[（(][^）)]*[）)]\s*/g, '').trim();
}

/** 以正規化後的中文姓名建立索引；回報重名以免誤配。 */
function indexByName(students) {
  const map = new Map();
  const duplicates = [];
  for (const s of students) {
    const key = normalizeName(s.name);
    if (map.has(key)) {
      // 同名多人：以 set 覆蓋會靜默配對到最後一人（review F-NEW-3）。改記為歧義，
      // 查詢時不可 unique 配對，必須要求人工以人員代碼核對。
      duplicates.push(key);
      map.set(key, null); // null = 該中文姓名對應多人，無法唯一配對
      continue;
    }
    map.set(key, s);
  }
  return { map, duplicates };
}

// ---------------------------------------------------------------- 差異原因推導

/**
 * 由資料推導可能成因，不預設哪一邊正確。
 * 每條成因都附帶佐證欄位，避免變成臆測。
 */
function buildNotes({ statusCategory, excel, web, careCategory }) {
  const notes = [];
  const tags = (web.rawTags || '').split('\n').map(t => t.trim()).filter(Boolean);
  const tokens = web.tokens ?? [];
  const homeworkToken = tokens.find(t => t.includes('寫功課'));
  const careTokens = tokens.filter(t => t.includes('國小輔導'));
  const otherTokens = tokens.filter(t => !t.includes('國小輔導') && !t.includes('寫功課') && !t.includes('交通車'));
  // 離班標記取自 API 已解析欄位（見 compare() 的 withdrawals），不在此重複偵測
  const withdrawal = (web.withdrawals ?? []).find(w => w.token.includes('國小輔導')) ?? (web.withdrawals ?? [])[0];
  const mismatches = (web.tierComparisons || []).filter(c => c.status === 'mismatch');
  const dupIssues = (web.issues || []).filter(i => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT');

  if (statusCategory === 'MATCH') {
    const extras = [...excel.extraDiscounts, ...excel.otherItems];
    return {
      tone: 'match',
      notes: [
        `報表 ${excel.daysLabel} 天／${bpsToLabel(excel.rateBps)} 與網頁一致。`,
        ...(extras.length ? [`報表另有其他項目（不影響課程費比對）：${extras.join('、')}。`] : []),
      ],
    };
  }

  // 報表級距無法解析：成因是報表格式，不是名單或課表變動（review F-NEW-1）
  if (statusCategory === 'TIER_UNPARSED') {
    return {
      tone: 'warn',
      notes: [
        `報表有學費明細「${excel.className}」，但其中級距修飾不是產品認得的格式（${excel.daysRaw}），故無法取得天數。`,
        `此為報表格式問題，非名單或課表變動；請人工確認該班別應為幾天。`,
        `網頁端 ${careCategory} 天數為 ${web.daysLabel}。`,
      ],
      tags, homework: false, withdrawal: false, dupIssues, mismatches,
    };
  }
  // 報表折扣格式無法解析：不可宣稱一致（review F-NEW-4）
  if (statusCategory === 'RATE_UNPARSED') {
    return {
      tone: 'warn',
      notes: [
        `報表折扣明細含產品端不認得的「課程費」格式（${excel.extraDiscounts.join('、')}）。`,
        `天數一致（${excel.daysLabel}），但折扣率無法確定，不可視為完全一致；請人工確認。`,
      ],
      tags, homework: !!homeworkToken, withdrawal: !!withdrawal, dupIssues, mismatches,
    };
  }
  if (statusCategory === 'UNPAIRABLE') {
    // 不可斷言成因：可能是報表與名單同名多人、或姓名寫法差異。交人工以人員代碼核對（review F1）
    return {
      tone: 'warn',
      notes: [
        `報表有此學生帳單，但無法與名單唯一配對（${web.asOfDate} 名單可能有同名或姓名寫法差異）。`,
        '請改以人員代碼核對，不要直接判定為離班。',
      ],
      tags, homework: false, withdrawal: false, dupIssues, mismatches,
    };
  }
  if (statusCategory === 'NOT_IN_WEB') {
    const items = [...excel.extraDiscounts, ...excel.otherItems];
    return {
      tone: 'neutral',
      notes: [
        `報表有帳單，但 ${web.asOfDate} 名單已無此學生（期中離班或退費）。`,
        ...(items.length ? [`帳單項目：${items.join('、')}。`] : []),
      ],
    };
  }
  if (statusCategory === 'EXCEL_NO_TUITION') {
    const items = [...excel.extraDiscounts, ...excel.otherItems];
    return {
      tone: 'neutral',
      notes: [
        `報表無正式學費項${items.length ? `，僅有：${items.join('、')}` : ''}；網頁端 ${careCategory} 天數為 ${web.daysLabel}。`,
      ],
    };
  }

  // 天數差異：先找資料裡可佐證的成因
  if (statusCategory === 'DAY_DIFF' || statusCategory === 'BOTH_DIFF') {
    // 報表級距解析不出來時不可歸因於班級異動：真正成因是報表格式，不是名單變了（review F2）
    // （原此處另比 unknown／ambiguous 兩個自創值，delegation 後已不可能出現，屬殘留死碼，已移除）
    // 報表開單班名 vs 名單現況班名：不同即為帳務期間內的班級／級距異動
    if (excel.className && careTokens.length) {
      const stillListed = careTokens.some(t => excel.className.includes(t.replace(/\s*\(.*?\)\s*$/, '')));
      if (!stillListed) {
        notes.push(`帳務期間內班級／級距異動：報表開單「${excel.className}」，${web.asOfDate} 名單為 ${careTokens.join('、')}。`);
      }
    }
    if (dupIssues.length > 0) {
      notes.push(`名單重複報名同類別班級（${dupIssues.map(i => i.category).join('、')}），取班規則可能與發單當時不同。`);
    }
    if (careTokens.length > 1) {
      notes.push(`同時報名多個國小輔導班（${careTokens.join('、')}），級距不一致。`);
    }
    if (withdrawal) {
      notes.push(`含離班標記班級：${withdrawal.token}（${withdrawal.date} 離班），帳務期間內可能已換班。`);
    }
    if (mismatches.length > 0) {
      for (const m of mismatches) {
        notes.push(`ERP 登記級距 ${m.erpDeclaredTier} 天與計算值 ${m.computedTier} 天不一致（${m.rawToken}）。`);
      }
      if (otherTokens.length > 0) {
        notes.push(`另有他科（${otherTokens.join('、')}），計算值已扣除衝堂重疊天數；ERP 登記級距未反映此扣天。`);
      }
    }
    notes.push(`報表 ${excel.daysLabel} vs 網頁 ${web.daysLabel}。`);
  }

  // 折扣差異
  if (statusCategory === 'DISCOUNT_DIFF' || statusCategory === 'BOTH_DIFF') {
    // 報表折扣格式認不出來時，不可把差異歸因於標籤：真正成因是報表格式（review F3）
    if (excel.rateParseStatus === 'unknown') {
      notes.push(`報表折扣明細含無法解析的「課程費」格式（${excel.extraDiscounts.join('、')}），此差異源自報表格式變更，非標籤差異；請人工確認。`);
      notes.push(`報表目前讀為 ${bpsToLabel(excel.rateBps)} vs 網頁 ${bpsToLabel(web.rateBps)}。`);
      return { tone: 'warn', notes, tags, homework: !!homeworkToken, withdrawal: !!withdrawal, dupIssues, mismatches };
    }
    if (careTokens.length === 0) {
      notes.push(`${web.asOfDate} 名單已無國小輔導班級，網頁端無適用折扣率可比對。`);
    }
    if (homeworkToken) {
      notes.push(`報名寫功課班（${homeworkToken}）：寫功課依規則不列入折扣計算，故網頁顯示無折扣。`);
    }
    const specialTag = tags.find(t => t.includes('特殊折扣'));
    const siblingTag = tags.find(t => t.includes('兄弟姊妹'));
    const staffTag = tags.find(t => t.includes('員工家'));
    if (specialTag) notes.push(`具「${specialTag}」標籤。`);
    if (siblingTag) notes.push(`具「${siblingTag}」標籤。`);
    if (staffTag) notes.push(`具「${staffTag}」標籤（與特殊折扣相互獨立，員工家屬未規範折扣率）。`);
    if (excel.extraDiscounts.length > 0) {
      notes.push(`報表另有非課程費折扣項：${excel.extraDiscounts.join('、')}。`);
    }
    notes.push(`報表 ${bpsToLabel(excel.rateBps)} vs 網頁 ${bpsToLabel(web.rateBps)}（基本折扣 ${bpsToLabel(web.baseDiscountBps)}／科數 ${web.subjectCount ?? '-'}）。`);
  }

  if (!notes.length) {
    notes.push(`報表 ${excel.daysLabel} 天／${bpsToLabel(excel.rateBps)} vs 網頁 ${web.daysLabel}／${bpsToLabel(web.rateBps)}，差異可能來自名單或課表異動。`);
  }

  return {
    tone: 'warn',
    notes,
    tags,
    homework: !!homeworkToken,
    withdrawal: !!withdrawal,
    dupIssues,
    mismatches,
  };
}

// ---------------------------------------------------------------- 比對主流程

export function compare(reportStudents, webStudents, asOfDate) {
  const { map: webByName, duplicates } = indexByName(webStudents);
  const records = [];

  for (const entry of reportStudents.values()) {
    const tuition = parseTuition(entry.tuition);
    const discount = parseDiscounts(entry.discounts);
    const excel = {
      days: tuition.days,
      daysLabel: tuition.daysRaw,
      className: tuition.className,
      sessions: tuition.sessions,
      rateBps: discount.rateBps,
      rateDetail: discount.rateDetail,
      tierStatus: tuition.tierStatus,
      rateParseStatus: discount.rateParseStatus,
      // 折扣科目內非「課程費 NN折」的獨立優惠項（普測優惠、訂金等）
      extraDiscounts: entry.otherDiscounts,
      // 雜費、車資、學費退費等其他會計科目項目，與課程費折扣無關
      otherItems: entry.other,
      billNo: entry.billNo,
      billDate: entry.billDate,
      billStatus: entry.billStatus,
    };

    // 查詢端必須與索引端使用同一個正規化，否則含括號英文名的學生會整批配對失敗（review F1）
    const lookupKey = normalizeName(entry.name);
    const matched = webByName.get(lookupKey);
    // undefined = 名單無此姓名（離班／退費）；null = 名單有此姓名但對應多人（review F-NEW-3）
    const ambiguous = matched === null;
    const w = matched ?? null;

    if (!w) {
      const category = ambiguous ? 'UNPAIRABLE' : 'NOT_IN_WEB';
      records.push({
        name: entry.name,
        personCode: ambiguous ? '（同名多人）' : '-',
        grade: '-',
        careCategory: '國小輔導',
        statusCategory: category,
        statusLabel: ambiguous ? '姓名無法唯一配對' : '名單已無此人',
        excel,
        web: null,
        asOfDate,
        note: buildNotes({ statusCategory: category, excel, web: { asOfDate }, careCategory: '國小輔導' }),
      });
      continue;
    }

    const grade = w.grade;
    const isAnqin = grade !== null && grade <= 2;
    const isTutoring = grade !== null && grade >= 3;
    const careCategory = isAnqin ? '安親 (低年級)' : (isTutoring ? '課輔 (中高年級)' : '其他');

    const days = isAnqin ? w.anqinDays : (isTutoring ? w.tutoringDays : null);
    const daysLabel = (isAnqin ? w.anqinDisplay : (isTutoring ? w.tutoringDisplay : null)) ?? '無適用值';
    const rateBps = isAnqin ? w.applicableAnqinBps : (isTutoring ? w.applicableTutoringBps : null);
    const care = isAnqin ? w.trace?.careDays?.anqin : (isTutoring ? w.trace?.careDays?.tutoring : null);

    const web = {
      days,
      daysLabel,
      rateBps,
      asOfDate,
      baseDiscountBps: w.baseDiscountBps,
      subjectCount: w.subjectCount,
      isEnrolled: care?.isEnrolled ?? false,
      status: care?.status ?? 'unknown',
      hasExtraFlag: care?.hasExtraFlag ?? false,
      declaredTier: (w.enrollments.find(e => e.baseName?.includes('國小輔導')) || {}).erpBillingTier ?? null,
      tokens: w.enrollments.map(e => e.rawToken),
      // 離班標記直接取 API 已解析好的欄位，不在本檔用 regex 重新偵測
      // （review F-minor-2：自訂 regex 與產品錨定行尾的寫法分歧，且屬重複實作）
      withdrawals: w.enrollments.filter(e => e.withdrawalDate).map(e => ({ token: e.rawToken, date: e.withdrawalDate })),
      tierComparisons: w.tierComparisons || [],
      issues: w.issues || [],
      rawTags: w.trace?.rawTags || '',
    };

    let statusCategory = 'MATCH';
    let statusLabel = '完全一致';
    // 分界依據是「報表有沒有學費明細列」，不是枚舉 tierStatus。
    // 報表明明有學費列卻讀不到天數時，說它「無學費項」是事實錯誤（review F-NEW-1）。
    const hasTuitionRow = excel.className !== null && excel.className !== undefined;
    if (!hasTuitionRow) {
      statusCategory = 'EXCEL_NO_TUITION';
      statusLabel = '報表無學費項';
    } else if (excel.days === null) {
      statusCategory = 'TIER_UNPARSED';
      statusLabel = '報表級距無法解析';
    } else {
      const dayDiff = excel.days !== days;
      const discDiff = excel.rateBps !== rateBps;
      if (dayDiff && discDiff) { statusCategory = 'BOTH_DIFF'; statusLabel = '天數與折扣皆差異'; }
      else if (dayDiff) { statusCategory = 'DAY_DIFF'; statusLabel = '天數差異'; }
      else if (discDiff) { statusCategory = 'DISCOUNT_DIFF'; statusLabel = '折扣差異'; }
      else if (excel.rateParseStatus === 'unknown') {
        // 數字雖一致，但報表折扣格式認不出來，不可宣稱「完全一致」（review F-NEW-4）
        statusCategory = 'RATE_UNPARSED';
        statusLabel = '報表折扣無法解析';
      }
    }

    records.push({
      name: entry.name,
      personCode: w.personCode,
      grade: w.gradeRaw ?? grade,
      careCategory,
      statusCategory,
      statusLabel,
      excel,
      web,
      asOfDate,
      note: buildNotes({ statusCategory, excel, web, careCategory }),
    });
  }

  // 差異在前，其餘依姓名排序
  records.sort((a, b) => {
    const aDiff = a.statusCategory !== 'MATCH';
    const bDiff = b.statusCategory !== 'MATCH';
    if (aDiff !== bDiff) return aDiff ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hant');
  });

  return { records, duplicates };
}

// ---------------------------------------------------------------- HTML

/**
 * 「需人工判讀、非兩邊直接比大小」的類別。
 * 這一組必須在所有 UI 介面一致處理（badge、統計卡、歸納群組、分頁、JS 過濾），
 * 否則新增類別時只改到一處，就會出現 undefined badge、漏計統計、點不掉的分頁
 * （review F-NEW-3）。單一真相來源，任何地方要判斷都用這裡，不要各自列一次。
 */
const NEEDS_HUMAN_CATEGORIES = [
  'NOT_IN_WEB',
  'EXCEL_NO_TUITION',
  'UNPAIRABLE',
  'TIER_UNPARSED',
  'RATE_UNPARSED',
];

/* Badge 對應系統既有意象：綠=一致、藍=級距（天數）、琥珀=折扣需確認、紅=兩者皆差、灰=名單無資料 */
const BADGE_BY_CATEGORY = {
  MATCH: 'badge-ok',
  DAY_DIFF: 'badge-tier',
  DISCOUNT_DIFF: 'badge-warn',
  BOTH_DIFF: 'badge-withdrawal',
  NOT_IN_WEB: 'badge-class',
  EXCEL_NO_TUITION: 'badge-class',
  UNPAIRABLE: 'badge-withdrawal',
  TIER_UNPARSED: 'badge-warn',
  RATE_UNPARSED: 'badge-warn',
};

/** 給 JS 端使用的分類清單，避免 HTML 與腳本各寫一份而不同步。 */
const CATEGORY_JS = JSON.stringify({
  needsHuman: NEEDS_HUMAN_CATEGORIES,
  all: Object.keys(BADGE_BY_CATEGORY),
});

export const NEEDS_HUMAN = NEEDS_HUMAN_CATEGORIES;
export const BADGES = BADGE_BY_CATEGORY;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderRow(r, idx) {
  const isDiff = r.statusCategory !== 'MATCH';
  const badge = BADGE_BY_CATEGORY[r.statusCategory];
  const dayDiff = r.web && r.excel.days !== r.web.days && r.excel.days !== null;
  const discDiff = r.web && r.excel.rateBps !== r.web.rateBps;
  const cell = (value, differs) => `<span class="${differs ? 'diff-box' : 'match-box'}">${escapeHtml(value)}</span>`;

  const notes = r.note.notes.map(n => escapeHtml(n)).join('<br>');
  const classes = r.web && r.web.tokens.length
    ? r.web.tokens.map(t => `<div class="class-tag">${escapeHtml(t)}</div>`).join('')
    : '<span class="muted">無報名</span>';

  return `
  <tr class="${isDiff ? 'row-diff' : ''}" data-cat="${r.statusCategory}">
    <td class="number">${idx + 1}</td>
    <td class="sticky-name">${escapeHtml(r.name)}</td>
    <td class="mono">${escapeHtml(r.personCode)}</td>
    <td>${escapeHtml(r.grade)}</td>
    <td>${escapeHtml(r.careCategory)}</td>
    <td><span class="badge ${badge}">${escapeHtml(r.statusLabel)}</span></td>
    <td class="number">${cell(r.excel.daysLabel, dayDiff)}</td>
    <td class="number">${cell(r.web ? r.web.daysLabel : '-', dayDiff)}</td>
    <td>${cell(bpsToLabel(r.excel.rateBps), discDiff)}</td>
    <td>${cell(r.web ? bpsToLabel(r.web.rateBps) : '-', discDiff)}</td>
    <td>
      <div>${escapeHtml(r.excel.className ?? '-')}</div>
      <div class="class-tag">${escapeHtml(r.excel.billDate)} (${escapeHtml(r.excel.billStatus)})</div>
      ${r.excel.extraDiscounts.map(d => `<div class="class-tag">折扣：${escapeHtml(d)}</div>`).join('')}
      ${r.excel.otherItems.map(d => `<div class="class-tag">其他：${escapeHtml(d)}</div>`).join('')}
    </td>
    <td>${classes}</td>
    <td class="note-text ${r.note.tone === 'warn' ? 'is-warn' : ''}">${notes}</td>
  </tr>`;
}

function renderInsightGroups(records) {
  const groups = [
    {
      key: 'mismatch',
      title: 'ERP 登記級距與計算值不一致（天數差異的最可能來源）',
      filter: (r) => r.note.mismatches?.length > 0,
      hint: '系統依課表扣除衝堂重疊天數，ERP 登記級距與報表開立未反映此扣天。請確認米豆奶登記級距是否需更正，或課表時段是否有誤。',
    },
    {
      key: 'duplicate',
      title: '名單重複報名同類別班級',
      filter: (r) => r.note.dupIssues?.length > 0,
      hint: '同一學生同時存在多個同類別班級（常見於換班未清舊班）。依 D17 原則不由公式自動修正，實際開單交由人工判斷。',
    },
    {
      key: 'withdrawal',
      title: '含離班標記班級',
      filter: (r) => r.note.withdrawal,
      hint: '帳務期間內可能已換班或離班，報表與名單時間差造成差異。',
    },
    {
      key: 'homework',
      title: '寫功課折扣認定差異',
      filter: (r) => r.note.homework,
      hint: '寫功課依規則不列入折扣計算；若報表另給折扣，需確認依據為何種標籤或人工核准。',
    },
    {
      key: 'unparsed',
      title: '報表格式無法解析（不影響名單，需人工確認報表）',
      filter: (r) => r.statusCategory === 'TIER_UNPARSED' || r.statusCategory === 'RATE_UNPARSED',
      hint: '報表的級距或折扣寫法不在產品已認得的格式內，工具刻意不代為猜測。請人工確認報表格式，或確認是否新增了收費級距。',
    },
    {
      key: 'unpairable',
      title: '姓名無法唯一配對',
      filter: (r) => r.statusCategory === 'UNPAIRABLE',
      hint: '名單中有多位同名學生，工具不猜測對應到哪一位。請改以人員代碼核對。',
    },
    {
      key: 'notInWeb',
      title: '報表有名單已無／無學費項',
      filter: (r) => r.statusCategory === 'NOT_IN_WEB' || r.statusCategory === 'EXCEL_NO_TUITION',
      hint: '期中離班、退費，或當期僅收雜費而無正式學費項。',
    },
  ];

  return groups
    .map((g) => {
      const hits = records.filter(g.filter);
      if (!hits.length) return '';
      const list = hits
        .map(r => `<li><strong>${escapeHtml(r.name)}</strong>（${escapeHtml(r.personCode)}）：${escapeHtml(r.note.notes.join('；'))}</li>`)
        .join('');
      // 需人工判讀者用琥珀（alert-warning），單純資訊用中性（alert-neutral）
      const variant = g.key === 'notInWeb' ? 'alert-neutral' : 'alert-warning';
      return `<div class="alert ${variant}">
  <strong>${escapeHtml(g.title)}（${hits.length} 筆）</strong>
  <ul>${list}</ul>
  <p class="hint">${escapeHtml(g.hint)}</p>
</div>`;
    })
    .join('');
}

function renderHtml(records, meta) {
  const total = records.length;
  const count = (cat) => records.filter(r => r.statusCategory === cat).length;
  const matchCount = count('MATCH');
  const dayCount = count('DAY_DIFF');
  const discCount = count('DISCOUNT_DIFF');
  const bothCount = count('BOTH_DIFF');
  const notInWebCount = count('NOT_IN_WEB');
  const noTuitionCount = count('EXCEL_NO_TUITION');
  const unpairableCount = count('UNPAIRABLE');
  const tierUnparsedCount = count('TIER_UNPARSED');
  const rateUnparsedCount = count('RATE_UNPARSED');
  // 需人工判讀的總數（非直接比大小者），單獨一張卡，避免散在多張卡而看不出全貌
  const needsHumanCount = records.filter(r => NEEDS_HUMAN_CATEGORIES.includes(r.statusCategory)).length;
  const diffCount = total - matchCount;
  const rate = total ? ((matchCount / total) * 100).toFixed(1) : '0.0';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>國小輔導收費核對與財務報表比對報告</title>
<style>
/* Token 與元件版型取自 web/src/app/globals.css，維持與系統一致的視覺語言。
   報告為單檔離線輸出，故在此沿用同一組變數與 class，不改動系統樣式。 */
  :root {
    --bg-primary: #f8fafc;
    --bg-card: #ffffff;
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #64748b;
    --border-color: #e2e8f0;
    --primary-color: #2563eb;
    --primary-hover: #1d4ed8;
    --badge-bg: #eff6ff;
    --badge-text: #1d4ed8;
    --code-bg: #f1f5f9;
    --success-bg: #ecfdf5;
    --success-text: #065f46;
    --warning-bg: #fffbeb;
    --warning-text: #92400e;
    --danger-bg: #fef2f2;
    --danger-text: #991b1b;
    --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background-color: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-family);
    line-height: 1.5;
    min-height: 100vh;
    /* 報告固定淺色，不隨系統深色模式翻轉（與系統一致） */
    color-scheme: light;
  }

  .main {
    padding: 24px;
    max-width: 1800px;
    margin: 0 auto;
    width: 100%;
  }

  /* Header：沿用 .header + .logo-badge */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 20px;
  }

  .header-title { display: flex; align-items: center; gap: 12px; }
  .header-title h1 { font-size: 1.25rem; font-weight: 700; }

  .logo-badge {
    background-color: var(--badge-bg);
    color: var(--badge-text);
    font-size: 0.75rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 9999px;
    border: 1px solid #bfdbfe;
  }

  .report-desc {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 16px;
    max-width: 900px;
  }

  /* Meta panel：沿用 .meta-panel / .meta-item */
  .meta-panel {
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
    font-size: 0.8125rem;
    display: flex;
    flex-wrap: wrap;
    gap: 16px 32px;
  }

  .meta-item { display: flex; flex-direction: column; }

  .meta-item-label {
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 2px;
  }

  .meta-item-val {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: var(--text-primary);
    font-weight: 600;
  }

  /* Stats：沿用 .stats-grid / .stat-card */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.04);
  }

  .stat-label {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 4px;
  }

  .stat-value { font-size: 1.75rem; font-weight: 700; color: var(--text-primary); }

  .stat-value.is-match { color: var(--success-text); }
  .stat-value.is-diff { color: var(--warning-text); }
  .stat-value.is-neutral { color: var(--text-muted); }

  .stat-sub { font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; }

  /* 差異歸納：沿用 .alert 語意（琥珀=需確認、灰=資訊） */
  .insight-group { margin-bottom: 8px; }
  .insight-group h2 { font-size: 1rem; font-weight: 600; margin-bottom: 10px; }

  .alert {
    padding: 12px 16px;
    border-radius: 6px;
    font-size: 0.875rem;
    margin-bottom: 12px;
  }

  .alert-warning {
    background-color: var(--warning-bg);
    color: var(--warning-text);
    border: 1px solid #fde68a;
  }

  .alert-neutral {
    background-color: var(--bg-card);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
  }

  .alert ul { margin: 8px 0 0; padding-left: 20px; }
  .alert li { margin-bottom: 4px; }
  .alert .hint { color: var(--text-muted); font-size: 0.75rem; margin-top: 8px; }

  /* Tabs：沿用系統底線式（非藥丸式） */
  .tabs {
    display: flex;
    gap: 20px;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .tabs button {
    padding: 10px 4px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text-muted);
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s ease;
  }

  .tabs button:hover { color: var(--text-primary); }

  .tabs button.selected {
    color: var(--primary-color);
    border-bottom: 2px solid var(--primary-color);
  }

  .filterbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin-bottom: 16px;
  }

  input.search {
    min-height: 32px;
    padding: 7px 10px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    font-size: 0.8125rem;
    width: 260px;
    outline: none;
    background-color: var(--bg-card);
    color: var(--text-primary);
  }

  input.search:focus { border-color: var(--primary-color); }

  .scope-hint { margin-left: auto; font-size: 12px; color: var(--text-muted); }

  /* Table：沿用 .table-container + .data-table（含黏性表頭與姓名欄） */
  .table-container {
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
  }

  .table-scroll { overflow: auto; max-height: 70vh; }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    font-size: 0.8125rem;
    min-width: 1560px;
  }

  .data-table th {
    background-color: #f8fafc;
    color: var(--text-muted);
    font-weight: 600;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .data-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-primary);
    vertical-align: top;
  }

  .data-table tbody tr:hover { background-color: #f8fafc; }
  .data-table tbody tr.row-diff td { background-color: var(--warning-bg); }
  .data-table tbody tr.row-diff:hover td { background-color: #fef9c3; }

  .data-table .number { text-align: right; font-variant-numeric: tabular-nums; }

  .data-table .sticky-name {
    position: sticky;
    left: 0;
    z-index: 1;
    background: #fff;
    min-width: 96px;
  }

  /* 凍結欄的表頭交會格：z-index 抬高到 sticky 姓名欄之上，並沿用表頭底色
     （.sticky-name 的 #fff 特異度高於 th 的 #f8fafc，此處補回以免單獨發白） */
  .data-table th.sticky-name {
    z-index: 3;
    background-color: #f8fafc;
  }

  .data-table tbody tr:hover .sticky-name { background: #fafcff; }
  .data-table tbody tr.row-diff .sticky-name { background-color: var(--warning-bg); }

  /* Badges：沿用系統既有配色語意（綠=ok、藍=tier、琥珀=warn、紅=withdrawal、灰=class） */
  .badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }

  .badge-ok { background-color: var(--success-bg); color: var(--success-text); }
  .badge-tier { background-color: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
  .badge-warn { background-color: var(--warning-bg); color: var(--warning-text); }
  .badge-withdrawal { background-color: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .badge-class { background-color: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }

  .diff-box {
    background-color: var(--danger-bg);
    color: var(--danger-text);
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 700;
    display: inline-block;
  }

  .match-box { color: var(--success-text); font-weight: 600; }

  .class-tag {
    font-size: 11px;
    background-color: var(--code-bg);
    color: var(--text-secondary);
    padding: 1px 6px;
    border-radius: 4px;
    display: inline-block;
    margin: 1px 2px 1px 0;
  }

  .note-text {
    font-size: 0.75rem;
    color: var(--text-secondary);
    min-width: 260px;
    line-height: 1.5;
  }

  .note-text.is-warn { color: var(--warning-text); }
  .muted { color: var(--text-muted); }

  @media (max-width: 800px) {
    .main { padding: 16px; }
  }
</style>
</head>
<body>
<main class="main">
  <header class="header">
    <div class="header-title">
      <h1>國小輔導收費核對與財務報表比對報告</h1>
      <span class="logo-badge">帳務實質比對</span>
    </div>
  </header>

  <p class="report-desc">
    以每一學生為單位，比對「國小輔導」（含安親、課輔、寫功課）之每週收費天數與適用折扣。
    比對目的為找出差異並標示可能成因，不預設任一資料來源為正確。
  </p>

  <div class="meta-panel">
    <div class="meta-item">
      <span class="meta-item-label">網頁系統名單</span>
      <span class="meta-item-val">${escapeHtml(meta.asOfDate)} 米豆奶匯出</span>
    </div>
    <div class="meta-item">
      <span class="meta-item-label">Run</span>
      <span class="meta-item-val">${escapeHtml(meta.runId)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-item-label">帳務來源</span>
      <span class="meta-item-val">${escapeHtml(path.basename(meta.xlsxPath))}</span>
    </div>
    <div class="meta-item">
      <span class="meta-item-label">規則策略</span>
      <span class="meta-item-val">${escapeHtml(meta.ruleSetVersion)} / ${escapeHtml(meta.numericPolicy)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-item-label">報表工作表</span>
      <span class="meta-item-val">${escapeHtml(SHEET_NAME)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-item-label">核定發單日</span>
      <span class="meta-item-val">${escapeHtml(meta.billAnchorDate)}</span>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <span class="stat-label">報表學生總數</span>
      <span class="stat-value">${total}</span>
      <span class="stat-sub">有輔導帳單或相關項目</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">天數與折扣一致</span>
      <span class="stat-value is-match">${matchCount}</span>
      <span class="stat-sub">${rate}%</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">差異筆數</span>
      <span class="stat-value is-diff">${diffCount}</span>
      <span class="stat-sub">含離班／無學費項</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">天數差異</span>
      <span class="stat-value">${dayCount}</span>
      <span class="stat-sub">級距或衝堂扣天</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">折扣差異</span>
      <span class="stat-value is-diff">${discCount}</span>
      <span class="stat-sub">標籤或人工特例</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">需人工判讀</span>
      <span class="stat-value is-neutral">${needsHumanCount}</span>
      <span class="stat-sub">離班 ${notInWebCount}・無學費 ${noTuitionCount}・同名 ${unpairableCount}・格式 ${tierUnparsedCount + rateUnparsedCount}</span>
    </div>
  </div>

  <section class="insight-group">
    <h2>差異成因歸納（由資料推導）</h2>
    ${renderInsightGroups(records) || '<p class="hint">無差異項目。</p>'}
    ${
      bothCount > 0
        ? `<div class="alert alert-warning"><strong>天數與折扣同時差異（${bothCount} 筆）</strong>：需同時確認班級異動與標籤異動。</div>`
        : ''
    }
    ${
      meta.duplicateNames.length
        ? `<div class="alert alert-neutral"><strong>比對警告：名單重名（${meta.duplicateNames.length} 筆）</strong>：${meta.duplicateNames
            .map(escapeHtml)
            .join('、')}，以姓名比對可能誤配，請改以人員代碼核對。</div>`
        : ''
    }
  </section>

  <div class="tabs">
    <button class="selected" onclick="filterTable(this,'all')">全部 (${total})</button>
    <button onclick="filterTable(this,'diff')">僅差異 (${diffCount})</button>
    <button onclick="filterTable(this,'DAY_DIFF')">天數差異 (${dayCount})</button>
    <button onclick="filterTable(this,'DISCOUNT_DIFF')">折扣差異 (${discCount})</button>
    <button onclick="filterTable(this,'MATCH')">完全一致 (${matchCount})</button>
    <button onclick="filterTable(this,'needsHuman')">需人工判讀 (${needsHumanCount})</button>
  </div>

  <div class="filterbar">
    <input type="text" id="q" class="search" placeholder="搜尋姓名／代碼／班級／說明">
    <span class="scope-hint" id="rowHint">顯示 ${total} 筆</span>
  </div>

  <div class="table-container">
    <div class="table-scroll">
      <table id="cmp" class="data-table">
        <thead><tr>
          <th class="number">#</th>
          <th class="sticky-name">姓名</th>
          <th>人員代碼</th>
          <th>年級</th>
          <th>課程類別</th>
          <th>比對結果</th>
          <th>報表天數</th>
          <th>網頁天數</th>
          <th>報表折扣</th>
          <th>網頁折扣</th>
          <th>報表開單項目</th>
          <th>名單報名班級</th>
          <th>差異說明與可能成因</th>
        </tr></thead>
        <tbody>${records.map(renderRow).join('')}</tbody>
      </table>
    </div>
  </div>
</main>
<script>
  // 分類清單由 Node 端注入，與 badge／統計／歸納群組同源，不在此另寫一份
  const CATEGORIES = ${CATEGORY_JS};
  let filter = 'all';
  function filterTable(btn, value) {
    filter = value;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    applyFilters();
  }
  function applyFilters() {
    const q = document.getElementById('q').value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('#cmp tbody tr').forEach(row => {
      const cat = row.dataset.cat;
      const okType = filter === 'all' ? true
        : filter === 'diff' ? cat !== 'MATCH'
        : filter === 'needsHuman' ? CATEGORIES.needsHuman.includes(cat)
        : cat === filter;
      const ok = okType && (!q || row.innerText.toLowerCase().includes(q));
      row.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    document.getElementById('rowHint').textContent = '顯示 ' + shown + ' 筆';
  }
  document.getElementById('q').addEventListener('input', applyFilters);
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.xlsx) {
    console.log('用法：npm run billing:compare -- --xlsx <財務報表.xlsx> [--out <報告.html>] [--base http://127.0.0.1:3000]');
    process.exit(args.help ? 0 : 1);
  }
  if (!fs.existsSync(args.xlsx)) throw new Error(`找不到報表檔：${args.xlsx}`);

  const outputPath = args.out || path.join(
    os.homedir(), 'Downloads',
    `帳務比對_${path.basename(args.xlsx, path.extname(args.xlsx))}.html`,
  );

  // §3：報告含全體學生姓名與人員代碼，屬敏感個資，不得落在專案內（review F4）。
  // 專案根 = web/ 的上一層；同樣擋掉 data/ 與任何 repo 內路徑。
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const resolvedOut = path.resolve(outputPath);
  if (resolvedOut === projectRoot || resolvedOut.startsWith(projectRoot + path.sep)) {
    throw new Error(
      `報告含學生姓名與人員代碼，屬敏感個資（CLAUDE.md §3），不得輸出至專案內。\n` +
      `拒絕路徑：${resolvedOut}\n` +
      `請改用專案外路徑，例如：--out ~/Downloads/report.html`,
    );
  }

  console.log('讀取報表：', args.xlsx);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(args.xlsx);
  const ws = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[0];
  const reportStudents = readReport(ws);

  console.log(`讀取網頁資料：${args.base}`);
  const { runId, students } = await fetchRunStudents(args.base);
  const infoRes = await fetch(`${args.base}/api/v1/runs/${runId}`);
  const run = await infoRes.json();

  const asOfDate = run.asOfDate || '—';
  console.log(`報表學生 ${reportStudents.size} 名、名單學生 ${students.length} 名（run ${runId}, asOf ${asOfDate}）`);

  const { records, duplicates } = compare(reportStudents, students, asOfDate);

  const billDates = [...reportStudents.values()].map(s => s.billDate).filter(Boolean).sort();
  const html = renderHtml(records, {
    runId,
    asOfDate,
    xlsxPath: args.xlsx,
    ruleSetVersion: run.ruleSetVersion || '—',
    numericPolicy: run.numericPolicy || '—',
    billAnchorDate: billDates[Math.floor(billDates.length / 2)] || '—',
    duplicateNames: duplicates,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  const count = (cat) => records.filter(r => r.statusCategory === cat).length;
  console.log('差異統計：', {
    total: records.length,
    match: count('MATCH'),
    day: count('DAY_DIFF'),
    discount: count('DISCOUNT_DIFF'),
    both: count('BOTH_DIFF'),
    notInWeb: count('NOT_IN_WEB'),
    noTuition: count('EXCEL_NO_TUITION'),
    unpairable: count('UNPAIRABLE'),
    tierUnparsed: count('TIER_UNPARSED'),
    rateUnparsed: count('RATE_UNPARSED'),
  });
  console.log('報告已輸出：', outputPath);
}

// 僅在直接執行時才跑；測試以 import 引入純函式時不得觸發比對流程
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('比對失敗：', err.message);
    process.exit(1);
  });
}
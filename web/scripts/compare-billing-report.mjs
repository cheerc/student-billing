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
 * ## 本檔與 scripts/shared/ 的分界
 *
 * 共用層放的是「兩個工具都一樣、且不含國小輔導知識」的東西：報表欄位位置、
 * 姓名正規化、唯讀 API 呼叫、差異分類的宣告與推導、HTML 外殼與樣式。
 *
 * 留在本檔的是 100% 國小輔導的業務判斷：級距如何解讀成天數、寫功課的規則適用、
 * 哪些名單欄位是安親／課輔、差異說明怎麼措辭。
 *
 * 唯一的例外是 `parseTuition`：它雖然被放在共用層之外，但裡面呼叫的是產品端的
 * `parseSingleClassToken`，**不得**在此複寫一份級距解析（review F-NEW-2 曾漏 `[5]`、
 * 把 `[Starter]` 默默當成 5 天）。共用層沒有產品領域層的依賴，因此這個函式
 * 必須留在工具端——這是刻意的邊界，不是遺漏。
 *
 * 設計原則：
 *   - 不在本檔案內寫死任何學生姓名或個資；差異原因一律由資料推導（見 buildNotes）。
 *   - 報表與名單存在時間差，差異不預設任何一邊正確；僅標示可由資料佐證的可能成因。
 *   - 依 CLAUDE.md §4，所有 npm/node 指令需在 web/ 目錄內執行。
 */
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { parseSingleClassToken, projectTierForApplicability } from '../src/domain/students/token-parser.ts';
import { applicableRateForClass } from '../src/application/applicable-rate.ts';

import { parseDiscounts, bpsToLabel, readReport } from './shared/report-xlsx.ts';
import { fetchRunStudents, fetchRun } from './shared/roster-api.ts';
import {
  toApplicableRateContext,
  buildRunSnapshotContext,
  shouldWarnMissingSnapshot,
  classSemanticsForRun,
  runUsesClassCategorySnapshot,
  snapshotRowFor,
} from './shared/rate-context.ts';
import { normalizeName, indexByName } from './shared/name-matching.ts';
import { defineCategories, formatCategorySummary } from './shared/category-registry.ts';
import { renderShell, escapeHtml } from './shared/report-shell.ts';
import { assertProjectRoot, assertOutputOutsideProject } from './shared/project-guard.ts';

const SHEET_NAME = '班級營收狀況';

/** 米豆奶財務報表的科目名稱：學費明細與折扣明細分屬不同科目列。 */
const REPORT_SUBJECTS = { tuition: '學費', discount: '折扣' };

/**
 * 差異分類的**單一真相來源**（CLAUDE.md §9.2）。
 *
 * 過去新增一個分類要同時改六處（needsHuman 清單、badge 對照、statusLabel、
 * 分頁按鈕、歸納群組 filter、主控台統計），漏改任何一處都不會報錯，
 * 只會讓報告的某個介面漏掉該分類——review 中實際發生過。
 *
 * 現在 badge 對照、label、分頁按鈕、需人工判讀清單、頁面腳本的分類清單，
 * 與主控台統計的欄位集合與鍵名，全部由 `defineCategories` 推導。
 *
 * **尚未推導、仍在本檔手寫兩份的**（刻意留到下一個工具）：
 *   - renderHtml 的統計卡：九個 `count('CATEGORY')` 字面值；
 *   - INSIGHT_GROUPS 的 filter：各自直接比 statusCategory。
 * 兩者都仍需新增分類時同步修改，而漏改都不會報錯。本檔的 insightGroup 欄位
 * 目前**只被測試讀取**，尚未接上這兩個介面——它存在的目的只是讓「新增分類時
 * 必須宣告歸納意圖」在型別與測試層先成立，接線留待 PR C。
 *
 * badge 沿用系統既有意象：綠=一致、藍=級距（天數）、琥珀=折扣需確認、
 * 紅=兩者皆差、灰=名單無資料。
 */
const CATEGORIES = defineCategories([
  { id: 'MATCH', label: '完全一致', summaryKey: 'match', badge: 'badge-ok', needsHuman: false, tab: 'MATCH', tabOrder: 30, insightGroup: 'none' },
  { id: 'DAY_DIFF', label: '天數差異', summaryKey: 'day', badge: 'badge-tier', needsHuman: false, tab: 'DAY_DIFF', tabOrder: 10, insightGroup: 'mismatch' },
  { id: 'DISCOUNT_DIFF', label: '折扣差異', summaryKey: 'discount', badge: 'badge-warn', needsHuman: false, tab: 'DISCOUNT_DIFF', tabOrder: 20, insightGroup: 'none' },
  { id: 'BOTH_DIFF', label: '天數與折扣皆差異', summaryKey: 'both', badge: 'badge-withdrawal', needsHuman: false, insightGroup: 'mismatch' },
  { id: 'NOT_IN_WEB', label: '名單已無此人', summaryKey: 'notInWeb', badge: 'badge-class', needsHuman: true, insightGroup: 'notInWeb' },
  { id: 'EXCEL_NO_TUITION', label: '報表無學費項', summaryKey: 'noTuition', badge: 'badge-class', needsHuman: true, insightGroup: 'notInWeb' },
  { id: 'UNPAIRABLE', label: '姓名無法唯一配對', summaryKey: 'unpairable', badge: 'badge-withdrawal', needsHuman: true, insightGroup: 'unpairable' },
  { id: 'TIER_UNPARSED', label: '報表級距無法解析', summaryKey: 'tierUnparsed', badge: 'badge-warn', needsHuman: true, insightGroup: 'unparsed' },
  { id: 'RATE_UNPARSED', label: '報表折扣無法解析', summaryKey: 'rateUnparsed', badge: 'badge-warn', needsHuman: true, insightGroup: 'unparsed' },
  // issue #122：v3 run 沒有該班快照（或該生無法判定適用側）時，適用率是「無法判定」。
  // 不可與 RATE_UNPARSED 共用：後者說的是報表格式認不出來，成因與處置都不同。
  { id: 'WEB_RATE_NOT_CONFIGURED', label: '系統無適用折扣值', summaryKey: 'webRateNotConfigured', badge: 'badge-withdrawal', needsHuman: true, tab: 'WEB_RATE_NOT_CONFIGURED', tabOrder: 16, insightGroup: 'unparsed' },
]);

/** 分類 id → 中文 label。由 defineCategories 推導，不另列一份。 */
const STATUS_LABEL = CATEGORIES.labels;

/** 分類 id → CSS badge class。由 defineCategories 推導，不另列一份。 */
const BADGE_BY_CATEGORY = CATEGORIES.badges;

/** 需人工判讀（非兩邊直接比大小）的分類清單。由 defineCategories 推導。 */
const NEEDS_HUMAN_CATEGORIES = CATEGORIES.needsHuman;

const CATEGORY_JS = CATEGORIES.categoryJs;

/** 保留舊的匯出名稱，供既有測試與日後的工具沿用。 */
export const NEEDS_HUMAN = NEEDS_HUMAN_CATEGORIES;
export const BADGES = BADGE_BY_CATEGORY;

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
/**
 * @param {string | null | undefined} detail
 * @param {{ erpTierApplicability?: 'applicable' | 'not_applicable' | 'unset', summaryDayRoles?: string[] } | undefined} [semantics]
 */
export function parseTuition(detail, semantics = undefined) {
  if (!detail) {
    return { days: null, daysRaw: '無學費項', className: null, isHomework: false, sessions: null, tierStatus: 'none' };
  }
  const [head, tail] = detail.split(' - ');
  const className = (head || '').trim();
  const sessionMatch = (tail || '').match(/(\d+)\s*堂課/);
  const sessions = sessionMatch ? parseInt(sessionMatch[1], 10) : null;

  const lexicalToken = parseSingleClassToken(className);
  const applicability = semantics?.erpTierApplicability ?? 'unset';
  const projected = projectTierForApplicability(lexicalToken, applicability);
  const isHomework = semantics?.summaryDayRoles?.includes('homeworkDays') ?? false;
  // The historical report treated the explicitly identified homework role as five days,
  // independently of ERP tier syntax. Keep that report projection data driven.
  if (isHomework) {
    return {
      days: 5,
      daysRaw: '寫功課(5天)',
      className,
      baseName: lexicalToken.baseName,
      isHomework: true,
      sessions,
      tierStatus: 'homework',
    };
  }

  const tierStatus = projected.tierParseStatus;
  const days = projected.erpBillingTier;

  let daysRaw;
  if (days === null) {
    // 產品端刻意不給值（未知修飾 / 不適用）。此處不得代為猜 5。
    daysRaw = applicability === 'unset'
      ? '級距適用性未設定'
      : applicability === 'not_applicable'
        ? '不適用級距'
        : `無法解析級距(${projected.erpBillingTierRaw ?? '未知修飾'})`;
  } else if (tierStatus === 'defaulted') {
    daysRaw = '5'; // 無後綴，產品端 defaulted 為 5
  } else {
    daysRaw = String(days);
  }

  return { days, daysRaw, className, baseName: lexicalToken.baseName, isHomework: false, sessions, tierStatus };
}

export { parseDiscounts, normalizeName };

// ---------------------------------------------------------------- 差異原因推導

/**
 * 由資料推導可能成因，不預設哪一邊正確。
 * 每條成因都附帶佐證欄位，避免變成臆測。
 */
function buildNotes({ statusCategory, excel, web, careCategory }) {
  const notes = [];
  const tags = (web.rawTags || '').split('\n').map(t => t.trim()).filter(Boolean);
  const homeworkToken = (web.homeworkTokens ?? [])[0];
  const careTokens = web.careTokens ?? [];
  const otherTokens = web.otherTokens ?? [];
  // 離班標記取自 API 已解析欄位（見 compare() 的 withdrawals），不在此重複偵測
  const withdrawal = (web.withdrawals ?? [])[0];
  const mismatches = (web.tierComparisons || []).filter(c => c.status === 'mismatch');
  const dupIssues = (web.issues || []).filter(i => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT');

  /**
   * 所有回傳點一律經此收斂，確保 Note 的欄位集合固定。
   *
   * 過去 MATCH／NOT_IN_WEB／EXCEL_NO_TUITION 只回 {tone, notes}，其餘多五個欄位，
   * 消費者全靠 `?` 與 falsy 判讀才安全。共用層的 `Note` 型別要求各分支形狀一致，
   * 否則會退化成 union，所有消費者都得永遠寫 `?`。
   *
   * **預設值必須是空值，不是衍生資料。** 這三個分支原本不帶 tag 旗標，
   * 判讀結果為 falsy → 不進任何歸納群組。若預設填入 `dupIssues`／`mismatches`
   * 這類真實學生資料，`MATCH` 的學生會被拉進「天數差異的最可能來源」等群組——
   * 分類計數不變（MATCH 仍是 MATCH）但報告內容改變，屬靜默的行為破壞。
   * 因此預設一律為 `[]`／`false`；需要帶資料的分支必須顯式傳入。
   *
   * `tags` 目前的消費者是零：這裡填入是為了維持欄位集合固定（少一個欄位就會
   * 讓 Note 型別退化為 union）。它不影響任何渲染輸出。
   */
  const finish = (partial) => ({
    tone: 'warn',
    notes: [],
    tags,
    homework: false,
    withdrawal: false,
    dupIssues: [],
    mismatches: [],
    ...partial,
  });

  /** 帶真實 insight 旗標的分支用此，明示「這裡確實要餵資料進歸納群組」。 */
  const finishWithInsights = (partial) => finish({ dupIssues, mismatches, ...partial });

  if (statusCategory === 'MATCH') {
    const extras = [...excel.extraDiscounts, ...excel.otherItems];
    return finish({
      tone: 'match',
      notes: [
        `報表 ${excel.daysLabel} 天／${bpsToLabel(excel.rateBps)} 與網頁一致。`,
        ...(extras.length ? [`報表另有其他項目（不影響課程費比對）：${extras.join('、')}。`] : []),
      ],
    });
  }

  // 報表級距無法解析：成因是報表格式，不是名單或課表變動（review F-NEW-1）
  if (statusCategory === 'TIER_UNPARSED') {
    // main 版此分支即帶真實 insight 旗標（review #119 第二輪 Finding 1：修正過頭）。
    // 報表級距解析不出來，恰恰是級距異動最可能的學生，不應被排除於歸納群組之外。
    return finishWithInsights({
      notes: [
        `報表有學費明細「${excel.className}」，但其中級距修飾不是產品認得的格式（${excel.daysRaw}），故無法取得天數。`,
        `此為報表格式問題，非名單或課表變動；請人工確認該班別應為幾天。`,
        `網頁端 ${careCategory} 天數為 ${web.daysLabel}。`,
      ],
    });
  }
  // 報表折扣格式無法解析：不可宣稱一致（review F-NEW-4）
  if (statusCategory === 'WEB_RATE_NOT_CONFIGURED') {
    return finish({
      tone: 'warn',
      notes: [
        '系統這一版 run 沒有這名學生所屬輔導班的類別快照，無法判定本班適用折扣（03 §5.3.4：不以當前班名猜測）。',
        `報表目前讀為 ${bpsToLabel(excel.rateBps)}；請人工確認該班是否應存在於本次名單，再決定如何開單。`,
      ],
    });
  }

  if (statusCategory === 'RATE_UNPARSED') {
    return finishWithInsights({
      notes: [
        `報表折扣明細含產品端不認得的「課程費」格式（${excel.extraDiscounts.join('、')}）。`,
        `天數一致（${excel.daysLabel}），但折扣率無法確定，不可視為完全一致；請人工確認。`,
      ],
      homework: !!homeworkToken, withdrawal: !!withdrawal,
    });
  }
  if (statusCategory === 'UNPAIRABLE') {
    // 不可斷言成因：可能是報表與名單同名多人、或姓名寫法差異。交人工以人員代碼核對（review F1）
    // 帶真實旗標與 main 一致（review #119 第二輪 Finding 1）。目前渲染上無差異——
    // compare() 傳入的 web 為裸字面量、沒有旗標可用——但保持源碼一致，
    // 避免日後有人讓 UNPAIRABLE 帶上真實 web 資料時，行為悄悄與 main 不同。
    return finishWithInsights({
      notes: [
        `報表有此學生帳單，但無法與名單唯一配對（${web.asOfDate} 名單可能有同名或姓名寫法差異）。`,
        '請改以人員代碼核對，不要直接判定為離班。',
      ],
    });
  }
  if (statusCategory === 'NOT_IN_WEB') {
    const items = [...excel.extraDiscounts, ...excel.otherItems];
    return finish({
      tone: 'neutral',
      notes: [
        `報表有帳單，但 ${web.asOfDate} 名單已無此學生（期中離班或退費）。`,
        ...(items.length ? [`帳單項目：${items.join('、')}。`] : []),
      ],
    });
  }
  if (statusCategory === 'EXCEL_NO_TUITION') {
    const items = [...excel.extraDiscounts, ...excel.otherItems];
    return finish({
      tone: 'neutral',
      notes: [
        `報表無正式學費項${items.length ? `，僅有：${items.join('、')}` : ''}；網頁端 ${careCategory} 天數為 ${web.daysLabel}。`,
      ],
    });
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
      return finishWithInsights({ notes, homework: !!homeworkToken, withdrawal: !!withdrawal });
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

  return finishWithInsights({ notes, homework: !!homeworkToken, withdrawal: !!withdrawal });
}

// ---------------------------------------------------------------- 比對主流程

/**
 * 本工具適用的「班名」：名冊報名中的國小輔導班（去修飾後的名冊班名）。
 *
 * 快照的 `base_name` 存的就是名冊班名，故必須取 `enrollments[].baseName`，
 * 不可拿報表上的班名（含 `[團][4]` 等修飾，查不到快照）。
 * 查無輔導班時退回空字串：空字串不會命中任何快照，v3 下即為「無法判定」，
 * 這比挑一個看起來合理的班名安全（03 §5.3.4：嚴禁猜測）。
 */
function categoryForRun(baseName, rateContext) {
  if (!rateContext || rateContext.known === false) return null;
  const categorySnapshot = snapshotRowFor(rateContext, baseName);
  if (Array.isArray(rateContext?.classSemantics)) {
    const semantics = classSemanticsForRun(baseName, rateContext);
    if (!categorySnapshot || !semantics || semantics.category !== categorySnapshot.category) return null;
  }
  return categorySnapshot?.category ?? (baseName.includes('國小輔導') ? 'care' : null);
}

function enrollmentProjection(student, rateContext) {
  return (student.enrollments ?? []).map((enrollment) => {
    const semantic = classSemanticsForRun(enrollment.baseName ?? '', rateContext);
    return {
      ...enrollment,
      semantic,
      category: categoryForRun(enrollment.baseName ?? '', rateContext),
    };
  });
}

/** A valid v4 snapshot must cover every enrollment in the single classCategories snapshot. */
function hasCompleteV4EnrollmentSnapshots(student, rateContext) {
  if (!runUsesClassCategorySnapshot(rateContext?.ruleSetVersion)) return true;
  if (!Array.isArray(student.enrollments)) return false;
  return student.enrollments.every((enrollment) => {
    const baseName = enrollment.baseName ?? '';
    const categorySnapshot = snapshotRowFor(rateContext, baseName);
    if (!categorySnapshot) return false;
    if (Array.isArray(rateContext?.classSemantics)) {
      const semantics = classSemanticsForRun(baseName, rateContext);
      if (!semantics || semantics.category !== categorySnapshot.category) return false;
    }
    return true;
  });
}

function careClassNameOf(enrollments) {
  const configured = enrollments.find((enrollment) => enrollment.category === 'care');
  if (configured) return configured.baseName ?? '';
  const byName = enrollments.find((enrollment) => (enrollment.baseName ?? '').includes('國小輔導'));
  if (byName) return byName.baseName ?? '';
  return '';
}

/** 學生層適用率欄位（`applicableRateForClass` 的輸入）。只挑欄位，不做計算。 */
function RATE_INPUT_FIELDS(s) {
  return {
    applicableAnqinBps: s.applicableAnqinBps,
    applicableTutoringBps: s.applicableTutoringBps,
    applicableMathBps: s.applicableMathBps,
    applicableEnglishBps: s.applicableEnglishBps,
  };
}

/**
 * 比對主流程。
 *
 * @param {(Partial<import('./shared/rate-context.ts').RunSnapshotPayload> & Pick<import('./shared/rate-context.ts').RunSnapshotPayload, 'isV3Run' | 'classCategories'>) | undefined} [rateContext]
 *        所選 Run 的歷史 metadata 與類別／語意快照（形狀依 shared rate context）。
 *        v3/v4 必須提供各自應有的 snapshot；未知或缺失資料不可回退至現行班名。
 */
export function compare(reportStudents, webStudents, asOfDate, rateContext = undefined) {
  const { map: webByName, duplicates } = indexByName(webStudents);
  const records = [];

  for (const entry of reportStudents.values()) {
    const reportHead = (entry.tuition || '').split(' - ')[0]?.trim() ?? '';
    const reportBaseName = reportHead ? parseSingleClassToken(reportHead).baseName : '';
    const reportSemantics = reportBaseName ? classSemanticsForRun(reportBaseName, rateContext) : undefined;
    const tuition = parseTuition(entry.tuition, reportSemantics);
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
        statusLabel: STATUS_LABEL[category],
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

    // issue #122：v3 run 的適用率走產品端 `applicableRateForClass` 的快照分支，
    // 與畫面同源。不可自行挑 `applicableAnqinBps`／`applicableTutoringBps`——那正是
    // 繞過快照的舊行為，遇到手動覆寫類別或固定 5 天的班會與畫面分歧且不報錯。
    //
    // **但有輔導班報名才走快照**：報表以科目（學費）取列，會出現只有美語／數學
    // 報名、卻因年級落在課輔側而進到本報告的學生（實測 37 列中有 11 列如此）。
    // 這些學生名冊裡**沒有國小輔導班**，也就沒有「本班」可言，快照查無此班會得到
    // 「無法判定」而把原本顯示的適用率整欄變成 `-`——那是在本修正範圍外減少資訊。
    // 故無輔導班者維持既有「依年級取安親／課輔側」，不新增猜測（這裡沒有班名可用）。
    const enrollmentSemantics = enrollmentProjection(w, rateContext);
    const careEnrollments = enrollmentSemantics.filter((enrollment) => enrollment.category === 'care');
    const careClassName = careClassNameOf(enrollmentSemantics);
    const usesSnapshot = !!rateContext && (rateContext.usesClassCategorySnapshot ?? rateContext.isV3Run);
    const snapshotUnavailable = !rateContext || rateContext.known === false || (
      usesSnapshot
        ? (
        !Array.isArray(rateContext.classCategories) ||
        rateContext.classCategories.length === 0
        )
        : false
    ) || !hasCompleteV4EnrollmentSnapshots(w, rateContext);
    const useSnapshot = usesSnapshot && careClassName !== '';
    const applicable = useSnapshot
      ? applicableRateForClass(careClassName, { grade, ...RATE_INPUT_FIELDS(w) }, toApplicableRateContext(rateContext))
      : null;
    const rateBps = snapshotUnavailable
      ? null
      : useSnapshot
      ? (applicable.status === 'configured' ? applicable.bps : null)
      : (isAnqin ? w.applicableAnqinBps : (isTutoring ? w.applicableTutoringBps : null));

    const care = isAnqin ? w.trace?.careDays?.anqin : (isTutoring ? w.trace?.careDays?.tutoring : null);

    const web = {
      days,
      daysLabel,
      rateBps,
      rateNotConfigured: snapshotUnavailable || (useSnapshot && applicable.status === 'not_configured'),
      asOfDate,
      baseDiscountBps: w.baseDiscountBps,
      subjectCount: w.subjectCount,
      isEnrolled: care?.isEnrolled ?? false,
      status: care?.status ?? 'unknown',
      hasExtraFlag: care?.hasExtraFlag ?? false,
      declaredTier: careEnrollments[0]?.erpBillingTier ?? null,
      tokens: w.enrollments.map(e => e.rawToken),
      careTokens: careEnrollments.map((e) => e.rawToken),
      homeworkTokens: enrollmentSemantics
        .filter((e) => e.semantic?.summaryDayRoles.includes('homeworkDays'))
        .map((e) => e.rawToken),
      otherTokens: enrollmentSemantics
        .filter((e) => e.category !== null && e.category !== 'care' && !e.semantic?.summaryDayRoles.includes('homeworkDays'))
        .map((e) => e.rawToken),
      // 離班標記直接取 API 已解析好的欄位，不在本檔用 regex 重新偵測
      // （review F-minor-2：自訂 regex 與產品錨定行尾的寫法分歧，且屬重複實作）
      withdrawals: enrollmentSemantics
        .filter((e) => e.category === 'care' && e.withdrawalDate)
        .map(e => ({ token: e.rawToken, date: e.withdrawalDate })),
      tierComparisons: w.tierComparisons || [],
      issues: w.issues || [],
      rawTags: w.trace?.rawTags || '',
    };

    let statusCategory = 'MATCH';
    // 分界依據是「報表有沒有學費明細列」，不是枚舉 tierStatus。
    // 報表明明有學費列卻讀不到天數時，說它「無學費項」是事實錯誤（review F-NEW-1）。
    const hasTuitionRow = excel.className !== null && excel.className !== undefined;
    if (!hasTuitionRow) {
      statusCategory = 'EXCEL_NO_TUITION';
    } else if (excel.days === null) {
      statusCategory = 'TIER_UNPARSED';
    } else if (web.rateNotConfigured) {
      // issue #122／D17：v3 run 缺該班快照 → 系統端無從判定，**不可靜默落成
      // 「無折扣」**（那會讓一筆無法判定的帳看起來像一筆正常折扣的帳）。
      // 獨立分類並列在需人工判讀，且不與報表格式問題混為一談。
      statusCategory = 'WEB_RATE_NOT_CONFIGURED';
    } else {
      const dayDiff = excel.days !== days;
      const discDiff = excel.rateBps !== rateBps;
      if (dayDiff && discDiff) statusCategory = 'BOTH_DIFF';
      else if (dayDiff) statusCategory = 'DAY_DIFF';
      else if (discDiff) statusCategory = 'DISCOUNT_DIFF';
      else if (excel.rateParseStatus === 'unknown') {
        // 數字雖一致，但報表折扣格式認不出來，不可宣稱「完全一致」（review F-NEW-4）
        statusCategory = 'RATE_UNPARSED';
      }
    }
    // statusLabel 一律由 defineCategories 的 label 推導，新增分類不會漏掉
    const statusLabel = STATUS_LABEL[statusCategory];

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
 * 差異歸納群組。
 *
 * 群組的**內容**是國小輔導專屬的判斷（哪些旗標構成值得人工確認的成因），
 * 故留在本檔。
 *
 * 注意：每個群組的 filter 目前**直接比 statusCategory 字面值**，沒有讀取
 * `CATEGORIES.groupOf`。也就是說「哪個分類歸哪個群組」在本檔被寫了兩份
 * （specs 的 insightGroup 與這裡的 filter），兩份不同步時不會有任何錯誤。
 * `groupOf` 目前只有測試在讀。接線屬於下一個工具（PR C）的工作，
 * 本 PR 不動它，以免在沒有第二個真實使用者的情況下先猜錯介面。
 */
const INSIGHT_GROUPS = [
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

function renderInsightGroups(records) {
  return INSIGHT_GROUPS
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

  // 兩個槽位（同時差異警告、名單重名警告）分開傳入，即使為空也各佔一行——
  // 這是原樣板的既有輸出，見 report-shell.ts 的 extraInsights 說明。
  const bothWarning = bothCount > 0
    ? `<div class="alert alert-warning"><strong>天數與折扣同時差異（${bothCount} 筆）</strong>：需同時確認班級異動與標籤異動。</div>`
    : '';

  // 分頁按鈕的**清單**來自 defineCategories（新增帶 tab 的分類即自動出現按鈕），
  // 這裡只補上計數文字。顯示順序由 tabOrder 決定：先看天數、再看折扣、最後才看一致。
  const tabs = CATEGORIES.tabs.map(t => ({ value: t.value, label: `${t.label} (${count(t.value)})` }));

  return renderShell({
    title: '國小輔導收費核對與財務報表比對報告',
    logoBadge: '帳務實質比對',
    description: '以每一學生為單位，比對「國小輔導」（含安親、課輔、寫功課）之每週收費天數與適用折扣。\n    比對目的為找出差異並標示可能成因，不預設任一資料來源為正確。',
    meta: [
      { label: '網頁系統名單', value: `${meta.asOfDate} 米豆奶匯出` },
      { label: 'Run', value: meta.runId },
      { label: '帳務來源', value: path.basename(meta.xlsxPath) },
      { label: '規則策略', value: `${meta.ruleSetVersion} / ${meta.numericPolicy}` },
      { label: '報表工作表', value: SHEET_NAME },
      { label: '核定發單日', value: meta.billAnchorDate },
    ],
    stats: [
      { label: '報表學生總數', value: total, sub: '有輔導帳單或相關項目', tone: 'plain' },
      { label: '天數與折扣一致', value: matchCount, sub: `${rate}%`, tone: 'match' },
      { label: '差異筆數', value: diffCount, sub: '含離班／無學費項', tone: 'diff' },
      { label: '天數差異', value: dayCount, sub: '級距或衝堂扣天', tone: 'plain' },
      { label: '折扣差異', value: discCount, sub: '標籤或人工特例', tone: 'diff' },
      {
        label: '需人工判讀', value: needsHumanCount, tone: 'neutral',
        sub: `離班 ${notInWebCount}・無學費 ${noTuitionCount}・同名 ${unpairableCount}・格式 ${tierUnparsedCount + rateUnparsedCount}`,
      },
    ],
    insightHtml: renderInsightGroups(records),
    extraInsights: [bothWarning],
    columns: [
      { key: 'name', heading: '姓名', sticky: true },
      { key: 'personCode', heading: '人員代碼' },
      { key: 'grade', heading: '年級' },
      { key: 'careCategory', heading: '課程類別' },
      { key: 'status', heading: '比對結果' },
      { key: 'excelDays', heading: '報表天數' },
      { key: 'webDays', heading: '網頁天數' },
      { key: 'excelRate', heading: '報表折扣' },
      { key: 'webRate', heading: '網頁折扣' },
      { key: 'billItems', heading: '報表開單項目' },
      { key: 'tokens', heading: '名單報名班級' },
      { key: 'note', heading: '差異說明與可能成因' },
    ],
    rowsHtml: records.map(renderRow).join(''),
    duplicateNames: meta.duplicateNames,
    tabs,
    registry: CATEGORIES,
    total,
    diffCount,
    needsHumanCount,
  });
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
  //
  // 專案根必須由**本檔**算出：scripts/shared/ 比 scripts/ 深一層，若在共用層內
  // 寫死 '..' 會算成 web/，守衛仍會擋下 web/ 內的路徑，卻放行 repo 根下其他
  // 目錄——保護被靜默削弱且不報錯。assertProjectRoot 以哨兵檔實測此路徑，
  // 深度算錯時啟動即失敗。
  const projectRoot = assertProjectRoot(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  );
  assertOutputOutsideProject(projectRoot, outputPath);

  console.log('讀取報表：', args.xlsx);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(args.xlsx);
  const ws = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[0];
  const reportStudents = readReport(ws, REPORT_SUBJECTS);

  console.log(`讀取網頁資料：${args.base}`);
  const { runId, students } = await fetchRunStudents(args.base);
  const run = await fetchRun(args.base, runId);

  const asOfDate = run.asOfDate || '—';
  console.log(`報表學生 ${reportStudents.size} 名、名單學生 ${students.length} 名（run ${runId}, asOf ${asOfDate}）`);

  // issue #122：v3 run 帶上類別快照，適用率走產品讀模型的快照分支，與畫面同源。
  // issue #140：一律經由 `buildRunSnapshotContext` 這個單一入口——不在此自行判空，
  // 否則「這行做對了」沒有任何測試盯得住（單元測試恆以顯式參數傳入 rateContext）。
  const rateContext = buildRunSnapshotContext(run);
  if (shouldWarnMissingSnapshot(run)) {
    console.warn('警告：此 run 的規則版本或類別／語意快照不完整；本報告不以當前班名補推級距或適用率，相關列將標示為無法判定（issue #122／#148）。');
  }

  const { records, duplicates } = compare(reportStudents, students, asOfDate, rateContext);

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

  // 分類計數由 CATEGORIES 推導：欄位集合與順序都來自 specs，新增分類自動出現在
  // 統計中，不會漏報；鍵名走各 spec 的 summaryKey，維持既有的短別名不變。
  const count = (cat) => records.filter(r => r.statusCategory === cat).length;
  const summary = formatCategorySummary(CATEGORIES, {
    total: records.length,
    byCategory: count,
  });
  console.log('差異統計：', summary);
  console.log('報告已輸出：', outputPath);
}

// 僅在直接執行時才跑；測試以 import 引入純函式時不得觸發比對流程
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('比對失敗：', err.message);
    process.exit(1);
  });
}

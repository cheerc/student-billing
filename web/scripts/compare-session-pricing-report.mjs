/**
 * 按堂計價帳務比對工具：把網頁系統（米豆奶匯出 run）與米豆奶財務報表 XLSX
 * 逐生比對**兒童美語／國小數學**的適用折扣，產出 HTML 差異報告。
 *
 * 用法（**必須走 npm 入口，不可直接用 node 跑**，理由見 compare-billing-report.mjs 同段）：
 *   cd web
 *   npm run billing:compare:sessions -- --xlsx <財務報表.xlsx> [--out <報告.html>] [--base http://127.0.0.1:3000]
 *
 * ## 與國小輔導工具的差異（不是同一個工具的複製）
 *
 *  | 面向         | billing:compare（國小輔導）        | billing:compare:sessions（本檔）        |
 *  |--------------|-----------------------------------|-----------------------------------------|
 *  | 計價方式     | 每週收費級距（週收費天數）         | 堂數 × 單價，**無級距制度**              |
 *  | 比對欄位     | 週收費天數 ＋ 適用折扣             | **僅適用折扣**                           |
 *  | 天數差異     | 有（DAY_DIFF／BOTH_DIFF）          | 不存在，不設該分類                      |
 *  | 學生 → 紀錄  | 一生一筆                          | 一生**數筆**（每筆學費列一筆）           |
 *  | 金額欄       | 不需要                            | 需要（欄 9.. 為每班一欄）               |
 *
 * ## 複寫禁令（CLAUDE.md §9.0）
 *
 * 班名 → 類別的判定**一律取產品端 `historicalRateCategoryOfClass`**，本檔不自寫對照表。
 * 複寫必然漂移——國小輔導工具曾在自建白名單裡漏掉 `[5]`、把 `[Starter]`
 * 默默當成 5 天（review F-NEW-2）。此處同樣只保有一份真相。
 *
 * ## 不計算單價與金額（issue #118）
 *
 * 報表有「16 堂課」與學費金額，但**系統端沒有對應欄位**，因此本檔只把兩者
 * 當**顯示值**帶出，不做任何換算、不驗證。工具若自行以金額 ÷ 堂數推出單價
 * 並拿去比對，等於替系統斷言一個系統並未持有的事實——正是 CLAUDE.md §9.0
 * 禁止的「代為猜測」。故兩欄皆標為不可驗證並指向 #118。
 */
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import { historicalRateCategoryOfClass, applicableRateForClass } from '../src/application/applicable-rate.ts';
import { parseSingleClassToken } from '../src/domain/students/token-parser.ts';

import { parseDiscounts, bpsToLabel, readMultiTuitionReport } from './shared/report-xlsx.ts';
import { fetchRunStudents, fetchRun } from './shared/roster-api.ts';
import { normalizeName, indexByName } from './shared/name-matching.ts';
import { toApplicableRateContext, snapshotRowFor, classSemanticsForRun, runUsesClassSemanticsSnapshot, buildRunSnapshotContext, shouldWarnMissingSnapshot, usesFrozenLegacyProjection } from './shared/rate-context.ts';
import { defineCategories, formatCategorySummary } from './shared/category-registry.ts';
import { renderShell, escapeHtml } from './shared/report-shell.ts';
import { assertProjectRoot, assertOutputOutsideProject } from './shared/project-guard.ts';
import { RATE_PATTERNS } from './shared/report-xlsx.ts';

const SHEET_NAME = '班級營收狀況';

/** 米豆奶財務報表的科目名稱。學費明細與折扣明細分屬不同科目列，與國小輔導工具相同。 */
const REPORT_SUBJECTS = { tuition: '學費', discount: '折扣' };

/** 金額欄位的固定起始索引；欄 1..8 為固定版面（姓名／單號／日期／明細／…／科目／狀態）。 */
const AMOUNT_COLUMN_START = 9;

/** 報表中承接雜費、商品、車資等**非學費**金額的欄位表頭。 */
const NON_TUITION_HEADING = '非學費費用';

/** 堂數與學費金額皆為顯示值，系統端無對應欄位（issue #118）。 */
const UNVERIFIABLE_NOTE = '不可驗證（#118：系統尚無單價／學費金額欄位）';

/**
 * 差異分類的**單一真相來源**（CLAUDE.md §9.2）。
 *
 * 機制（badges／labels／tabs／needsHuman／summaryKeys／groupOf）由
 * `defineCategories` 推導；但**每個工具的分類資料不同**，故此處各列一份——
 * 那是資料，不是重複實作。
 *
 * 本工具刻意**沒有** DAY_DIFF／BOTH_DIFF／TIER_UNPARSED：按堂計價沒有級距制度，
 * 「週收費天數」這個概念在此不存在，設一個永遠不會出現的分類只會誤導。
 *
 * badge 沿用系統既有意象：綠=一致、琥珀=折扣需確認、藍=非標準折扣（需人工）、
 * 紅=無法配對、灰=名單／報表無資料。
 */
const CATEGORIES = defineCategories([
  { id: 'MATCH', label: '折扣一致', summaryKey: 'match', badge: 'badge-ok', needsHuman: false, tab: 'MATCH', tabOrder: 30, insightGroup: 'none' },
  { id: 'DISCOUNT_DIFF', label: '折扣差異', summaryKey: 'discount', badge: 'badge-warn', needsHuman: false, tab: 'DISCOUNT_DIFF', tabOrder: 20, insightGroup: 'none' },
  { id: 'NON_STANDARD_DISCOUNT', label: '非標準折扣需人工確認', summaryKey: 'nonStandard', badge: 'badge-tier', needsHuman: true, tab: 'NON_STANDARD_DISCOUNT', tabOrder: 10, insightGroup: 'nonStandard' },
  { id: 'RATE_UNPARSED', label: '報表折扣無法解析', summaryKey: 'rateUnparsed', badge: 'badge-warn', needsHuman: true, tab: 'RATE_UNPARSED', tabOrder: 15, insightGroup: 'unparsed' },
  { id: 'UNKNOWN_CLASS', label: '班級非美語／數學', summaryKey: 'unknownClass', badge: 'badge-class', needsHuman: true, tab: 'UNKNOWN_CLASS', tabOrder: 16, insightGroup: 'unparsed' },
  { id: 'WEB_RATE_NOT_CONFIGURED', label: '系統無適用折扣值', summaryKey: 'webRateNotConfigured', badge: 'badge-class', needsHuman: true, insightGroup: 'unparsed' },
  { id: 'NOT_IN_WEB', label: '名單已無此人', summaryKey: 'notInWeb', badge: 'badge-class', needsHuman: true, insightGroup: 'notInWeb' },
  { id: 'EXCEL_NO_TUITION', label: '報表無學費項', summaryKey: 'noTuition', badge: 'badge-class', needsHuman: true, insightGroup: 'notInWeb' },
  { id: 'UNPAIRABLE', label: '姓名無法唯一配對', summaryKey: 'unpairable', badge: 'badge-withdrawal', needsHuman: true, tab: 'UNPAIRABLE', tabOrder: 18, insightGroup: 'unpairable' },
]);

/** 分類 id 集合（由 defineCategories 推導，供測試與完整性檢查使用）。 */
export const SESSION_RATE_CATEGORIES = CATEGORIES.ids;

/** 差異分類 registry 本身，供測試讀取 groupOf 等衍生資料。 */
export const SESSION_CATEGORY_REGISTRY = CATEGORIES;

/** 分類 id → 中文 label。由 defineCategories 推導，不另列一份。 */
const STATUS_LABEL = CATEGORIES.labels;

/** 分類 id → CSS badge class。由 defineCategories 推導，不另列一份。 */
const BADGE_BY_CATEGORY = CATEGORIES.badges;

/** 需人工判讀（非兩邊直接比大小）的分類清單。由 defineCategories 推導。 */
const NEEDS_HUMAN_CATEGORIES = CATEGORIES.needsHuman;

/** 保留匯出名稱，供測試與日後的工具沿用。 */
export const BADGES = BADGE_BY_CATEGORY;
export const NEEDS_HUMAN = NEEDS_HUMAN_CATEGORIES;

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
 * 學費明細 → 班名與堂數。
 *
 * 與國小輔導工具的 `parseTuition` 不同：**不解析級距**。按堂計價沒有級距制度，
 * 解析它只會製造一個永遠用不到的欄位。
 *
 * 堂數只取字面數字（`- 16 堂課`），不做任何換算或單位推導。
 */
export function parseSessionTuition(detail) {
  if (!detail) return { className: null, sessions: null };
  const [head, tail] = detail.split(' - ');
  const className = (head || '').trim();
  const sessionMatch = (tail || '').match(/(\d+)\s*堂課/);
  return {
    className: className || null,
    sessions: sessionMatch ? parseInt(sessionMatch[1], 10) : null,
  };
}

/**
 * 表頭文字 → 欄位索引（1-based）。
 *
 * 索引來自實際掃描而非寫死：報表的班別欄位數會隨開班數變動（本次為 3 個班 +
 * 1 個「非學費費用」欄，共欄 9..12）。寫死索引等於假定下一期仍是同樣的班數。
 */
export function buildColumnIndex(headerTexts) {
  const index = new Map();
  for (let i = 0; i < headerTexts.length; i++) {
    const t = headerTexts[i]?.trim();
    if (t) index.set(t, i + 1);
  }
  return index;
}

/**
 * 從一列取出該班級的學費金額。
 *
 * ## 為何不能「取第一個數字欄」
 *
 * 真實報表的欄 9.. 是**每個班一欄**，不是單一金額欄：
 *   欄 9 = 兒童美語-Dommie[團][W9]、欄 10 = 兒童美語-Archy[團][W7]、
 *   欄 11 = 兒童美語-Gino[團][Starter]、欄 12 = 非學費費用。
 *
 * 同一份報表裡 Dommie 為 7,360、Gino 為 7,200（單價不同、堂數也不同）。
 * 若取「第一個數字欄」，每筆學費都會被記成 Dommie 的 7,360——而且報表照樣
 * 顯示得出來，不會有任何錯誤訊息。
 *
 * 因此規則是：**先取表頭與班名同名者**；同名欄不存在或該列無金額時才退回
 * 「非學費費用」欄，並如實記錄走了哪條路徑（`amountRoute`）。
 *
 * 注意「同名欄存在但該列為空」時回 `null` 而非退回首欄：空值代表這一列沒有
 * 這個班的學費，退回其他欄會把別人的金額安到這位學生身上。
 */
export function parseAmountColumns(columnIndex, row, className) {
  const classColumn = className ? columnIndex.get(className) : undefined;
  if (classColumn !== undefined) {
    const v = row.getCell(classColumn).value;
    return {
      tuitionAmount: typeof v === 'number' ? v : null,
      amountColumnHeading: className,
      amountRoute: 'class-column',
    };
  }
  const feeColumn = columnIndex.get(NON_TUITION_HEADING);
  if (feeColumn !== undefined) {
    const v = row.getCell(feeColumn).value;
    return {
      tuitionAmount: typeof v === 'number' ? v : null,
      amountColumnHeading: NON_TUITION_HEADING,
      amountRoute: 'non-tuition-column',
    };
  }
  return { tuitionAmount: null, amountColumnHeading: null, amountRoute: 'none' };
}

/**
 * 找出「非標準折扣」明細：認不出折價率、且帶金額算式的折扣列。
 *
 * ## 為何獨立於 rateParseStatus
 *
 * 共用層的 `parseDiscounts` 只認「課程費 NN折」白名單，見到「課程費」卻認不出
 * 數字才會標 `unknown`。真實報表的那筆期中去補加收
 * （`本校_扣3/9-4/29 學費 15*40=600`）**不含**「課程費」字樣，故對
 * `parseDiscounts` 而言只是一筆普通獨立優惠項，狀態仍是 `parsed`。
 *
 * 若把偵測做成「rateParseStatus !== 'parsed'」，這筆就抓不到——而它恰恰是
 * 期中最容易被忽略、卻最需要人工確認的帳務事實。該生系統端與報表的折價率
 * 兩邊都是 95 折、數字完全一致，正是「看數字看不出問題」的那種。
 *
 * 因此此處獨立判定，且**不**把它摺進折價率：報表仍讀為 95 折，補加收另列。
 *
 * 白名單複用 `RATE_PATTERNS`（report-xlsx.ts），不另寫一份比對規則——
 * 新增折價率格式時只改那一處。
 */
export function findNonStandardDiscounts(details) {
  return (details ?? []).filter(
    (d) => typeof d === 'string' && /=/.test(d) && !RATE_PATTERNS.some(([re]) => re.test(d)),
  );
}

/**
 * 報表明細的班名部分 → **去掉方括號修飾的基礎班名**。
 *
 * 報表的折扣列會在班名尾端再掛一個方括號標記折價率或用途：
 *   `兒童美語-Dommie[團][W9][9.5折] - 課程費95折`
 *   `兒童美語-Dommie[團][W9][折扣] - 本校_扣3/9-4/29 學費 15*40=600`
 *
 * 學費列則只有 `兒童美語-Dommie[團][W9]`。因此雙科學生（同時修美語與數學）
 * 的折扣列若不依班名分派，數學班的折扣會被算到美語班上——而折價率不符時只會
 * 顯示為「折扣差異」，成因被靜默歸錯。
 *
 * 取基礎班名一律**複用產品端 `parseSingleClassToken`**（其 `baseName` 即
 * 去修飾結果），不自寫 regex 剝方括號（§9.0：複寫即漂移）。
 * 解析失敗時回傳原字串，不猜測。
 */
function baseClassName(head) {
  if (!head) return '';
  try {
    const parsed = parseSingleClassToken(head);
    return parsed.baseName || head;
  } catch {
    return head;
  }
}

/**
 * 報表明細的班名部分 → 系統適用率欄位。
 *
 * 類別判定直接取產品端 `historicalRateCategoryOfClass`，本檔不自寫對照表（§9.0 複寫即漂移）。
 * 欄位名以對照表由**類別**推導，而非把類別字串拼成欄位名——後者會得到
 * `applicableenglishbps` 這種拼錯的名字，而拼錯不會報錯，只會讓數值變 undefined。
 *
 * 本表只列本工具比對的兩類；`care`（國小輔導）不在此列，那由 `billing:compare`
 * 負責。`historicalRateCategoryOfClass` 仍會對輔導班回 'care'，呼叫端據此區分
 * 「判定為輔導」（可解釋的結果）與「無法判定」（null，才需要人工介入）。
 */
const RATE_FIELD_BY_CATEGORY = {
  english: 'applicableEnglishBps',
  math: 'applicableMathBps',
};

/**
 * 把班名路由到該學生的系統適用率。
 *
 * **本函式只服務 v1／v2 run**（名稱映射路徑）。v3 run 走快照，由
 * `resolveApplicableRate`（見下）轉交產品端 `applicableRateForClass`，
 * 不經這裡——否則手動覆寫類別的班別會與畫面分歧（issue #122）。
 *
 * @param className 報表上的班名
 * @param student   名單學生（提供四個 applicable*Bps 欄位）
 */
export function routeRateField(className, student) {
  const category = historicalRateCategoryOfClass(className);
  if (category === null) return { category: null, field: null, bps: null };
  const field = RATE_FIELD_BY_CATEGORY[category] ?? null;
  const bps = field ? (student?.[field] ?? null) : null;
  return { category, field, bps };
}

/**
 * Missing/unknown Run context (issue #122 / #148).
 *
 * It deliberately does not represent a legacy run. Name mapping is enabled only when the
 * caller supplies an explicitly identified v1-v3 formal Run through the shared context builder.
 */
export const MISSING_RUN_CONTEXT = Object.freeze({
  known: false,
  usesClassCategorySnapshot: false,
  usesClassSemanticsSnapshot: false,
  isV3Run: false,
  classCategories: null,
  ruleSetVersion: null,
});

/**
 * 本筆學費應比對的系統適用率。
 *
 * **單一入口**：v3/v4 run 一律走產品端 `applicableRateForClass` 的快照分支
 * （PR-4：缺快照時嚴禁以當前班名猜測），明確 v1/v2 才走名稱映射的
 * `routeRateField`。Missing/unknown/compat context is unavailable. CLAUDE.md §9.0：
 * 判定邏輯一律取產品函式，本檔不自寫一份「快照怎麼查、category 怎麼比」的對照表。
 *
 * `context` 的形狀沿用 API 回應（`run.classCategories`），**不在此轉型**：
 * 快照是 `fixed_five_days` 為數字 0/1 的底線命名物件，產品讀模型判 `=== 1`，
 * 轉成布林會讓「固定 5 天 → 100%」靜默失效。
 *
 * @param className 報表上的班名（**名冊名**，快照的 `base_name` 存的就是它；
 *                  呼叫端須先以 `baseClassName` 去修飾，本函式不做班名正規化）
 * @param student   名單學生
 * @param context   Selected Run's version metadata and snapshots; omitted/unknown is unavailable.
 */
export function resolveApplicableRate(className, student, context) {
  const ctx = context;
  if (!ctx || ctx.known === false) {
    return { status: 'not_configured', bps: null, category: null, fromSnapshot: false };
  }

  if (ctx.usesClassCategorySnapshot ?? ctx.isV3Run) {
    const categorySnapshot = snapshotRowFor(ctx, className);
    if (!categorySnapshot) {
      return { status: 'not_configured', bps: null, category: null, fromSnapshot: true };
    }

    if (runUsesClassSemanticsSnapshot(ctx) && categorySnapshot.class_type === undefined) {
      const semantics = classSemanticsForRun(className, ctx);
      if (!semantics || semantics.category !== categorySnapshot.category) {
        return { status: 'not_configured', bps: null, category: null, fromSnapshot: true };
      }
    }

    // 快照的查詢與「找不到算什麼」一律走共用層的轉接，兩台工具同源（§9.0）。
    const rate = applicableRateForClass(className, student ?? {}, toApplicableRateContext(ctx));
    return {
      status: rate.status,
      bps: rate.status === 'configured' ? rate.bps : null,
      // 類別一律以快照為準（無快照即無法判定，不退回班名推導）。
      // 呼叫端據此分派「輔導班 → 另一台工具」與「未分類 → 需人工歸類」。
      category: categorySnapshot ? categorySnapshot.category : null,
      fromSnapshot: true,
    };
  }

  if (!usesFrozenLegacyProjection(ctx)) {
    return { status: 'not_configured', bps: null, category: null, fromSnapshot: false };
  }

  const routed = routeRateField(className, student);
  // 名稱映射沒有「未配置」狀態：v2 一直是以 null 表示「此側無適用值」。
  return {
    status: routed.category === null ? 'unclassified' : 'configured',
    bps: routed.bps,
    category: routed.category,
    fromSnapshot: false,
  };
}

/** 類別的中文顯示名（用於表格欄位與說明）。 */
const CATEGORY_LABEL = {
  english: '兒童美語',
  math: '國小數學',
  care: '國小輔導',
};

// ---------------------------------------------------------------- 差異原因推導

/**
 * 由資料推導可能成因，不預設哪一邊正確（延續 D17）。
 */
function buildNotes({ statusCategory, excel, web }) {
  const notes = [];
  const categoryText = excel.rateCategory ? CATEGORY_LABEL[excel.rateCategory] ?? excel.rateCategory : '（班級未分類）';

  const finish = (partial) => ({
    tone: 'warn',
    notes: [],
    tags: [],
    homework: false,
    withdrawal: false,
    dupIssues: [],
    mismatches: [],
    ...partial,
  });

  if (statusCategory === 'MATCH') {
    const extras = [...excel.nonStandardDiscounts, ...excel.otherItems];
    return finish({
      tone: 'match',
      notes: [
        `${categoryText}：報表 ${bpsToLabel(excel.rateBps)} 與網頁一致。`,
        ...(extras.length ? [`報表另有其他項目（不影響課程費折扣比對）：${extras.join('、')}。`] : []),
      ],
    });
  }

  if (statusCategory === 'NON_STANDARD_DISCOUNT') {
    return finish({
      tone: 'warn',
      notes: [
        `報表折扣含非標準明細：${excel.nonStandardDiscounts.join('、')}。`,
        `該明細未含「課程費 NN折」格式，故未計入折價率；報表折價率仍讀為 ${bpsToLabel(excel.rateBps)}，與網頁 ${bpsToLabel(web?.rateBps)} 一致。`,
        '此類明細（期中補加收、轉班補差等）常見於期中去補，無法由折價率自動判斷正確與否，請人工確認後開單。',
      ],
    });
  }

  if (statusCategory === 'RATE_UNPARSED') {
    return finish({
      notes: [
        `報表折扣明細含無法解析的「課程費」格式（${excel.extraDiscounts.join('、')}）。`,
        `折價率無法確定，不可視為一致；請人工確認報表格式。`,
      ],
    });
  }

  if (statusCategory === 'UNKNOWN_CLASS') {
    return finish({
      tone: 'neutral',
      notes: [
        `報表班名「${excel.className ?? '-'}」不屬兒童美語或國小數學，本工具不代為歸類。`,
        '若此班確實屬按堂計價科目，請人工確認應比對哪一個適用率；工具刻意不猜測。',
      ],
    });
  }

  if (statusCategory === 'WEB_RATE_NOT_CONFIGURED') {
    if (web?.rateFromSnapshot) {
      // issue #122：這是最容易被誤讀成一筆正常帳的情形——系統對這班沒有任何
      // 快照列的依據，而報表仍開了單。明文說出「無法判定」與下一步，不猜。
      return finish({
        tone: 'warn',
        notes: [
          `系統這一版 run 沒有班級「${excel.className ?? '-'}」的類別快照，無法判定適用折扣（03 §5.3.4：不以當前班名猜測）。`,
          `報表目前讀為 ${bpsToLabel(excel.rateBps)}，請人工確認該班是否應存在於本次名單後再開單。`,
        ],
      });
    }
    return finish({
      tone: 'neutral',
      notes: [
        `名單中此生的 ${categoryText} 適用折扣為空（已配置但無適用值），無法比對。`,
        `報表目前讀為 ${bpsToLabel(excel.rateBps)}。請人工確認此生是否應有適用折扣。`,
      ],
    });
  }

  if (statusCategory === 'UNPAIRABLE') {
    return finish({
      tone: 'neutral',
      notes: [
        `報表有此學生帳單，但無法與名單唯一配對（${web?.asOfDate} 名單可能有同名或姓名寫法差異）。`,
        '請改以人員代碼核對，不要直接判定為離班。',
      ],
    });
  }

  if (statusCategory === 'NOT_IN_WEB') {
    const items = [...excel.nonStandardDiscounts, ...excel.otherItems];
    return finish({
      tone: 'neutral',
      notes: [
        `報表有帳單，但 ${web?.asOfDate} 名單已無此學生（期中離班或退費）。`,
        ...(items.length ? [`帳單項目：${items.join('、')}。`] : []),
      ],
    });
  }

  if (statusCategory === 'EXCEL_NO_TUITION') {
    const items = [...excel.nonStandardDiscounts, ...excel.otherItems];
    return finish({
      tone: 'neutral',
      notes: [
        `報表無正式學費項${items.length ? `，僅有：${items.join('、')}` : ''}；本工具僅比對有學費列的班別。`,
      ],
    });
  }

  // 折扣差異
  if (statusCategory === 'DISCOUNT_DIFF') {
    if (excel.rateParseStatus === 'unknown') {
      notes.push(`報表折扣明細含無法解析的「課程費」格式（${excel.extraDiscounts.join('、')}），此差異源自報表格式變更；請人工確認。`);
      notes.push(`報表目前讀為 ${bpsToLabel(excel.rateBps)} vs 網頁 ${bpsToLabel(web.rateBps)}。`);
      return finish({ notes });
    }
    if (excel.rateBps === 10000 && web.rateBps !== 10000) {
      notes.push(`報表無課程費折扣明細，網頁端 ${categoryText} 適用折扣為 ${bpsToLabel(web.rateBps)}。`);
    } else if (web.rateBps === 10000) {
      notes.push(`報表有課程費折扣 ${bpsToLabel(excel.rateBps)}，網頁端 ${categoryText} 無適用折扣。`);
    }
    if (excel.extraDiscounts.length > 0) {
      notes.push(`報表另有非課程費折扣項：${excel.extraDiscounts.join('、')}。`);
    }
    const webStudentTags = String(web.rawTags || '').split('\n').map(t => t.trim()).filter(Boolean);
    if (webStudentTags.length) notes.push(`名單標籤：${webStudentTags.join('、')}。`);
    notes.push(`報表 ${bpsToLabel(excel.rateBps)} vs 網頁 ${bpsToLabel(web.rateBps)}（基本折扣 ${bpsToLabel(web.baseDiscountBps)}）。`);
  }

  if (!notes.length) {
    notes.push(`報表 ${bpsToLabel(excel.rateBps)} vs 網頁 ${bpsToLabel(web.rateBps)}，差異可能來自名單或課表異動。`);
  }

  return finish({ notes });
}

// ---------------------------------------------------------------- 比對主流程

/**
 * 逐生比對。
 *
 * ## 一名學生可產生多筆紀錄
 *
 * 報表的學費明細是**一列一筆**：同一名學生若同時修兒童美語與國小數學，
 * 會有兩列學費。本檔因此為**每一筆學費列**產生一筆紀錄，各自路由到自己的
 * 系統適用率欄位——這是與國小輔導工具「一生一筆」最重要的差異。
 *
 * 真實 10–11 月報表中此情形為 0（實測 37 名學生／37 筆學費列），
 * 展開行為改以合成 fixture 驗證，不可對真實報表要求其出現。
 *
 * @param reportStudents readMultiTuitionReport 的輸出（學費列為陣列）
 * @param webStudents    API 名單
 * @param asOfDate       名單基準日
 * @param amountLookup   可選：`{ getAmount(name, className) }`。學費金額必須在
 *                       讀表階段就依班名解析（比對邏輯拿不到儲存格），故由呼叫端
 *                       預先解析後以「姓名＋班名」為鍵查回；省略則金額皆為 null。
 * @param rateContext    所選 `/runs/{id}` 的版本 metadata 與類別／語意快照；unknown、omitted
 *                       或應有快照缺失時 fail closed。僅明確 v1-v3 formal Runs 使用凍結歷史投影。
 * @param {(Partial<import('./shared/rate-context.ts').RunSnapshotPayload> & Pick<import('./shared/rate-context.ts').RunSnapshotPayload, 'isV3Run' | 'classCategories'>) | undefined} [rateContext]
 */
export function compare(reportStudents, webStudents, asOfDate, amountLookup = undefined, rateContext = undefined) {
  const { map: webByName, duplicates } = indexByName(webStudents);
  const records = [];

  for (const entry of reportStudents.values()) {
    // 查詢端必須與索引端使用同一個正規化，否則含括號英文名的學生會整批配對失敗
    const lookupKey = normalizeName(entry.name);
    const matched = webByName.get(lookupKey);
    // undefined = 名單無此姓名（離班／退費）；null = 名單有此姓名但對應多人
    const ambiguous = matched === null;
    const w = matched ?? null;

    // 無學費列者：一筆 EXCEL_NO_TUITION。不可因為「沒有學費列」而略過該生——
    // 略過會讓報表上的收費項目在報告裡完全消失。
    if (!entry.tuitionRows || entry.tuitionRows.length === 0) {
      const excel = {
        className: null,
        sessions: null,
        tuitionAmount: null,
        amountColumnHeading: null,
        amountRoute: 'none',
        rateBps: 10000,
        rateDetail: null,
        rateCategory: null,
        rateParseStatus: parseDiscounts(entry.discounts).rateParseStatus,
        extraDiscounts: entry.otherDiscounts ?? [],
        nonStandardDiscounts: findNonStandardDiscounts(entry.discounts),
        otherItems: entry.other ?? [],
        billNo: entry.billNo,
        billDate: entry.billDate,
        billStatus: entry.billStatus,
      };
      const category = 'EXCEL_NO_TUITION';
      records.push({
        name: entry.name,
        personCode: ambiguous ? '（同名多人）' : (w?.personCode ?? '-'),
        grade: w?.gradeRaw ?? '-',
        rateCategoryLabel: '-',
        statusCategory: category,
        statusLabel: STATUS_LABEL[category],
        excel,
        web: w ? { asOfDate, rateBps: null, rateField: null, rateCategory: null, baseDiscountBps: w.baseDiscountBps, rawTags: w.trace?.rawTags || '', tokens: [] } : { asOfDate },
        asOfDate,
        note: buildNotes({ statusCategory: category, excel, web: { asOfDate } }),
      });
      continue;
    }

    for (const tuitionDetail of entry.tuitionRows) {
      const tuition = parseSessionTuition(tuitionDetail);
      // 快照的 base_name 存的是**名冊班名**，故查快照前先以產品端 `parseSingleClassToken`
      // 去修飾（不自寫剝方括號，§9.0）。此處同時供折扣分派使用，只算一次。
      const scopedClassName = tuition.className ? baseClassName(tuition.className) : '';
      const routed = resolveApplicableRate(scopedClassName, w, rateContext);
      const rateCategoryLabel = routed.category ? CATEGORY_LABEL[routed.category] ?? routed.category : '—';
      const routedField = routed.category ? (RATE_FIELD_BY_CATEGORY[routed.category] ?? null) : null;

      // 折扣依**本筆學費的班**分派：報表的折扣列在班名尾端掛著折價率或用途標記
      // （`…[W9][9.5折]`），去掉標記後即可與學費列的班名對應。
      // 雙科學生若不分派，另一門課的折扣會被算到這門課上，且只會顯示為
      // 「折扣差異」，成因被靜默歸錯——報表與系統兩邊都對，只有歸納錯了。
      const scopedDetails = entry.discounts.filter(
        (d) => typeof d === 'string' && baseClassName((d || '').split(' - ')[0].trim()) === scopedClassName,
      );
      const discount = scopedDetails.length > 0 ? parseDiscounts(scopedDetails) : parseDiscounts([]);
      const nonStandardDiscounts = findNonStandardDiscounts(scopedDetails);
      const scopedExtraDiscounts = (entry.otherDiscounts ?? []).filter(
        (d) => typeof d === 'string' && baseClassName((d || '').split(' - ')[0].trim()) === scopedClassName,
      );

      let excelAmount = { tuitionAmount: null, amountColumnHeading: null, amountRoute: 'none' };
      if (amountLookup && typeof amountLookup.getAmount === 'function') {
        excelAmount = amountLookup.getAmount(entry.name, tuition.className)
          ?? { tuitionAmount: null, amountColumnHeading: null, amountRoute: 'none' };
      }

      const excel = {
        className: tuition.className,
        sessions: tuition.sessions,
        tuitionAmount: excelAmount.tuitionAmount,
        amountColumnHeading: excelAmount.amountColumnHeading,
        amountRoute: excelAmount.amountRoute,
        rateBps: discount.rateBps,
        rateDetail: discount.rateDetail,
        rateCategory: routed.category,
        rateParseStatus: discount.rateParseStatus,
        extraDiscounts: scopedExtraDiscounts,
        nonStandardDiscounts,
        otherItems: entry.other ?? [],
        billNo: entry.billNo,
        billDate: entry.billDate,
        billStatus: entry.billStatus,
      };

      if (!w) {
        const category = ambiguous ? 'UNPAIRABLE' : 'NOT_IN_WEB';
        records.push({
          name: entry.name,
          personCode: ambiguous ? '（同名多人）' : '-',
          grade: '-',
          rateCategoryLabel,
          statusCategory: category,
          statusLabel: STATUS_LABEL[category],
          excel,
          web: { asOfDate },
          asOfDate,
          note: buildNotes({ statusCategory: category, excel, web: { asOfDate } }),
        });
        continue;
      }

      const web = {
        rateBps: routed.bps,
        rateField: routedField,
        rateCategory: routed.category,
        rateFromSnapshot: routed.fromSnapshot,
        asOfDate,
        baseDiscountBps: w.baseDiscountBps ?? null,
        rawTags: w.trace?.rawTags || '',
        tokens: (w.enrollments ?? []).map(e => e.rawToken),
      };

      let statusCategory;
      if (routed.status === 'not_configured') {
        // v3 run 缺該班快照（或該生的適用側無法判定）→ 03 §5.3.4：嚴禁以當前
        // 班名猜測。**不可靜默略過、也不可落回「無折扣」**——那會讓一筆無法
        // 判定的學費看起來像是一筆正常的帳（CLAUDE.md D17：顯眼標記不一致處）。
        statusCategory = 'WEB_RATE_NOT_CONFIGURED';
      } else if (routed.category === null) {
        // 班級不屬美語／數學 → 需人工歸類。**不可靜默略過**：略過會讓這筆學費
        // 在報告裡完全消失，而學生的帳單仍然存在。
        statusCategory = 'UNKNOWN_CLASS';
      } else if (routed.category === 'care') {
        // 國小輔導班不屬本工具範圍（非「無法判定」而是「確知屬另一個工具」）。
        // 快照手動覆寫成 care 也走這裡——與畫面顯示同一判斷。
        statusCategory = 'UNKNOWN_CLASS';
      } else if (routed.bps === null) {
        statusCategory = 'WEB_RATE_NOT_CONFIGURED';
      } else if (nonStandardDiscounts.length > 0) {
        // 非標準折扣優先於數字比對：數字一致時尤其需要人看到那筆補加收。
        statusCategory = 'NON_STANDARD_DISCOUNT';
      } else if (discount.rateBps !== routed.bps) {
        statusCategory = 'DISCOUNT_DIFF';
      } else if (discount.rateParseStatus === 'unknown') {
        // 數字雖一致，但報表折扣格式認不出來，不可宣稱「一致」
        statusCategory = 'RATE_UNPARSED';
      } else {
        statusCategory = 'MATCH';
      }

      records.push({
        name: entry.name,
        personCode: w.personCode,
        grade: w.gradeRaw ?? w.grade,
        rateCategoryLabel,
        statusCategory,
        statusLabel: STATUS_LABEL[statusCategory],
        excel,
        web,
        asOfDate,
        note: buildNotes({ statusCategory, excel, web }),
      });
    }
  }

  // 差異在前，其餘依姓名排序
  records.sort((a, b) => {
    const aDiff = a.statusCategory !== 'MATCH';
    const bDiff = b.statusCategory !== 'MATCH';
    if (aDiff !== bDiff) return aDiff ? -1 : 1;
    const byName = a.name.localeCompare(b.name, 'zh-Hant');
    if (byName !== 0) return byName;
    return (a.excel.className ?? '').localeCompare(b.excel.className ?? '', 'zh-Hant');
  });

  return { records, duplicates };
}

// ---------------------------------------------------------------- HTML

/**
 * 差異歸納群組。
 *
 * **每個群組的內容由 `CATEGORIES.groupOf` 推導**，不手寫分類比對——
 * 這是本檔相對國小輔導工具的改進：過去「哪個分類歸哪個群組」在 specs 與
 * filter 各寫一份，兩份不同步時不會有任何錯誤。
 *
 * 群組的**標題與提示**仍在此手寫：那是業務判讀文字，共用層無從推導。
 *
 * 匯出供測試做**孤兒守衛**（見 tests/unit/compare-session-pricing-report.test.ts）：
 * `groupOf` 拼錯時，`renderInsightGroups` 會把該分類的記錄**同時從所有群組中丟棄**
 * ——不報錯、不計數、不留痕跡。沒有這個守衛，那正是「看起來有歸納、實際少一筆」。
 */
export const INSIGHT_GROUPS = [
  {
    key: 'nonStandard',
    title: '非標準折扣明細（需人工確認，工具不代為併入折價率）',
    hint: '這些明細未含「課程費 NN折」格式，多為期中補加收或轉班補差。折價率兩邊可能完全一致，因此光看數字看不出問題；請逐筆人工核對後開單（延續 D17，工具不代為判斷哪一邊正確）。',
    variant: 'alert-warning',
  },
  {
    key: 'unparsed',
    title: '無法自動比對（需人工確認名單或報表）',
    hint: '包含報表折扣格式無法解析、班級不屬美語／數學、以及名單端無適用折扣值。這些情況下工具刻意不猜測，請人工核對。',
    variant: 'alert-warning',
  },
  {
    key: 'unpairable',
    title: '姓名無法唯一配對',
    hint: '名單中有多位同名學生，工具不猜測對應到哪一位。請改以人員代碼核對。',
    variant: 'alert-warning',
  },
  {
    key: 'notInWeb',
    title: '報表有名單已無／無學費項',
    hint: '期中離班、退費，或當期僅收雜費、商品等非學費項目而無正式學費列。',
    variant: 'alert-neutral',
  },
];

function renderInsightGroups(records, registry) {
  return INSIGHT_GROUPS
    .map((g) => {
      // 分群完全由 registry.groupOf 推導：不在此比對任何分類字面值
      const memberIds = registry.ids.filter(id => registry.groupOf[id] === g.key);
      const hits = records.filter(r => memberIds.includes(r.statusCategory));
      if (!hits.length) return '';
      const list = hits
        .map(r => `<li><strong>${escapeHtml(r.name)}</strong>（${escapeHtml(r.personCode)}${r.excel.className ? `・${escapeHtml(r.excel.className)}` : ''}）：${escapeHtml(r.note.notes.join('；'))}</li>`)
        .join('');
      return `<div class="alert ${g.variant}">
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
  const discDiff = r.web?.rateBps != null && r.excel.rateBps !== r.web.rateBps;
  const cell = (value, differs) => `<span class="${differs ? 'diff-box' : 'match-box'}">${escapeHtml(value)}</span>`;

  const notes = r.note.notes.map(n => escapeHtml(n)).join('<br>');
  const classes = r.web?.tokens?.length
    ? r.web.tokens.map(t => `<div class="class-tag">${escapeHtml(t)}</div>`).join('')
    : '<span class="muted">無報名</span>';

  const sessions = r.excel.sessions !== null ? `${r.excel.sessions} 堂課` : '—';
  const amount = r.excel.tuitionAmount !== null
    ? r.excel.tuitionAmount.toLocaleString('zh-TW')
    : '—';
  const amountNote = r.excel.amountRoute === 'non-tuition-column'
    ? '<span class="muted">取自「非學費費用」欄</span>'
    : (r.excel.amountColumnHeading ? `<span class="muted">${escapeHtml(r.excel.amountColumnHeading)}</span>` : '');

  return `
  <tr class="${isDiff ? 'row-diff' : ''}" data-cat="${r.statusCategory}">
    <td class="number">${idx + 1}</td>
    <td class="sticky-name">${escapeHtml(r.name)}</td>
    <td class="mono">${escapeHtml(r.personCode)}</td>
    <td>${escapeHtml(r.grade)}</td>
    <td>${escapeHtml(r.rateCategoryLabel)}</td>
    <td><span class="badge ${badge}">${escapeHtml(r.statusLabel)}</span></td>
    <td>${cell(bpsToLabel(r.excel.rateBps), discDiff)}</td>
    <td>${cell(bpsToLabel(r.web?.rateBps), discDiff)}</td>
    <td class="number">${escapeHtml(sessions)}<div class="muted">${escapeHtml(UNVERIFIABLE_NOTE)}</div></td>
    <td class="number">${escapeHtml(amount)}<div class="muted">${escapeHtml(UNVERIFIABLE_NOTE)}</div>${amountNote ? `<div>${amountNote}</div>` : ''}</td>
    <td>
      <div>${escapeHtml(r.excel.className ?? '-')}</div>
      <div class="class-tag">${escapeHtml(r.excel.billDate)} (${escapeHtml(r.excel.billStatus)})</div>
      ${r.excel.nonStandardDiscounts.map(d => `<div class="class-tag">非標準：${escapeHtml(d)}</div>`).join('')}
      ${r.excel.extraDiscounts.map(d => `<div class="class-tag">其他折扣：${escapeHtml(d)}</div>`).join('')}
      ${r.excel.otherItems.map(d => `<div class="class-tag">其他科目：${escapeHtml(d)}</div>`).join('')}
    </td>
    <td>${classes}</td>
    <td class="note-text ${r.note.tone === 'warn' ? 'is-warn' : ''}">${notes}</td>
  </tr>`;
}

function renderHtml(records, meta) {
  const total = records.length;
  const count = (cat) => records.filter(r => r.statusCategory === cat).length;
  const matchCount = count('MATCH');
  const discCount = count('DISCOUNT_DIFF');
  const nonStandardCount = count('NON_STANDARD_DISCOUNT');
  const unparsedCount = count('RATE_UNPARSED') + count('UNKNOWN_CLASS') + count('WEB_RATE_NOT_CONFIGURED');
  // 需人工判讀的總數（非直接比大小者），單獨一張卡，避免散在多張卡而看不出全貌
  const needsHumanCount = records.filter(r => NEEDS_HUMAN_CATEGORIES.includes(r.statusCategory)).length;
  const diffCount = total - matchCount;
  const rate = total ? ((matchCount / total) * 100).toFixed(1) : '0.0';

  // 分頁按鈕的**清單**來自 defineCategories（新增帶 tab 的分類即自動出現按鈕），
  // 這裡只補上計數文字。顯示順序由 tabOrder 決定：先看需人工確認的，再看一致。
  const tabs = CATEGORIES.tabs.map(t => ({ value: t.value, label: `${t.label} (${count(t.value)})` }));

  return renderShell({
    title: '按堂計價收費核對與財務報表比對報告',
    logoBadge: '按堂計價比對',
    description: '以每一筆學費列為單位，比對「兒童美語」與「國小數學」之**適用折扣率**。\n    按堂計價採堂數 × 單價、**無收費級距制度**，故本報告不比對天數。\n    堂數與學費金額僅為顯示值：系統端尚無對應欄位（#118），工具不做換算。\n    比對目的為找出差異並標示可能成因，不預設任一資料來源為正確。',
    meta: [
      { label: '網頁系統名單', value: `${meta.asOfDate} 米豆奶匯出` },
      { label: 'Run', value: meta.runId },
      { label: '帳務來源', value: path.basename(meta.xlsxPath) },
      { label: '規則策略', value: `${meta.ruleSetVersion} / ${meta.numericPolicy}` },
      { label: '報表工作表', value: SHEET_NAME },
      { label: '核定發單日', value: meta.billAnchorDate },
      { label: '報表金額欄位', value: meta.amountColumns },
      {
        label: '類別快照',
        value: meta.rateSource,
      },
    ],
    stats: [
      { label: '報科學費筆數', value: total, sub: '每筆學費列一筆；雙科學生會有兩筆', tone: 'plain' },
      { label: '折扣一致', value: matchCount, sub: `${rate}%`, tone: 'match' },
      { label: '差異筆數', value: diffCount, sub: '含需人工確認者', tone: 'diff' },
      { label: '折扣差異', value: discCount, sub: '報表與系統折價率不同', tone: 'diff' },
      { label: '非標準折扣', value: nonStandardCount, sub: '需人工確認', tone: 'plain' },
      { label: '需人工判讀', value: needsHumanCount, tone: 'neutral', sub: `非標準 ${nonStandardCount}・無法自動比對 ${unparsedCount}・同名 ${count('UNPAIRABLE')}・無學費 ${count('EXCEL_NO_TUITION')}` },
    ],
    insightHtml: renderInsightGroups(records, CATEGORIES),
    extraInsights: [],
    columns: [
      { key: 'name', heading: '姓名', sticky: true },
      { key: 'personCode', heading: '人員代碼' },
      { key: 'grade', heading: '年級' },
      { key: 'rateCategory', heading: '科目' },
      { key: 'status', heading: '比對結果' },
      { key: 'excelRate', heading: '報表折扣' },
      { key: 'webRate', heading: '網頁折扣' },
      { key: 'sessions', heading: '報表堂數（顯示值）' },
      { key: 'tuitionAmount', heading: '報科學費金額（顯示值）' },
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

/**
 * 走訪工作表，逐列把「該筆學費列的金額」依班名解析後存成 Map，
 * 供 compare() 依 className 取用。
 *
 * 之所以不把 worksheet 傳給 compare()：compare() 只拿到學費明細字串，
 * 拿不到「這一列的儲存格」。因此金額在**讀表階段**就依班名解析好，
 * compare() 只做查表——讓比對邏輯保持純函式、可在合成資料上測試。
 */
function collectTuitionAmounts(worksheet) {
  const headerTexts = [];
  worksheet.getRow?.(1)?.eachCell?.({ includeEmpty: true }, (cell, index) => {
    headerTexts[index - 1] = cell.text;
  });
  const columnIndex = buildColumnIndex(headerTexts);
  const amountByKey = new Map();
  const classHeadings = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = row.getCell(1).text?.trim();
    if (!name) return;
    const subject = row.getCell(7).text?.trim();
    if (subject !== REPORT_SUBJECTS.tuition) return;
    const { className } = parseSessionTuition(row.getCell(4).text?.trim());
    if (!className) return;
    if (!amountByKey.has(name)) {
      // 同名學生可能有多筆學費列，key 需含班名以免互相覆蓋
      amountByKey.set(`${name}\u0000${className}`, parseAmountColumns(columnIndex, row, className));
    }
    if (!classHeadings.includes(className)) classHeadings.push(className);
  });

  return {
    columnIndex,
    amountByKey,
    classHeadings,
    getAmount: (name, className) => amountByKey.get(`${name}\u0000${className}`)
      ?? { tuitionAmount: null, amountColumnHeading: null, amountRoute: 'none' },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.xlsx) {
    console.log('用法：npm run billing:compare:sessions -- --xlsx <財務報表.xlsx> [--out <報告.html>] [--base http://127.0.0.1:3000]');
    process.exit(args.help ? 0 : 1);
  }
  if (!fs.existsSync(args.xlsx)) throw new Error(`找不到報表檔：${args.xlsx}`);

  const outputPath = args.out || path.join(
    os.homedir(), 'Downloads',
    `按堂計價比對_${path.basename(args.xlsx, path.extname(args.xlsx))}.html`,
  );

  // §3：報告含全體學生姓名與人員代碼，屬敏感個資，不得落在專案內。
  //
  // 專案根必須由**本檔**算出：scripts/shared/ 比 scripts/ 深一層，若在共用層內
  // 寫死 '..' 會算成 web/，守衛仍會擋下 web/ 內的路徑，卻放行 repo 根下其他
  // 目錄——保護被靜默削弱且不報錯。assertProjectRoot 以哨兵檔實測此路徑。
  const projectRoot = assertProjectRoot(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  );
  assertOutputOutsideProject(projectRoot, outputPath);

  console.log('讀取報表：', args.xlsx);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(args.xlsx);
  const ws = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[0];
  const reportStudents = readMultiTuitionReport(ws, REPORT_SUBJECTS);
  const amounts = collectTuitionAmounts(ws);

  console.log(`讀取網頁資料：${args.base}`);
  const { runId, students } = await fetchRunStudents(args.base);
  const run = await fetchRun(args.base, runId);

  const asOfDate = run.asOfDate || '—';
  console.log(`報表學生 ${reportStudents.size} 名、名單學生 ${students.length} 名（run ${runId}, asOf ${asOfDate}）`);

  // issue #122：v3 run 一律帶上類別快照，讓適用率走產品讀模型的快照分支，
  // 與畫面顯示同源。`undefined`（v1／v2）代表該 run 沒有快照概念。
  // issue #140：一律經由 `buildRunSnapshotContext` 這個單一入口——不在此自行判空，
  // 否則「這行做對了」沒有任何測試盯得住（單元測試恆以顯式參數傳入 rateContext）。
  const rateContext = buildRunSnapshotContext(run);
  if (shouldWarnMissingSnapshot(run)) {
    console.warn('警告：此 run 的規則版本或類別快照不完整；本報告不以當前班名補推適用率，相關列將標示為無法判定（issue #122／#148）。');
  }

  const { records, duplicates } = compare(reportStudents, students, asOfDate, {
    getAmount: (name, className) => amounts.getAmount(name, className),
  }, rateContext);

  const billDates = [...reportStudents.values()].map(s => s.billDate).filter(Boolean).sort();
  const html = renderHtml(records, {
    runId,
    asOfDate,
    xlsxPath: args.xlsx,
    ruleSetVersion: run.ruleSetVersion || '—',
    numericPolicy: run.numericPolicy || '—',
    rateSource: rateContext?.known === false
      ? '規則版本未知：適用率不推測'
      : rateContext?.usesClassCategorySnapshot
        ? `類別快照（${Array.isArray(rateContext.classCategories) ? rateContext.classCategories.length : 0} 班，與畫面同源）`
        : '歷史 run：依凍結的歷史類別映射',
    billAnchorDate: billDates[Math.floor(billDates.length / 2)] || '—',
    duplicateNames: duplicates,
    amountColumns: amounts.classHeadings.length
      ? `${amounts.classHeadings.join('、')}、${NON_TUITION_HEADING}`
      : '（未偵測到）',
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  // 分類計數由 CATEGORIES 推導：欄位集合與順序都來自 specs，新增分類自動出現在
  // 統計中，不會漏報；鍵名走各 spec 的 summaryKey。
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

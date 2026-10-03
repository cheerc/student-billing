import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { execFileSync } from 'child_process';

/**
 * T4：第四輪瀏覽器驗收用的全合成名冊（baseline → variant）。
 *
 * 產出三個檔案：round4-baseline.xlsx、round4-variant.xlsx、manifest.json。
 * manifest 的每一筆 expected 都是**依 spec 手算**（specs/02 R06–R14、§9.4；specs/09 §4 文案表；
 * specs/04 UX78／U38／U39），不是用產品函式算出來的；`scripts/round4-fixtures.test.ts`
 * 只驗結構、可匯入與 manifest 的手算值是否與產品實際一致（不一致即失敗，藉此抓手算或產品錯誤）。
 *
 * 班名一律採名冊原文格式「班級名稱[團][optional]」（D41）；姓名與代碼皆為合成值。
 */

const HEADERS = ['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註'];
const OUT_FILES = { baseline: 'round4-baseline.xlsx', variant: 'round4-variant.xlsx', manifest: 'manifest.json' };

// 名冊原文班名（D41 真實格式）。BUS 與 UN 不存在於系統 seed 課表。
const C = '國小輔導-一A[團]';
const M = '國小數學-三A[團]';
const N = '國小數學-三B[團]';
const Q = '國小數學-二A[團]';
const HW = '國小輔導-寫功課[團]';
const BUS = '交通車[團]';
const UN = '國小數學-R4未對應[團]';

const SIB = '有兄弟姊妹折扣';
const SPECIAL = '特殊折扣85折';
const INTERNAL = '園內生';

interface Row {
  classes: string[];
  grade: string;
  tags: string[];
}

type Side = 'baseline' | 'variant';

/** 一個面板的完整可見內容：值 → 人數與勾選狀態。 */
type Panel = Record<string, { count: number; checked: boolean }>;

interface JourneyStep {
  step: number;
  action: string;
  /** 該步驟要看的欄位（grade／enrollmentKey／sibling） */
  panelField: 'grade' | 'enrollmentKey' | 'sibling';
  /** 該步驟已套用的篩選（wire 值；面板計數排除本欄，結果人數含本欄） */
  applied: Record<string, string | string[]>;
  /** UI 可見面板：未勾選的 0 人值依 UX25 隱藏；已勾選的 0 人值仍顯示且 checked=true */
  panelCounts: Panel;
  /** 按確定後的結果人數 */
  resultCount: number;
}

interface Case {
  code: string;
  tests: string;
  acceptance: string[];
  rows: { baseline?: Row | null; variant?: Row | null };
  expected: Record<string, unknown>;
  specRefs: string[];
}

/** 折扣變動列的預期畫面文字（specs/09 §4：班名原文、原本 → 現在、原因）。 */
const discountRow = (className: string, before: string, after: string, reason: string) => `${className}　${before} → ${after}　${reason}`;

const CASES: Case[] = [
  {
    code: 'R4_ADD',
    tests: '新增班：報名異動只列新增、保留班折扣變動以原文班名掛原因',
    acceptance: ['§6.1 異動明細', 'UX78'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [] }, variant: { classes: [C, M], grade: '一年級', tags: [] } },
    expected: {
      enrollmentText: ['新增 國小數學-三A[團]'],
      classDiscountText: [discountRow(C, '無折扣', '95折', '新增 國小數學-三A[團]')],
      after: { subjectCount: 2, baseDiscountBps: 9500 },
    },
    specRefs: ['specs/09 §4 報名異動／折扣變動', 'specs/02 R10（科數 1→2 → 95折）'],
  },
  {
    code: 'R4_REMOVE',
    tests: '退出班：報名異動只列退出、保留班折扣變動原因為退出',
    acceptance: ['§6.1 異動明細', 'UX78'],
    rows: { baseline: { classes: [C, M], grade: '一年級', tags: [] }, variant: { classes: [C], grade: '一年級', tags: [] } },
    expected: {
      enrollmentText: ['退出 國小數學-三A[團]'],
      classDiscountText: [discountRow(C, '95折', '無折扣', '退出 國小數學-三A[團]')],
      after: { subjectCount: 1, baseDiscountBps: 10000 },
    },
    specRefs: ['specs/09 §4', 'specs/02 R10（科數 2→1 → 無折扣）'],
  },
  {
    code: 'R4_SWITCH',
    tests: '同類一對一換班：只一行「換班」，折扣不變（兩班時段相同、同類不加分）',
    acceptance: ['§6.1 異動明細', 'UX78'],
    rows: { baseline: { classes: [C, M], grade: '一年級', tags: [] }, variant: { classes: [C, N], grade: '一年級', tags: [] } },
    expected: {
      enrollmentText: ['換班 國小數學-三A[團] → 國小數學-三B[團]'],
      classDiscountText: [],
      after: { subjectCount: 2, baseDiscountBps: 9500 },
    },
    specRefs: ['specs/09 §4 換班成對只一行', 'specs/02 R09/R03（存在性計科數，同類不加）'],
  },
  {
    code: 'R4_ADD_SAME',
    tests: '同類多一班：只列新增、折扣不變（科數仍 2）',
    acceptance: ['§6.1 異動明細'],
    rows: { baseline: { classes: [C, M], grade: '一年級', tags: [] }, variant: { classes: [C, M, N], grade: '一年級', tags: [] } },
    expected: {
      enrollmentText: ['新增 國小數學-三B[團]'],
      classDiscountText: [],
      after: { subjectCount: 2, baseDiscountBps: 9500 },
    },
    specRefs: ['specs/09 §4', 'specs/02 R09（同類多班不加科數）'],
  },
  {
    code: 'R4_NEW',
    tests: '新學生：報名異動與折扣變動皆「—」（baseline 不含此代碼 → variant 才出現）',
    acceptance: ['§6.1 異動明細', 'UX78 狀態欄'],
    rows: { baseline: null, variant: { classes: [C], grade: '一年級', tags: [] } },
    expected: { status: '新學生', enrollmentText: ['—'], classDiscountText: ['—'] },
    specRefs: ['specs/09 §4 狀態：新學生／已不在名單兩欄皆「—」'],
  },
  {
    code: 'R4_GONE',
    tests: '已不在名單：報名異動與折扣變動皆「—」',
    acceptance: ['§6.1 異動明細', 'UX78 狀態欄'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [] }, variant: null },
    expected: { status: '已不在名單', enrollmentText: ['—'], classDiscountText: ['—'] },
    specRefs: ['specs/09 §4 狀態'],
  },
  {
    code: 'R4_SIB_ADD',
    tests: '加上標籤「有兄弟姊妹折扣」：科數 1＋兄弟姊妹 = 2 → 95折',
    acceptance: ['§6.1 折扣變動原因'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [] }, variant: { classes: [C], grade: '一年級', tags: [SIB] } },
    expected: { enrollmentText: [], classDiscountText: [discountRow(C, '無折扣', '95折', '加上標籤「有兄弟姊妹折扣」')], after: { baseDiscountBps: 9500 } },
    specRefs: ['specs/02 R06／R10', 'specs/09 §4 原因文案表'],
  },
  {
    code: 'R4_SIB_REMOVE',
    tests: '移除標籤「有兄弟姊妹折扣」：95折 → 無折扣',
    acceptance: ['§6.1 折扣變動原因'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [SIB] }, variant: { classes: [C], grade: '一年級', tags: [] } },
    expected: { enrollmentText: [], classDiscountText: [discountRow(C, '95折', '無折扣', '移除標籤「有兄弟姊妹折扣」')], after: { baseDiscountBps: 10000 } },
    specRefs: ['specs/02 R06／R10', 'specs/09 §4 原因文案表'],
  },
  {
    code: 'R4_SPECIAL_ADD',
    tests: '加上標籤「特殊折扣85折」：特殊率覆蓋基本率 → 85折',
    acceptance: ['§6.1 折扣變動原因'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [] }, variant: { classes: [C], grade: '一年級', tags: [SPECIAL] } },
    expected: { enrollmentText: [], classDiscountText: [discountRow(C, '無折扣', '85折', '加上標籤「特殊折扣85折」')], after: { baseDiscountBps: 8500 } },
    specRefs: ['specs/02 R07（0.85）／R10（特殊折扣優先覆蓋）', 'specs/09 §4 原因文案表'],
  },
  {
    code: 'R4_INTERNAL_ADD',
    tests: '加上標籤「園內生」：安親適用率 max(0.9, 100%−5%) = 95折（基本率不變）',
    acceptance: ['§6.1 折扣變動原因', 'F03 課程率≠基本率'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [] }, variant: { classes: [C], grade: '一年級', tags: [INTERNAL] } },
    expected: {
      enrollmentText: [],
      classDiscountText: [discountRow(C, '無折扣', '95折', '加上標籤「園內生」')],
      after: { baseDiscountBps: 10000, applicableAnqinBps: 9500 },
    },
    specRefs: ['specs/02 R08／TA!B6 園內生 max(0.9, base−0.05)', 'specs/09 §4 原因文案表'],
  },
  {
    code: 'R4_INTERNAL_REMOVE',
    tests: '移除標籤「園內生」：安親適用率 95折 → 無折扣',
    acceptance: ['§6.1 折扣變動原因'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [INTERNAL] }, variant: { classes: [C], grade: '一年級', tags: [] } },
    expected: {
      enrollmentText: [],
      classDiscountText: [discountRow(C, '95折', '無折扣', '移除標籤「園內生」')],
      after: { baseDiscountBps: 10000, applicableAnqinBps: 10000 },
    },
    specRefs: ['specs/02 R08／TA!B6', 'specs/09 §4 原因文案表'],
  },
  {
    code: 'R4_MULTI',
    tests: '多原因並列：退出數學班＋加上特殊折扣 → 保留班 95折 → 85折，兩個原因以「、」並列',
    acceptance: ['§6.1 多個原因'],
    rows: { baseline: { classes: [C, M], grade: '一年級', tags: [] }, variant: { classes: [C], grade: '一年級', tags: [SPECIAL] } },
    expected: {
      enrollmentText: ['退出 國小數學-三A[團]'],
      classDiscountText: [discountRow(C, '95折', '85折', '退出 國小數學-三A[團]、加上標籤「特殊折扣85折」')],
      after: { baseDiscountBps: 8500 },
    },
    specRefs: ['specs/02 R07／R10', 'specs/09 §4 多個原因以「、」並列'],
  },
  {
    code: 'R4_EMPTY',
    tests: '同時新增兩個同類班：保留班折扣變動但找不到單一原因 → 「名單資料變動」',
    acceptance: ['§6.1 名單資料變動'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [] }, variant: { classes: [C, M, Q], grade: '一年級', tags: [] } },
    expected: {
      enrollmentText: ['新增 國小數學-三A[團]', '新增 國小數學-二A[團]'],
      classDiscountText: [discountRow(C, '無折扣', '95折', '名單資料變動')],
      after: { baseDiscountBps: 9500 },
    },
    specRefs: ['specs/09 §4 找不到可說明的原因 → 名單資料變動', 'specs/02 R10（科數 1→2）'],
  },
  {
    code: 'R4_NOT_CONFIG',
    tests: '未設定折扣類別的班（交通車）兩側都報名：不列入折扣變動，只有保留的輔導班列',
    acceptance: ['§6.1 折扣變動'],
    rows: { baseline: { classes: [C, BUS], grade: '一年級', tags: [] }, variant: { classes: [C, BUS], grade: '一年級', tags: [SIB] } },
    expected: {
      enrollmentText: [],
      classDiscountText: [discountRow(C, '無折扣', '95折', '加上標籤「有兄弟姊妹折扣」')],
      after: { baseDiscountBps: 9500, subjectCount: 1 },
    },
    specRefs: ['specs/09 §4 not_configured 不列', 'specs/02 R09（不列入折扣類別不計科數）'],
  },
  {
    code: 'R4_ZERO_NONE',
    tests: '零報名且無標籤：基本率 10000（無折扣）、科數 null、四課程率 null',
    acceptance: ['§6.3 無報名折扣', 'D42', 'U38'],
    rows: { baseline: { classes: [], grade: '一年級', tags: [] }, variant: { classes: [], grade: '一年級', tags: [] } },
    expected: { after: { baseDiscountBps: 10000, subjectCount: null, applicableAnqinBps: null, applicableTutoringBps: null, applicableMathBps: null, applicableEnglishBps: null } },
    specRefs: ['specs/04 U38', 'specs/02 R10（無報名科數 null → 基本率 10000）'],
  },
  {
    code: 'R4_ZERO_SPECIAL',
    tests: '零報名＋特殊折扣85折：特殊率優先 → 85折；課程率仍 null',
    acceptance: ['§6.3 無報名折扣', 'D42', 'U39'],
    rows: { baseline: { classes: [], grade: '一年級', tags: [SPECIAL] }, variant: { classes: [], grade: '一年級', tags: [SPECIAL] } },
    expected: { after: { baseDiscountBps: 8500, subjectCount: null, applicableAnqinBps: null, applicableMathBps: null } },
    specRefs: ['specs/04 U39', 'specs/02 R07／R10（特殊折扣優先）'],
  },
  {
    code: 'R4_ZERO_SIB',
    tests: '零報名＋只有兄弟姊妹標籤：仍是無折扣（10000），課程率 null',
    acceptance: ['§6.3 無報名折扣', 'D42', 'U39'],
    rows: { baseline: { classes: [], grade: '一年級', tags: [SIB] }, variant: { classes: [], grade: '一年級', tags: [SIB] } },
    expected: { after: { baseDiscountBps: 10000, subjectCount: null, applicableAnqinBps: null } },
    specRefs: ['specs/04 U39（只有兄弟姊妹仍 10000、科數 null、課程率 null）'],
  },
  {
    code: 'R4_RATE',
    tests: '課程率≠基本率：園內生輔導班基本 100% 但安親適用率 95%',
    acceptance: ['F03 課程率子項'],
    rows: { baseline: { classes: [C], grade: '一年級', tags: [INTERNAL] }, variant: { classes: [C], grade: '一年級', tags: [INTERNAL] } },
    expected: { after: { baseDiscountBps: 10000, applicableAnqinBps: 9500, subjectCount: 1 } },
    specRefs: ['specs/02 TA!B6（園內生 max(0.9, base−0.05)）'],
  },
  {
    code: 'R4_HOMEWORK',
    tests: '寫功課＋一般輔導＋數學：v3 科數 2（不減 1）、基本 95%；固定 5 天 → 安親天數 5、安親課程率 100%、寫功課本班 100%；一年級課輔不適用',
    acceptance: ['§6.3 寫功課', 'D37 第 2 點', 'D40 Q7'],
    rows: {
      baseline: { classes: [C, HW, M], grade: '一年級', tags: [] },
      variant: { classes: [C, HW, M], grade: '一年級', tags: [] },
    },
    expected: {
      after: {
        subjectCount: 2,
        baseDiscountBps: 9500,
        anqinDays: 5,
        tutoringDays: null,
        applicableAnqinBps: 10000,
        applicableTutoringBps: 10000,
      },
    },
    specRefs: ['specs/02 §9.4 固定 5 天：下限 5、安親／課輔適用率皆 100%', 'specs/02 R11／R12（年級 gate：小一只有安親）', 'specs/02 R03（v3 類別式，寫功課不計科數）'],
  },
  {
    code: 'R4_UNMAPPED',
    tests: '班名未對應課表：米豆奶班名不在系統課表 → CLASS_NOT_MAPPED 需確認、1 科、基本無折扣',
    acceptance: ['§6.3 未對應課表', 'D40 Q4'],
    rows: { baseline: { classes: [UN], grade: '一年級', tags: [] }, variant: { classes: [UN], grade: '一年級', tags: [] } },
    expected: { after: { subjectCount: 1, baseDiscountBps: 10000 }, issueCodes: ['CLASS_NOT_MAPPED'] },
    specRefs: ['specs/04 UX62', 'specs/02 R03（按類別計科數，名稱可判定即 1 科）'],
  },
  {
    code: 'R4_FACET5',
    tests: '跨欄計數素材：五年級報名國小數學-二A、無標籤（兄弟姊妹=false 的手算由 journey step 4 的 sibling 面板驗證）',
    acceptance: ['N12 跨欄計數'],
    rows: { baseline: { classes: [Q], grade: '五年級', tags: [] }, variant: { classes: [Q], grade: '五年級', tags: [] } },
    expected: { after: { grade: 5 }, enrollmentKeyWire: '國小數學-二A', siblingHandComputed: false },
    specRefs: ['specs/03 §5.1 options（各欄計數排除本欄篩選）', 'specs/04 UX25'],
  },
  {
    code: 'R4_FACET6',
    tests: '跨欄計數素材：六年級報名同班＋有兄弟姊妹折扣（與 FACET5 同班不同年級與標籤；兄弟姊妹=true 的手算由 journey step 4 驗證）',
    acceptance: ['N12 跨欄計數'],
    rows: { baseline: { classes: [Q], grade: '六年級', tags: [SIB] }, variant: { classes: [Q], grade: '六年級', tags: [SIB] } },
    expected: { after: { grade: 6 }, enrollmentKeyWire: '國小數學-二A', siblingHandComputed: true },
    specRefs: ['specs/03 §5.1', 'specs/04 UX25'],
  },
];

/**
 * 跨欄 journey（specs/03 §5.1 / specs/04 UX25 / specs/09 §5.1；D46）。
 *
 * 每一步的數值全部由上方 CASES 的名冊列**手算**，不用產品輸出當預期值：
 *  - 名冊（variant）：21 人。year 一年級 19、五年級 1（R4_FACET5）、六年級 1（R4_FACET6）。
 *  - 有兄弟姊妹標籤 4 人：3 位一年級（SIB_ADD／NOT_CONFIG／ZERO_SIB）＋ 1 位六年級（FACET6）；
 *    **五年級 0 人**（FACET5 沒有兄弟姊妹標籤）——這是 journey step 6 結果為 0 人的依據。
 *  - 學科年級 2 人都在 國小數學-二A[團]。
 *
 * 規則（UX25／D46）：
 *  - 面板計數套用**其他欄**已套用的篩選，排除該欄自身篩選；勾選後按確定的人數含該欄自身。
 *  - panelCounts 是**驗收者在畫面上實際看到的完整面板**：`{值: {count, checked}}`。
 *    未勾選的 0 人值依 UX25 隱藏（不出現在面板）；已勾選的 0 人值仍顯示且 checked=true。
 *  - resultCount 是該步驟按確定後的結果人數（套用全部條件，含本欄）。
 *  - 篩選面板的 wire 值是解析後 baseName（`國小數學-二A`，不是 rawToken `國小數學-二A[團]`；
 *    實測 rawToken 形式回 0 人，UI 選項文字就是 baseName）。
 */
const FACET_JOURNEY: JourneyStep[] = [
  {
    step: 1,
    action: '開「年級」面板（未套用任何條件）',
    panelField: 'grade',
    applied: {},
    // 一年級 19、五年級 1、六年級 1；0 人值不存在故無隱藏項。
    panelCounts: { '1': { count: 19, checked: false }, '5': { count: 1, checked: false }, '6': { count: 1, checked: false } },
    resultCount: 21,
  },
  {
    step: 2,
    action: '年級勾選「五年級」→「確定」；重開年級面板',
    panelField: 'grade',
    applied: { grade: '5' },
    // 面板排除本欄篩選 → 三個值仍顯示；已勾選的「五年級」checked=true。
    panelCounts: { '1': { count: 19, checked: false }, '5': { count: 1, checked: true }, '6': { count: 1, checked: false } },
    resultCount: 1,
  },
  {
    step: 3,
    action: '開「所屬班級」面板（已套用 grade=5）',
    panelField: 'enrollmentKey',
    applied: { grade: '5' },
    // grade=5 只剩 FACET5 一人，其班為 國小數學-二A。其餘 7 個班級值計數為 0 且未勾選 → 依 UX25 隱藏。
    panelCounts: { '國小數學-二A': { count: 1, checked: false } },
    resultCount: 1,
  },
  {
    step: 4,
    action: '年級再加勾「六年級」→ 共 2 人；開「兄弟姊妹折扣」面板',
    panelField: 'sibling',
    applied: { grade: ['5', '6'] },
    // 其他欄（grade 5、6）收斂到 FACET5（無標籤）與 FACET6（有標籤）→ 否 1、是 1。
    panelCounts: { false: { count: 1, checked: false }, true: { count: 1, checked: false } },
    resultCount: 2,
  },
  {
    step: 5,
    action: '兄弟姊妹勾選「是」→「確定」；重開年級面板',
    panelField: 'grade',
    applied: { grade: ['5', '6'], sibling: 'true' },
    // 面板排除本欄、套用 sibling=true：4 位有標籤者（3 位一年級、1 位六年級）→ 一年級 3、六年級 1。
    // 五年級 0 人但**已勾選**（本步套用 grade 5、6）→ 依 UX25 仍顯示且 checked=true。
    panelCounts: { '1': { count: 3, checked: false }, '5': { count: 0, checked: true }, '6': { count: 1, checked: true } },
    resultCount: 1,
  },
  {
    step: 6,
    action: '年級取消「六年級」（剩五年級）、兄弟姊妹仍為「是」；重開年級面板',
    panelField: 'grade',
    applied: { grade: '5', sibling: 'true' },
    // 面板排除本欄、套用 sibling=true：仍是 3 位一年級＋1 位六年級；
    // **五年級 0 人，但已勾選 → 依 UX25 仍顯示且 checked=true**（這是本步驟的驗收重點）。
    panelCounts: { '1': { count: 3, checked: false }, '5': { count: 0, checked: true }, '6': { count: 1, checked: false } },
    // 結果：五年級唯一的人（FACET5）沒有兄弟姊妹標籤 → **0 人**。
    resultCount: 0,
  },
  {
    step: 7,
    action: '取消兄弟姊妹的「是」；重開年級面板（五年級仍套用）',
    panelField: 'grade',
    applied: { grade: '5' },
    // 回到與 step 2 相同：排除本欄 → 三個值都顯示。
    panelCounts: { '1': { count: 19, checked: false }, '5': { count: 1, checked: true }, '6': { count: 1, checked: false } },
    resultCount: 1,
  },
  {
    step: 8,
    action: '取消年級的「五年級」（全不套用）；重開年級面板',
    panelField: 'grade',
    applied: {},
    panelCounts: { '1': { count: 19, checked: false }, '5': { count: 1, checked: false }, '6': { count: 1, checked: false } },
    resultCount: 21,
  },
];

function rowsFor(side: Side): string[][] {
  const rows: string[][] = [HEADERS];
  for (const item of CASES) {
    const row = item.rows[side];
    if (!row) continue;
    rows.push([item.code, `合成驗收${item.code}`, '合成分校', row.classes.join('\n'), row.grade, row.tags.join('\n'), '']);
  }
  return rows;
}

const xmlEscape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** 保形匿名 OOXML：全部 inlineStr、無 sharedStrings、無 dimension。 */
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
  const sheetRows = rows
    .map((row, index) => `<row r="${index + 1}">${row.map((value, column) => `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`).join('')}</row>`)
    .join('');
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
    console.log(
      `用法：npx tsx scripts/round4-fixtures.ts [--out <repo 外的新目錄>]\n輸出：${OUT_FILES.baseline}、${OUT_FILES.variant}、${OUT_FILES.manifest}（全合成；預期皆由 spec 手算，不以產品輸出回填）`
    );
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1])) throw new Error('請使用 --out <repo 外的新目錄>，或 --help 查看說明');
  const out = resolvedTarget(args[1] ?? path.join(os.homedir(), 'Downloads/student-billing-round4-fixtures'));
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const commonGitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  const sourceRepo = fs.realpathSync(path.dirname(commonGitDir));
  const inRepo = [repo, sourceRepo].some((root) => {
    const relative = path.relative(root, out);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (inRepo || out.split(path.sep).includes('data')) throw new Error('輸出不可在 repo／data 內；請用 --out 指定 repo 外的新目錄');
  const paths = [OUT_FILES.baseline, OUT_FILES.variant, OUT_FILES.manifest].map((file) => path.join(out, file));
  if (paths.some((file) => fs.existsSync(file))) throw new Error('目標已有驗收檔，不覆寫；請用 --out 指定另一個新目錄');
  fs.mkdirSync(out, { recursive: true });
  const rosterCount = (side: Side) => CASES.filter((item) => Boolean(item.rows[side])).length;
  for (const side of ['baseline', 'variant'] as const) {
    fs.writeFileSync(path.join(out, OUT_FILES[side]), await workbook(rowsFor(side)), { flag: 'wx' });
    console.log(`${OUT_FILES[side]}：${rosterCount(side)} 人（全合成）；${path.join(out, OUT_FILES[side])}`);
  }
  // 預期來自上方逐列手算（spec 出處見 specRefs），不以產品 parser／calculator 輸出產生摘要。
  // 兩份名冊人數不同：R4_NEW 只在 variant、R4_GONE 只在 baseline。
  const manifest = {
    synthetic: true,
    students: { baseline: rosterCount('baseline'), variant: rosterCount('variant'), cases: CASES.length },
    classNames: { care: C, mathA: M, mathB: N, math2A: Q, homework: HW, notConfigured: BUS, unmapped: UN },
    files: OUT_FILES,
    cases: CASES.map((item) => ({
      code: item.code,
      tests: item.tests,
      acceptance: item.acceptance,
      baselineRow: item.rows.baseline ?? null,
      variantRow: item.rows.variant ?? null,
      expected: item.expected,
      specRefs: item.specRefs,
    })),
    facetJourney: FACET_JOURNEY,
  };
  fs.writeFileSync(path.join(out, OUT_FILES.manifest), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(`摘要：${path.join(out, OUT_FILES.manifest)}；baseline ${rosterCount('baseline')} 人／variant ${rosterCount('variant')} 人（案例 ${CASES.length}）；R4_NEW 只在 variant、R4_GONE 只在 baseline`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { VISIBILITY_EXEMPTIONS } from './e2e-conventions-exemptions';

/**
 * E2E 入口慣例守門（Issue #188 Phase 1）。
 *
 * 背景：D61 Phase 3 把課表改成「一頁籤一張表」後，預設安親頁籤不再有 `input.input-time`，
 * 而舊 spec 仍以「89 列平鋪大表 + `.schedule-table tbody tr` nth(n)」假設列序，
 * 造成 nightly 一次 19 檔／53 案例全紅。這已是同型失敗的第五次，因此把「怎麼進課表、
 * 怎麼取得某班的排課列」凝結成靜態斷言：下一次版面改動至少會在單元測試先紅。
 *
 * 本檔**只做三件事**（純字串掃描，不啟動瀏覽器）：
 * (a) 已淘汰的字面不得再出現：`data-category-select`、`schedule-table-non-care`、
 *     以列序定位排課列（`.schedule-table tbody tr').nth(`／`").nth(`，單雙引號皆擋）；
 * (b) spec 若直接觸碰受管輸入框（`input.input-time`／`input.input-weekday`），
 *     必須 import 一個 row helper，且不得用**頁面級** locator 取第一個相符元素；
 * (c) `startInput` 的**形狀**：必須 async、經 `classRow(page, className)` 定位、回傳前
 *     呼叫 `toBeVisible`（R-191-3 的契約）。
 *
 * 本檔**不證明**的事（實測結論，不要誤讀成更強的保證）：
 * - 不證明 helper 真的能操作畫面，也不保證 helper 自身不迴歸：把 `startInput` 改回
 *   「全表第一個時段」時，12 檔改用 helper 的 spec 仍全綠（PR #191 §TDD.5 的 M2）；
 *   (c) 只守得住那句話的形狀，守不住它的行為。
 * - 不阻止已 import helper 的 spec 另外寫 raw selector；除了頁面級 `input.input-*` 之外
 *   的變體（例如自建 `rowOf`）只能靠 E2E 本身與 review。
 * - 例外清單集中在 `e2e-conventions-exemptions.ts`，每一筆都必須寫理由；沒有理由的例外不得加入。
 */

const E2E_DIR = path.resolve(__dirname, '../e2e');
const FULL_E2E = path.resolve(__dirname, '../../scripts/e2e-full.mjs');
/** #189 D62 新增 class-name-sync.spec.ts（50）；每次增刪 spec 都要同步更新，守門才會發現漏掃。 */
const SPEC_COUNT = 50;

/** 已由 D61 淘汰的選取器與「以列序定位排課列」的寫法：全 repo 不應再有 spec 依賴。 */
const OBSOLETE_LITERALS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /data-category-select/, why: 'D61 起類別欄改為 YesNoRadioGroup（無 select 元素）' },
  { pattern: /schedule-table-non-care/, why: 'D61 起一頁籤一張表，已無 non-care 總表' },
  {
    pattern: /\.schedule-table tbody tr['"]\)\.nth\(/,
    why: '排課列必須以班名經 classRow() 定位；tbody 列序隨頁籤與篩選變動',
  },
];

/**
 * 受管輸入框：只存在於有排課列的頁籤（預設安親頁籤沒有）。
 * 直接用它定位等於假設「現在剛好停在對的頁籤」，正是這次 19 檔全紅的成因。
 */
const MANAGED_INPUT = /input\.input-(?:time|weekday)/;

/**
 * 頁面級（非某列）locator 直接取「第一個／第 n 個」受管輸入框，
 * 例如 `page.locator('input.input-time').first()`：這正是 D61 後失敗的寫法，
 * 因為「第一個」取決於目前停在哪個頁籤（安親頁籤一個都沒有）。
 * 以 `evaluateAll` 掃全表再按班名挑列不算在內——那不依賴列序。
 */
const PAGE_FIRST_MANAGED_INPUT =
  /\b(?:page|p)\.locator\(\s*[`'"][^`'"\n]*input\.input-(?:time|weekday)[`'"]\s*\)\s*\.(?:first|last|nth)\(/;

const ROW_HELPER_NAMES = [
  'classRow',
  'classRows',
  'ensureClassTypeTab',
  'openClassSchedule',
  'openClassScheduleFull',
  'openClassScheduleViaHome',
  'startInput',
];

const specFiles = fs.readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts')).sort();
const read = (file: string) => fs.readFileSync(path.join(E2E_DIR, file), 'utf-8');

/** 從 `import { ... } from './helpers/<module>'` 取出匯入的識別字（含 `as` 別名前的原名）。 */
function importedNames(source: string, module: string): string[] {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]\\./helpers/${module}['"];`, 'g');
  const names: string[] = [];
  for (const match of source.matchAll(re)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function rowHelpersImported(source: string): string[] {
  return [...importedNames(source, 'c-batch'), ...importedNames(source, 'd2c-settings')].filter((n) =>
    ROW_HELPER_NAMES.includes(n)
  );
}

/** 例外清單的檔案名必須真的存在，否則「這條規則已處理」會變成空話。 */
const knownSpecs = new Set(specFiles);
const exemptionRows = Object.entries(VISIBILITY_EXEMPTIONS);

describe('E2E 慣例：排課列一律經 helper，不以列序或淘汰選取器定位', () => {
  it('spec 盤點仍為 50 檔（與 scripts/e2e-full.mjs 的動態掃描一致）', () => {
    expect(specFiles).toHaveLength(SPEC_COUNT);
    // 守門若不是掃到真的目錄會空轉，先確定 full runner 掃的是同一個目錄
    expect(fs.readFileSync(FULL_E2E, 'utf-8')).toContain("tests/e2e");
  });

  it('例外清單只指向真實存在的 spec，且每一筆都有理由', () => {
    expect(exemptionRows.length).toBeGreaterThan(0);
    for (const [file, exemption] of exemptionRows) {
      expect(knownSpecs.has(file), `例外清單指向不存在的 spec：${file}`).toBe(true);
      expect(exemption.reason.trim().length, `例外 ${file} 沒有寫理由`).toBeGreaterThan(10);
    }
  });

  // 例外必須「現在」還需要：Phase 2 修好某檔後若忘了刪例外，
  // 該檔未來的同型回歸會在守門測試裡靜默通過，所以這裡反向要求例外仍被用到。
  it.each(exemptionRows)('%s：例外條目仍被實際使用（收斂後必須移除）', (file, exemption) => {
    expect(knownSpecs.has(file), `例外清單指向不存在的 spec：${file}`).toBe(true);
    const source = read(file);
    for (const re of exemption.literals ?? []) {
      expect(source, `例外已不需要（${file} 不再出現 ${re}）；請刪除 e2e-conventions-exemptions.ts 的條目`).toMatch(re);
    }
    if (exemption.managedInputWithoutHelper) {
      // (a) 該 spec 仍未 import row helper；若已 import，例外失效。
      expect(
        rowHelpersImported(source),
        `例外已不需要（${file} 已改用 helper）；請刪除 e2e-conventions-exemptions.ts 的條目`
      ).toHaveLength(0);
      // (b) 該 spec 仍直接觸碰受管輸入框；若已不再觸碰，例外同樣失效。
      expect(
        source,
        `例外已不需要（${file} 已不再觸碰 input.input-time／input.input-weekday）；請刪除 e2e-conventions-exemptions.ts 的條目`
      ).toMatch(MANAGED_INPUT);
    }
  });

  it.each(specFiles)('%s：不使用已淘汰的選取器／列序定位', (file) => {
    const source = read(file);
    for (const { pattern, why } of OBSOLETE_LITERALS) {
      if (VISIBILITY_EXEMPTIONS[file]?.literals?.some((re) => re.source === pattern.source)) continue;
      expect(source, `${file} 仍出現 ${pattern}：${why}`).not.toMatch(pattern);
    }
  });

  it.each(specFiles)('%s：不得以頁面級 locator 取「第一個」受管輸入框', (file) => {
    const source = read(file);
    if (!PAGE_FIRST_MANAGED_INPUT.test(source)) return;
    if (VISIBILITY_EXEMPTIONS[file]?.managedInputWithoutHelper) return;
    const offender = source.split('\n').find((line) => PAGE_FIRST_MANAGED_INPUT.test(line))?.trim();
    expect.fail(
      `${file} 以頁面級 locator 取受管輸入框（${offender}）；` +
        `請改用 classRow／classRows／ensureClassTypeTab 取得班列，或 openClassSchedule／startInput。`
    );
  });

  it.each(specFiles)('%s：觸碰時段輸入框時經 helper 取得排課列', (file) => {
    const source = read(file);
    if (!MANAGED_INPUT.test(source)) return;
    if (VISIBILITY_EXEMPTIONS[file]?.managedInputWithoutHelper) return;
    expect(
      rowHelpersImported(source),
      `${file} 直接使用時段輸入框，但未 import ${ROW_HELPER_NAMES.join('／')} 之一`
    ).not.toHaveLength(0);
  });

  /**
   * helper 契約（R-191-3）：靜態掃描抓不到 helper 的 runtime 行為，但可以守住它的**形狀**：
   * `startInput` 必須是 async、必須經 `classRow(page, className)` 定位、且回傳前呼叫
   * `toBeVisible`。少了任一項，「spec 停在錯頁籤就失敗」的保證就消失了（M2 的成因）。
   */
  it('startInput 回傳前斷言目標班列可見（R-191-3）', () => {
    const source = fs.readFileSync(path.join(E2E_DIR, 'helpers/c-batch.ts'), 'utf-8');
    const fn = source.match(/export async function startInput\([\s\S]*?\n}/)?.[0] ?? '';
    expect(fn, 'helpers/c-batch.ts 找不到 `export async function startInput(...) { ... }`').not.toBe('');
    expect(fn, 'startInput 必須先以 classRow(page, className) 取得該班列').toMatch(/classRow\(page,\s*className\)/);
    expect(fn, 'startInput 必須在回傳 locator 前斷言該班列可見').toMatch(/toBeVisible\(/);
  });
});

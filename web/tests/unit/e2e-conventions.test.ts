import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { VISIBILITY_EXEMPTIONS } from './e2e-conventions-exemptions';

/**
 * E2E 入口慣例守門（Issue #188 Phase 1）。
 *
 * 背景：D61 Phase 3 把課表改成「一頁籤一張表」後，預設安親頁籤不再有 `input.input-time`，
 * 而舊 spec 仍以「89 列平鋪大表 + 《.schedule-table tbody tr》nth(n)」假設列序，
 * 造成 nightly 一次 19 檔／53 案例全紅。這已是同型失敗的第五次，因此把「怎麼進課表、
 * 怎麼取得某班的排課列」凝結成靜態斷言：下一次版面改動至少會在單元測試先紅。
 *
 * 本檔證明力的界線（不要誤讀）：
 * - 只讀原始碼字串，不啟動瀏覽器。它證明「spec 不再自拼頁籤切換與列序定位」，
 *   **不**證明 helper 真的能操作畫面——那是 13 支 spec 的責任。
 * - 例外清單集中在 `e2e-conventions-exemptions.ts`，每一筆都必須寫理由；沒有理由的例外不得加入。
 */

const E2E_DIR = path.resolve(__dirname, '../e2e');
const FULL_E2E = path.resolve(__dirname, '../../scripts/e2e-full.mjs');
const SPEC_COUNT = 49;

/** 已由 D61 淘汰的選取器與「以列序定位排課列」的寫法：全 repo 不應再有 spec 依賴。 */
const OBSOLETE_LITERALS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /data-category-select/, why: 'D61 起類別欄改為 YesNoRadioGroup（無 select 元素）' },
  { pattern: /schedule-table-non-care/, why: 'D61 起一頁籤一張表，已無 non-care 總表' },
  {
    pattern: /\.schedule-table tbody tr'\)\.nth\(/,
    why: '排課列必須以班名經 classRow() 定位；tbody 列序隨頁籤與篩選變動',
  },
];

/**
 * 直接觸碰時段／星期輸入框的 spec 必須經 helper 取得列，否則無法保證落在正確頁籤的班級。
 * 白名單：`schedule-add-placeholder-row.spec.ts` 測「新班尚未有時間」，
 * 該班還不存在於 `?class=` 深連結與 classRow 的 seed 假設，只能以本地 `rowOf` 建立列。
 */
const ROW_HELPER_NAMES = [
  'classRow',
  'classRows',
  'ensureClassTypeTab',
  'openClassSchedule',
  'openClassScheduleFull',
  'openClassScheduleViaHome',
  'startInput',
];
const ROW_HELPER_ALLOWLIST = new Set(['schedule-add-placeholder-row.spec.ts']);

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
  it('spec 盤點仍為 49 檔（與 scripts/e2e-full.mjs 的動態掃描一致）', () => {
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
    if (exemption.rowHelper) {
      expect(rowHelpersImported(source), `例外已不需要（${file} 已改用 helper）；請刪除例外條目`).toHaveLength(0);
    }
  });

  it.each(specFiles)('%s：不使用已淘汰的選取器／列序定位', (file) => {
    const source = read(file);
    for (const { pattern, why } of OBSOLETE_LITERALS) {
      if (VISIBILITY_EXEMPTIONS[file]?.literals?.some((re) => re.source === pattern.source)) continue;
      expect(source, `${file} 仍出現 ${pattern}：${why}`).not.toMatch(pattern);
    }
  });

  it.each(specFiles.filter((f) => !ROW_HELPER_ALLOWLIST.has(f)))(
    '%s：觸碰時段輸入框時經 helper 取得排課列',
    (file) => {
      const source = read(file);
      if (!/input\.input-time|input\.input-weekday/.test(source)) return;
      if (VISIBILITY_EXEMPTIONS[file]?.rowHelper) return;
      expect(
        rowHelpersImported(source),
        `${file} 直接使用時段輸入框，但未 import ${ROW_HELPER_NAMES.join('／')} 之一`
      ).not.toHaveLength(0);
    }
  );
});

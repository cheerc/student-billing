import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadModule } from '../helpers/d1-test-kit';
import {
  effectiveCategoryOf,
  resolveClassEnrollment,
  type ClassCategory,
  type ClassSettingLookup,
} from '@/domain/classification/class-category';

/**
 * 類別判定（`@/domain/classification/class-category`）。
 *
 * **本檔在 #157 PR-1 由「班名自動偵測」改寫為「未設定語意」的守門測試。**
 * 原檔（D1，specs/11 §3 D1、04 §8 UX43）以 33 筆班名 × 偵測結果的表格鎖定
 * `detectClassCategory`／`detectClassAttributes`；`specs/06` D53 Ruling 1 已廢除整組自動偵測
 * （Issue #157 Expected Outcome 第 3 條：「兩個選項的預設值皆由使用者決定，班名不參與判定」），
 * 因此該份表格描述的是**已被撤回的契約**，不能留下來當守門測試。
 *
 * 改寫後的守門目標（expected 依 D53 條文獨立手算）：
 *   1. 模組存在，值域含 `unset`（Ruling 2），且**不再匯出**任何班名偵測函式（Ruling 1）。
 *   2. 未指定類別 → `unset`／`unset`；未指定來源 → `unset`；舊 `auto` 來源 → `unset`（Ruling 5）。
 *   3. 只有 `manual` 才是使用者的決定（Ruling 4）。
 *   4. 四種舊制會被判定成不同類別的班名，現在一律未設定——這正是 Ruling 1 的可觀察後果。
 *   5. 架構約束：模組仍是 domain 純函式，importers 集合固定（防止無授權依賴漫延）。
 */

const MODULE = '@/domain/classification/class-category';

/** Ruling 1 撤回的兩個匯出；模組必須不再提供任何「依班名判定」的入口。 */
interface WithdrawnDetection {
  detectClassCategory?: unknown;
  detectClassAttributes?: unknown;
}

/**
 * 四種在 #157 之前會被自動偵測成不同類別的**非 seed 班名**。
 * （seed 班的未指定情況改適用 seed 基準，見 issue-157-seed-category-fallback.test.ts。）
 */
const PREVIOUSLY_DETECTED: Array<[string, ClassCategory]> = [
  ['合成自建班-甲', 'care'],
  ['合成自建班-乙', 'math'],
  ['合成自建班-丙', 'english'],
  ['交通車-東區', 'none'],
];

describe('類別判定模組（#157 改寫：未設定語意）', () => {
  it('模組存在；不再匯出 detectClassCategory／detectClassAttributes（#157 Ruling 1）', async () => {
    const mod = await loadModule<WithdrawnDetection>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    expect(mod!.detectClassCategory).toBeUndefined();
    expect(mod!.detectClassAttributes).toBeUndefined();
  });

  it.each(PREVIOUSLY_DETECTED)(
    '「%s」未指定類別 → unset（舊制會偵測為 %s；#157 Ruling 1 起班名不參與判定）',
    async (name) => {
      const mod = await loadModule<{ resolveClassEnrollment: typeof resolveClassEnrollment }>(MODULE);
      const r = mod!.resolveClassEnrollment(
        { rawToken: `${name}[團]`, baseName: name },
        undefined,
        new Map<string, ClassSettingLookup>([[name, {}]])
      );
      expect(r.category).toBe('unset');
      expect(r.categorySource).toBe('unset');
    }
  );

  it('seed 班未指定類別 → 套用 seed 基準，來源標記為 seed（不是使用者的決定）', async () => {
    const mod = await loadModule<{ resolveClassEnrollment: typeof resolveClassEnrollment }>(MODULE);
    const r = mod!.resolveClassEnrollment(
      { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
      undefined,
      new Map<string, ClassSettingLookup>([['國小數學-四A', {}]])
    );
    expect(r.category).toBe('math');
    expect(r.categorySource).toBe('seed');
  });

  it('純函式：同一輸入多次呼叫結果相同、不依賴呼叫順序', () => {
    const run = (name: string) =>
      resolveClassEnrollment({ rawToken: name, baseName: name }, undefined, new Map([[name, {}]]));
    const forward = PREVIOUSLY_DETECTED.map(([n]) => run(n));
    const backward = [...PREVIOUSLY_DETECTED].reverse().map(([n]) => run(n)).reverse();
    expect(backward).toEqual(forward);
  });
});

describe('Ruling 4／5：來源狀態為 manual／seed／unset', () => {
  const NON_SEED = '合成自建班-甲';

  it('manual 且類別有值 → 保留該類別與來源', () => {
    expect(effectiveCategoryOf(NON_SEED, { category: 'math', categorySource: 'manual' })).toEqual({
      category: 'math',
      categorySource: 'manual',
    });
  });

  it('缺類別 → unset；缺來源 → unset；舊 auto 來源 → unset（不得升格為使用者決定）', () => {
    expect(effectiveCategoryOf(NON_SEED, {})).toEqual({ category: 'unset', categorySource: 'unset' });
    expect(effectiveCategoryOf(NON_SEED, { category: 'math' })).toEqual({
      category: 'unset',
      categorySource: 'unset',
    });
    expect(effectiveCategoryOf(NON_SEED, { category: 'math', categorySource: 'unset' })).toEqual({
      category: 'unset',
      categorySource: 'unset',
    });
    // Ruling 5：舊資料的系統推導值不是使用者的確認
    expect(effectiveCategoryOf(NON_SEED, { category: 'math', categorySource: 'auto' })).toEqual({
      category: 'unset',
      categorySource: 'unset',
    });
  });

  it('使用者可以明確選擇 none 與 unset（兩者是不同狀態）', () => {
    expect(effectiveCategoryOf(NON_SEED, { category: 'none', categorySource: 'manual' })).toEqual({
      category: 'none',
      categorySource: 'manual',
    });
    // 選回「（未設定）」＝撤回決定
    expect(effectiveCategoryOf(NON_SEED, { category: 'unset', categorySource: 'unset' })).toEqual({
      category: 'unset',
      categorySource: 'unset',
    });
  });

  it('seed 基準：未指定的 seed 班取得 seed 類別，來源為 seed；使用者撤回則維持 unset', () => {
    // 未指定 → seed 基準
    expect(effectiveCategoryOf('國小數學-四A', {})).toEqual({
      category: 'math',
      categorySource: 'seed',
    });
    // 使用者明確撤回 → 維持 unset，**不得**被 seed 基準還原
    expect(effectiveCategoryOf('國小數學-四A', { category: 'unset', categorySource: 'unset' })).toEqual({
      category: 'unset',
      categorySource: 'unset',
    });
    // 使用者的決定優先於 seed 基準
    expect(effectiveCategoryOf('國小數學-四A', { category: 'none', categorySource: 'manual' })).toEqual({
      category: 'none',
      categorySource: 'manual',
    });
  });
});

describe('class-category 純函式架構約束', () => {
  const SRC = path.resolve(__dirname, '../../src');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('模組檔存在於 domain 層（src/domain/classification/class-category.ts）', () => {
    expect(fs.existsSync(path.join(SRC, 'domain', 'classification', 'class-category.ts'))).toBe(true);
  });

  it('src 內 importers 恰為這十個檔案；模組本身不 import DB 或 UI', () => {
    const own = path.join(SRC, 'domain', 'classification', 'class-category.ts');
    const importers: string[] = [];
    for (const file of walk(SRC)) {
      if (file === own) continue;
      if (/classification\/class-category/.test(fs.readFileSync(file, 'utf-8'))) importers.push(path.relative(SRC, file));
    }
    // R2-4: 接線後的精確 importers 斷言，防止無授權依賴漫延。
    // Round3 PR-1（spike §B4）：異動明細（roster-changes.ts）也讀取此模組，讓 before 側與 run 端**同源**解析類別。
    // D61：schedule-grid.tsx 廢除五態下拉改為是／否單選後，不再依賴 class-category。
    // #81：Excel 匯入把白話標籤對回內部類別值（含 #157 的「（未設定）」）。
    // #157：`domain/billing/discount-rules.ts` 的科數計算也吃這個值域的型別。
    // #148：主畫面摘要與名冊讀取依固定類別契約處理 v4 semantics。
    expect(importers.sort()).toEqual([
      'adapters/xlsx/schedule-table-io.ts',
      'application/calculate-run.ts',
      'application/roster-changes.ts',
      'application/roster-query.ts',
      'components/settings-editor.tsx',
      'contracts/settings.ts',
      'domain/billing/billing-calculator.ts',
      'domain/billing/discount-rules.ts',
    ].sort());

    // 模組自身：domain 純函式，不得引用 adapters／application／components
    const text = fs.readFileSync(own, 'utf-8');
    expect(text).not.toMatch(/from\s+['"][^'"]*(adapters|application|components|next|react)[^'"]*['"]/);
  });
});

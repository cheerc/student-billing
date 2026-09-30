import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as settingsRepo from '@/adapters/sqlite/settings-repository';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';

/**
 * D1 F-11（specs/11 §3 D1、04 §8 UX41；S manifest §3.1、§A F-11）：
 * 已存設定 JSON 只有一個讀取入口 `readStoredDraft`。
 *
 * 動機：8961c03 有 7 處 `JSON.parse(x.contentJson) as SettingsDraft`，全部繞過 zod；D2 在班級設定新增欄位後，
 * 舊 JSON 沒有這些欄位，而 `.default()` 不會套用在這種讀取上，各讀取點會各自處理「欄位缺失」。
 * D1 先收斂成單一入口；版本界線規則（寫入 03）：
 *   1. v1／v2 的計算與讀取永遠不讀新欄位；
 *   2. 缺欄位＝自動偵測，只在 v3 讀取當下解析，不回寫舊快照；
 *   3. 新快照一律寫出完整欄位；
 *   4. v3 run 建立時把「實際採用的類別」寫入 run_class_categories，之後不再重新偵測。
 * D1 的 readStoredDraft 因此是「不改形狀」的讀取：不補預設、不去除未知欄位、不改變欄位順序——
 * 否則 deductions 回傳的 draftHash（＝sha256(JSON.stringify(draft))）會與 D1 前不同。
 */

const repo = settingsRepo as unknown as Record<string, unknown>;

describe('readStoredDraft', () => {
  it('新增於 settings-repository，為函式', () => {
    expect(typeof repo.readStoredDraft, 'readStoredDraft 需由 settings-repository 匯出').toBe('function');
  });

  it('不改形狀：與 JSON.parse 逐位元相同（欄位順序、未知欄位、缺少的欄位都原樣保留，不補預設）', () => {
    const read = repo.readStoredDraft as (json: string) => unknown;
    expect(typeof read).toBe('function');
    // 刻意亂序、含 D2 之後才會出現的欄位（category）、且第二個班缺 active／teacher／sessions
    const stored = JSON.stringify({
      effectiveTo: null,
      careWindows: { tutoring: { endMinutes: 1170, startMinutes: 990 }, anqin: { endMinutes: 960, startMinutes: 780 } },
      classes: [
        { sessions: [{ weekday: '一', endMinutes: 1080, startMinutes: 990 }], baseName: '國小數學-X', subject: '國小數學', category: 'math', active: true, teacher: null },
        { baseName: '國小輔導-Y', subject: '國小輔導' },
      ],
      aliases: [],
      effectiveFrom: null,
    });
    const got = read(stored);
    expect(got).toEqual(JSON.parse(stored));
    expect(JSON.stringify(got)).toBe(JSON.stringify(JSON.parse(stored)));
    // 沒有補預設
    expect((got as { classes: Array<Record<string, unknown>> }).classes[1]).toEqual({ baseName: '國小輔導-Y', subject: '國小輔導' });
  });

  it('seed 全量草稿往返後 hashSettingsDraft 不變', () => {
    const read = repo.readStoredDraft as (json: string) => ReturnType<typeof buildSeedDraft>;
    expect(typeof read).toBe('function');
    const seed = buildSeedDraft();
    expect(settingsRepo.hashSettingsDraft(read(JSON.stringify(seed)))).toBe(settingsRepo.hashSettingsDraft(seed));
  });

  it('無效 JSON 與原本一致：拋出 SyntaxError（不吞錯、不回預設）', () => {
    const read = repo.readStoredDraft as (json: string) => unknown;
    expect(typeof read).toBe('function');
    expect(() => read('{not json')).toThrow(SyntaxError);
  });
});

describe('單一入口：src 內不再有直接 JSON.parse(…contentJson…)', () => {
  const SRC = path.resolve(__dirname, '../../src');
  const DEFINITION_SITE = path.join('adapters', 'sqlite', 'settings-repository.ts');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('掃描 src：除了 readStoredDraft 的定義處，沒有任何檔案直接 JSON.parse 已存設定的 contentJson', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(DEFINITION_SITE)) continue;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (/JSON\.parse\(\s*[^)]*contentJson[^)]*\)/.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders, '這些位置仍直接解析已存設定 JSON').toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  SEED_BASE_NAMES,
  classifyErpDualTrack,
  buildDynamicCandidates,
  type CandidateCounts,
} from '@/domain/schedules/seed-manifest';

/** I19 固定樣本之 12 個待設定 baseName（specs/04 I19 :137 列舉） */
const I19_UNMATCHED_12 = [
  '交通車',
  '小六國文加強班',
  '小六數學加強班',
  '小六英文加強班',
  '正音A班',
  '正音B班',
  '國小輔導-寫功課',
  '國小輔導-四年級A',
  '國小輔導-四年級B',
  '國小數學-一',
  '國小國語文-小三四',
  '美語等班',
];

function countsFixture(): CandidateCounts {
  const m = new Map<string, { studentCount: number; tokenCount: number }>();
  for (const b of I19_UNMATCHED_12) {
    m.set(b, { studentCount: 5, tokenCount: 7 });
  }
  // D18 組真實口徑：13 去重人數
  m.set('國小數學-一', { studentCount: 13, tokenCount: 13 });
  return m;
}

describe('D32-C: 動態候選引擎（RED）', () => {
  it('1. 12 個待設定全數進候選，42 個對齊不進', () => {
    const dual = classifyErpDualTrack(
      [...I19_UNMATCHED_12, ...SEED_BASE_NAMES.slice(0, 42)],
      SEED_BASE_NAMES,
      [],
      countsFixture()
    );
    expect(dual.activeView.unmatchedCount).toBe(12);
    expect(dual.candidates.length).toBe(12);
    for (const b of I19_UNMATCHED_12) {
      expect(dual.candidates.some((c) => c.rawBaseName === b)).toBe(true);
    }
    for (const b of SEED_BASE_NAMES.slice(0, 42)) {
      expect(dual.candidates.some((c) => c.rawBaseName === b)).toBe(false);
    }
  });

  it('2. 已 alias 覆蓋之 rawBaseName 不進候選', () => {
    const dual = classifyErpDualTrack(
      [...I19_UNMATCHED_12],
      SEED_BASE_NAMES,
      [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }],
      countsFixture()
    );
    expect(dual.activeView.unmatchedCount).toBe(11);
    expect(dual.candidates.some((c) => c.rawBaseName === '國小數學-一')).toBe(false);
    expect(dual.candidates.length).toBe(11);
  });

  it('3. 對齊消失（改名對齊）自動消失：raw 已在 active 即隱藏', () => {
    const activeClasses = SEED_BASE_NAMES.map((n) =>
      n === '小六加強班-國文' ? '小六國文加強班' : n
    );
    const dual = classifyErpDualTrack(
      [...I19_UNMATCHED_12],
      activeClasses,
      [],
      countsFixture()
    );
    expect(dual.candidates.some((c) => c.rawBaseName === '小六國文加強班')).toBe(false);
    expect(dual.candidates.length).toBe(11);
  });

  it('4. 候選行攜去重人數＋筆數，建議目標留空，reason 無寫死數字', () => {
    const rows = buildDynamicCandidates(
      [...I19_UNMATCHED_12],
      countsFixture(),
      new Set(SEED_BASE_NAMES)
    );
    const d18 = rows.find((r) => r.rawBaseName === '國小數學-一');
    expect(d18).toBeDefined();
    expect(d18?.studentCount).toBe(13);
    expect(d18?.tokenCount).toBe(13);
    for (const r of rows) {
      expect(r.suggestedTarget).toBe('');
      expect(r.reason).not.toMatch(/\d+\s*人/);
      expect(r.reason).not.toMatch(/mismatch/i);
    }
  });

  it('5. 引擎為純函式：不建立 alias、不改 active 設定（凍結輸入）', () => {
    const unmatched = [...I19_UNMATCHED_12];
    const counts = countsFixture();
    const activeSet = new Set(SEED_BASE_NAMES);
    const frozenActive = new Set(activeSet);
    Object.freeze(unmatched);
    const rows = buildDynamicCandidates(unmatched, counts, activeSet);
    expect(rows.length).toBe(12);
    // 輸入集合保持不變（以凍結快照比對）
    expect(activeSet).toEqual(frozenActive);
  });

  it('6. seedInventory 錨點不受引擎影響（I19 盤點語義凍結）', () => {
    const dual = classifyErpDualTrack(
      [...I19_UNMATCHED_12, ...SEED_BASE_NAMES.slice(0, 42)],
      SEED_BASE_NAMES,
      [],
      countsFixture()
    );
    // seed 側：42 對齊中 30 個在 seed 內…此處僅斷言引擎不污染 seedInventory 結構
    expect(dual.seedInventory.ambiguousCount).toBe(0);
    expect(dual.seedInventory.seedNotAppearedCount).toBeGreaterThanOrEqual(0);
  });
});

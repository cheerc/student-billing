import { describe, it, expect } from 'vitest';
import { buildDynamicCandidates, type CandidateCounts } from '@/domain/schedules/seed-manifest';
import type { ClassNameMatchReport } from '@/application/class-name-match-report';

/**
 * **characterization（非本功能的 RED）**：本檔只 import 並呼叫既有的 `buildDynamicCandidates`，
 * 純函式在 base `020e6c5` 上本來就是綠的，無法區分本 PR 與 base 的行為差異。
 * 它鎖住的是「rosterOnly → 候選清單」的形狀／計數／排序契約（單一權威來源不迴退），
 * 本功能真正的行為覆蓋與 RED 證據在 `web/tests/e2e/round3-mapping-candidates-sync.spec.ts`。
 */
describe('N09: SettingsEditor 候選清單與班名比對報告同步（UX70／issue #55）', () => {
  it('1. 從報告之 rosterOnly 組裝之動態候選集合與 counts 一致，且嚴格按 rawBaseName 字典序升冪排序', () => {
    const reportRosterOnly = [
      { baseName: '美語等班', students: 5, tokens: 7 },
      { baseName: '交通車', students: 93, tokens: 93 },
      { baseName: '國小國語文-小三四', students: 12, tokens: 12 },
    ];

    const unmatched = reportRosterOnly.map((r) => r.baseName);
    const counts: CandidateCounts = new Map(
      reportRosterOnly.map((r) => [r.baseName, { studentCount: r.students, tokenCount: r.tokens }])
    );
    const candidates = buildDynamicCandidates(unmatched, counts);

    // 筆數與班名完全一致
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.rawBaseName)).toEqual(['交通車', '國小國語文-小三四', '美語等班']);

    // 人數與筆數精確對應
    const jtc = candidates.find((c) => c.rawBaseName === '交通車')!;
    expect(jtc.studentCount).toBe(93);
    expect(jtc.tokenCount).toBe(93);
    expect(jtc.suggestedTarget).toBe('');
    expect(jtc.isValid).toBe(true);

    const cn34 = candidates.find((c) => c.rawBaseName === '國小國語文-小三四')!;
    expect(cn34.studentCount).toBe(12);
    expect(cn34.tokenCount).toBe(12);
  });

  it('2. 當 rosterOnly 為空陣列時，產出空候選陣列', () => {
    const candidates = buildDynamicCandidates([], new Map());
    expect(candidates).toHaveLength(0);
  });
});

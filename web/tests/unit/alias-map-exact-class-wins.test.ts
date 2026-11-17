import { describe, expect, it } from 'vitest';
import { buildSeedDraft, draftToAliasMap } from '@/adapters/sqlite/settings-repository';
import { buildClassSettingMap } from '@/application/calculate-run';
import { resolveClassEnrollment } from '@/domain/classification/class-category';

/**
 * 課表已有同名班時，同名優先，指向它的「舊別名」不得再改寫解析結果
 * （與班名同步頁、pending-classes、stageClassNameSync 的「同名優先」語意一致）。
 * 全部為合成資料。
 */
describe('draftToAliasMap：課表同名班優先於同名別名', () => {
  const seed = buildSeedDraft();
  const existing = seed.classes[0].baseName;

  it('raw 名本身就是課表班級的別名被忽略', () => {
    const draft = {
      ...seed,
      aliases: [{ rawBaseName: existing, targetBaseName: `${existing}-不存在的目標` }],
    };
    expect(draftToAliasMap(draft).has(existing)).toBe(false);
  });

  it('經由 resolveClassEnrollment 仍解析到同名課表班（mapped）', () => {
    const draft = {
      ...seed,
      aliases: [{ rawBaseName: existing, targetBaseName: `${existing}-不存在的目標` }],
    };
    const r = resolveClassEnrollment(
      { rawToken: `${existing}[團]`, baseName: existing },
      draftToAliasMap(draft),
      buildClassSettingMap(draft)
    );
    expect(r.resolvedBaseName).toBe(existing);
    expect(r.mapped).toBe(true);
  });

  it('raw 名不在課表的正常別名維持有效', () => {
    const draft = {
      ...seed,
      aliases: [{ rawBaseName: '合成舊班名', targetBaseName: existing }],
    };
    expect(draftToAliasMap(draft).get('合成舊班名')).toBe(existing);
  });
});

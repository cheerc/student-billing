import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { buildSeedDraft, hashSettingsDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { findUnmappedClasses } from '@/application/schedule-deductions';

/**
 * specs/09 §8.3：移除 UI UNMAPPED_CLASSES 固定集合做狀態判斷，改讀當前 resolution。
 * 「待設定班級」＝ERP 班名在該 run 的課表快照裡找不到對應（含班名對應 alias 解析後也找不到）。
 * 判斷來源是 run 當時的課表快照，不是寫死的班名清單，也不是最新設定（歷史 run 不得套用最新設定，§5.2）。
 */

describe('待設定班級（動態判斷，取代 UNMAPPED_CLASSES 固定集合）', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unmapped-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);
    saveImportBatch(db, {
      id: 'imp_1', fileName: 'a.xlsx', fileHash: 'h', contentHash: 'c', sheetName: 'S', headerMap: {},
      parserVersion: '1', scopeNote: '', rowCount: 0, status: 'ready', createdAt: '2026-09-01T00:00:00.000Z',
    }, []);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const addRun = (id: string, scheduleVersionId: string) =>
    saveCalculationRun(db, {
      id, importId: 'imp_1', scheduleVersionId, ruleSetVersion: 'erp-tag-v2', numericPolicy: 'p',
      asOfDate: '2026-09-15', status: 'completed', issueCounts: {}, totalStudents: 0, createdAt: '2026-09-02T00:00:00.000Z',
    }, []);

  const addSettings = (id: string, revision: number, mutate: (d: ReturnType<typeof buildSeedDraft>) => void) => {
    const draft = buildSeedDraft();
    mutate(draft);
    saveSettingsVersion(db, {
      id, contentHash: hashSettingsDraft(draft), contentJson: JSON.stringify(draft),
      effectiveFrom: null, effectiveTo: null, createdAt: '2026-09-01T12:00:00.000Z', createdFromPreviewId: null, revision,
    });
  };

  it('seed 課表：課表裡有的班（國小數學-三A）不是待設定；課表裡沒有的（國小數學-一、交通車）才是', () => {
    addRun('run_seed', 'seed-v250922');

    const result = findUnmappedClasses(db, 'run_seed', ['國小數學-三A', '國小數學-一', '交通車']);

    expect(result).toEqual(['國小數學-一', '交通車']);
  });

  it('已有班名對應（國小數學-一 → 國小數學-一A）→ 解析後找得到，不再是待設定', () => {
    addSettings('set_v1', 1, (d) => {
      d.aliases = [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }];
    });
    addRun('run_alias', 'set_v1');

    const result = findUnmappedClasses(db, 'run_alias', ['國小數學-一', '交通車']);

    expect(result).toEqual(['交通車']);
  });

  it('班級從已儲存課表整班移除 → 該班變成待設定（有覆寫時不退回 seed）', () => {
    addSettings('set_v2', 2, (d) => {
      d.classes = d.classes.filter((c) => c.baseName !== '國小數學-三A');
    });
    addRun('run_removed', 'set_v2');

    expect(findUnmappedClasses(db, 'run_removed', ['國小數學-三A', '國小數學-二A'])).toEqual(['國小數學-三A']);
  });

  it('判斷依該 run 當時的快照，不受之後儲存的最新設定影響（歷史 run 不得套用最新設定）', () => {
    addRun('run_old', 'seed-v250922');
    // 之後才儲存的最新設定把三A移除；舊 run 的判斷不該改變
    addSettings('set_latest', 3, (d) => {
      d.classes = d.classes.filter((c) => c.baseName !== '國小數學-三A');
    });

    expect(findUnmappedClasses(db, 'run_old', ['國小數學-三A'])).toEqual([]);
  });

  it('當時的課表快照已不存在 → 回 null（無法判斷，不猜也不退回最新設定）', () => {
    addRun('run_gone', 'settings-v-missing');

    expect(findUnmappedClasses(db, 'run_gone', ['國小數學-三A'])).toBeNull();
  });

  it('找不到 run → 回 null', () => {
    expect(findUnmappedClasses(db, 'run_nope', ['國小數學-三A'])).toBeNull();
  });
});

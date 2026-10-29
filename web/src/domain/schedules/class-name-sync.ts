import type { ScheduleGridRow, AliasMapping, ClassType } from '@/contracts/settings';

export class ClassNameSyncError extends Error {
  code: 'EMPTY_NAME' | 'SAME_NAME' | 'TARGET_NOT_FOUND' | 'NAME_ALREADY_EXISTS';
  constructor(
    message: string,
    code: 'EMPTY_NAME' | 'SAME_NAME' | 'TARGET_NOT_FOUND' | 'NAME_ALREADY_EXISTS'
  ) {
    super(message);
    this.name = 'ClassNameSyncError';
    this.code = code;
  }
}

export interface ClassNameSyncState {
  rows: ScheduleGridRow[];
  aliases: AliasMapping[];
}

export interface StageClassNameSyncOp {
  erpBaseName: string;
  systemBaseName: string;
}

export interface StageClassNameSyncResult {
  rows: ScheduleGridRow[];
  aliases: AliasMapping[];
  orphanedAliasRaws: string[];
}

export interface StageNewClassOp {
  erpBaseName: string;
  classType: ClassType;
}

export interface StageNewClassResult {
  rows: ScheduleGridRow[];
  newRow: ScheduleGridRow;
}

/**
 * 班名同步草稿轉換（D62 Phase 1）。
 *
 * 將指定系統班級整班改名為米豆奶班名，保留時段與 rowId 觸發既有改名生命週期。
 * 同步清理相關別名：
 *  - 移除 rawBaseName === erpBaseName 的別名（因為該班名已直接出現在課表中）
 *  - 移除 targetBaseName === systemBaseName 的別名，並將非 erpBaseName 之 raw 列入 orphanedAliasRaws
 */
export function stageClassNameSync(
  state: ClassNameSyncState,
  op: StageClassNameSyncOp
): StageClassNameSyncResult {
  const fromName = op.systemBaseName.trim();
  const toName = op.erpBaseName.trim();

  if (!fromName || !toName) {
    throw new ClassNameSyncError('班級名稱不可為空', 'EMPTY_NAME');
  }

  if (fromName === toName) {
    throw new ClassNameSyncError('來源班名與目標班名相同', 'SAME_NAME');
  }

  const currentNames = new Set(state.rows.map((r) => r.className.trim()).filter(Boolean));

  if (!currentNames.has(fromName)) {
    throw new ClassNameSyncError(`目標課表班級「${fromName}」不存在`, 'TARGET_NOT_FOUND');
  }

  if (currentNames.has(toName)) {
    throw new ClassNameSyncError(`課表已存在同名班級「${toName}」`, 'NAME_ALREADY_EXISTS');
  }

  const nextRows = state.rows.map((r) => {
    if (r.className.trim() === fromName) {
      return { ...r, className: toName };
    }
    return r;
  });

  const nextAliases: AliasMapping[] = [];
  const orphanedAliasRaws: string[] = [];

  for (const a of state.aliases) {
    const raw = a.rawBaseName.trim();
    const target = a.targetBaseName.trim();

    if (raw === toName) {
      // 該名冊班名已成為課表班級，不再需要別名
      continue;
    }

    if (target === fromName) {
      // 指向原系統班的別名被移除
      if (raw !== toName) {
        orphanedAliasRaws.push(a.rawBaseName);
      }
      continue;
    }

    nextAliases.push(a);
  }

  return {
    rows: nextRows,
    aliases: nextAliases,
    orphanedAliasRaws,
  };
}

/**
 * 從名冊新增課表班級（D62 Phase 1）。
 *
 * 產生一列預設值；排課類型時段留空（等待後續補填或觸發 1c 待補警示），
 * 其他班預設 skipDeduction: true。
 */
export function stageNewClassFromRoster(
  rows: ScheduleGridRow[],
  op: StageNewClassOp
): StageNewClassResult {
  const className = op.erpBaseName.trim();

  if (!className) {
    throw new ClassNameSyncError('班級名稱不可為空', 'EMPTY_NAME');
  }

  const currentNames = new Set(rows.map((r) => r.className.trim()).filter(Boolean));
  if (currentNames.has(className)) {
    throw new ClassNameSyncError(`課表已存在同名班級「${className}」`, 'NAME_ALREADY_EXISTS');
  }

  const newRow: ScheduleGridRow = {
    rowId: `user-row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    className,
    teacher: null,
    weekday: '',
    startTime: '',
    endTime: '',
    startMinutes: null,
    endMinutes: null,
    active: true,
    skipDeduction: op.classType === 'other',
  };

  return {
    rows: [...rows, newRow],
    newRow,
  };
}

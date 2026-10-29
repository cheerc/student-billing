import React from 'react';
import type { ClassNameSyncReport } from '@/application/class-name-match-report';
import type { ScheduleGridRow, AliasMapping, ClassType } from '@/contracts/settings';

export interface ClassNameSyncPanelProps {
  report: ClassNameSyncReport | null;
  rows?: ScheduleGridRow[];
  aliases?: AliasMapping[];
  stagedRenames?: Map<string, string>; // erpBaseName -> systemBaseName
  stagedNewClasses?: Set<string>; // erpBaseName
  onStageSync?: (erpBaseName: string, systemBaseName: string) => void;
  onStageNewClass?: (erpBaseName: string, classType: ClassType) => void;
  onUndoStaged?: (erpBaseName: string) => void;
  onGoToSchedule?: (className: string) => void;
  locked?: boolean;
  reportRecoveryStage?: 'retrying' | 'reload' | 'reloadPage' | null;
  reportStaleMessage?: string | null;
  onRetryReport?: () => void;
  onReloadPage?: () => void;
  hasStudents?: boolean;
}

export function ClassNameSyncPanel(_props: ClassNameSyncPanelProps) {
  return <div data-class-name-sync-panel="">待實作</div>;
}

export default ClassNameSyncPanel;

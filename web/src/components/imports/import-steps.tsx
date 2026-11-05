import Link from 'next/link';
import { formatDateTime } from '@/lib/datetime';

export type ImportStage = 'upload' | 'preview' | 'success';

interface ImportStepsProps {
  stage: ImportStage;
  /** 最新課表設定版本的儲存時間（ISO）；null＝尚未儲存過，顯示初始課表提示。 */
  scheduleSavedAt: string | null;
}

const STEPS: { stage: ImportStage; label: string }[] = [
  { stage: 'upload', label: '選擇檔案' },
  { stage: 'preview', label: '確認名單' },
  { stage: 'success', label: '完成' },
];

/**
 * 匯入頁步驟條（specs/09 §4、D64 G2、UX123）。
 * `<ol>` + `aria-current="step"`；完成步驟顯示 ✓；當前步驟下方一行行動說明。
 * 步驟 1 的說明併入「目前課表：… 已儲存」與「查看課表 →」連結。
 */
export function ImportSteps({ stage, scheduleSavedAt }: ImportStepsProps) {
  const currentIndex = STEPS.findIndex((s) => s.stage === stage);
  const scheduleLabel = scheduleSavedAt
    ? `${formatDateTime(scheduleSavedAt)} 已儲存`
    : '已載入初始課表，請確認';

  const hint = (index: number) => {
    if (index === 0) {
      return (
        <span className="step-hint">
          <span className="schedule-meta-note">
            <span className="dot dot-clean" aria-hidden="true" />
            <span>目前課表：{scheduleLabel}</span>
          </span>
          <Link href="/settings?tab=schedule" className="step-hint-link">
            查看課表 →
          </Link>
        </span>
      );
    }
    if (index === 1) return <span className="step-hint">確認人數與異動後，按「使用這份名單」。</span>;
    return <span className="step-hint">可前往「03 核對結果」查看各班天數與折扣。</span>;
  };

  return (
    <ol className="import-steps" aria-label="匯入進度">
      {STEPS.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending';
        return (
          <li
            key={step.stage}
            className={`step-item step-${state}`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span className="step-number" aria-hidden={state === 'done' ? 'true' : undefined}>
              {state === 'done' ? '✓' : index + 1}
            </span>
            <span className="step-body">
              <span className="step-text">
                {state === 'done' ? <span className="sr-only">已完成：</span> : null}
                {step.label}
              </span>
              {state === 'active' ? hint(index) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

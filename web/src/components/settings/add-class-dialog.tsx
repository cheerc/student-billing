'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  CLASS_TYPE_LABELS,
  type ClassType,
  defaultSkipDeductionForClassType,
  isSchedulableClassType,
  supportsMultiSubjectDiscount,
  timeStringToMinutes,
  type ScheduleGridRow,
} from '@/contracts/settings';
import { restoreFocusToOpener } from '@/components/ui/restore-focus-to-opener';
import { YesNoRadioGroup } from './yes-no-radio-group';
import { TimeRangeEditor, type CommittedTimeRange, type PendingTimeDraft } from './time-range-editor';
import { WeekdaySelect } from './weekday-select';

interface AddClassDialogProps {
  open: boolean;
  selectedClassType: ClassType;
  opener: HTMLElement | null;
  onOpenChange: (open: boolean) => void;
  onAddRow: (
    row: Omit<ScheduleGridRow, 'rowId'>,
    classType: ClassType,
    options: { hasMultiSubjectDiscount: boolean; fixedFiveDays: boolean }
  ) => string | null;
}

/** Native modal add flow. The active schedule tab is the sole source of class type. */
export function AddClassDialog({ open, selectedClassType, opener, onOpenChange, onAddRow }: AddClassDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [className, setClassName] = useState('');
  const [teacher, setTeacher] = useState('');
  const [weekday, setWeekday] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [timePending, setTimePending] = useState<PendingTimeDraft | null>(null);
  const [hasMultiSubjectDiscount, setHasMultiSubjectDiscount] = useState(() =>
    supportsMultiSubjectDiscount(selectedClassType)
  );
  const [fixedFiveDays, setFixedFiveDays] = useState(false);
  const [skipDeduction, setSkipDeduction] = useState(() =>
    defaultSkipDeductionForClassType(selectedClassType)
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = opener ?? (document.activeElement as HTMLElement | null);
    return () => restoreFocusToOpener(openerRef.current);
  }, [open, opener]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      nameRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  const commitTimes = (value: CommittedTimeRange) => {
    setStartTime(value.startTime);
    setEndTime(value.endTime);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = className.trim();
    if (!cleanName || timePending) return;
    const isSchedulable = isSchedulableClassType(selectedClassType);
    const conflict = onAddRow(
      {
        className: cleanName,
        teacher: teacher.trim() || null,
        weekday: isSchedulable ? weekday : '',
        startTime: isSchedulable ? startTime : '',
        endTime: isSchedulable ? endTime : '',
        startMinutes: isSchedulable ? timeStringToMinutes(startTime) : null,
        endMinutes: isSchedulable ? timeStringToMinutes(endTime) : null,
        active: true,
        skipDeduction: isSchedulable ? skipDeduction : false,
      },
      selectedClassType,
      { hasMultiSubjectDiscount, fixedFiveDays }
    );
    if (conflict) {
      setError(conflict);
      return;
    }
    onOpenChange(false);
  };

  return (
    <dialog
      ref={dialogRef}
      className="add-class-dialog"
      aria-labelledby="addClassDialogTitle"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        if (open) onOpenChange(false);
      }}
    >
      <div className="dialoghead">
        <div>
          <h2 id="addClassDialogTitle">新增{CLASS_TYPE_LABELS[selectedClassType]}</h2>
          <p className="note">在「{CLASS_TYPE_LABELS[selectedClassType]}」頁籤新增一個班級或時段。</p>
        </div>
        <button
          type="button"
          className="btn-close"
          aria-label="關閉新增視窗"
          onClick={() => onOpenChange(false)}
        >
          ✕
        </button>
      </div>
      <form onSubmit={handleSubmit} className="add-session-panel" aria-label="新增班級表單">
        <div className="form-row">
          <label>
            <span>班級名稱 *</span>
            <input
              ref={nameRef}
              type="text"
              value={className}
              onChange={(event) => {
                setClassName(event.target.value);
                setError(null);
              }}
              placeholder="例如：平日作文班"
              aria-label="新增班級名稱"
              required
            />
          </label>
          <label>
            <span>帶班老師</span>
            <input
              type="text"
              value={teacher}
              onChange={(event) => setTeacher(event.target.value)}
              placeholder="例如：張老師"
              aria-label="新增帶班老師"
            />
          </label>

          {supportsMultiSubjectDiscount(selectedClassType) && (
            <label>
              <span>是否有多科折扣</span>
              <YesNoRadioGroup
                label="新增班級是否有多科折扣"
                name="new-multi-discount"
                value={hasMultiSubjectDiscount}
                onChange={setHasMultiSubjectDiscount}
              />
            </label>
          )}

          {selectedClassType === 'care' && (
            <label>
              <span>天數固定 5 天</span>
              <YesNoRadioGroup
                label="新增班級天數固定5天"
                name="new-fixed-five"
                value={fixedFiveDays}
                onChange={setFixedFiveDays}
              />
            </label>
          )}

          {isSchedulableClassType(selectedClassType) && (
            <>
              <label>
                <span>不計扣天</span>
                <YesNoRadioGroup
                  label="新增時段不計扣天"
                  name="new-skip-deduction"
                  value={skipDeduction}
                  onChange={setSkipDeduction}
                />
              </label>
              <label>
                <span>星期</span>
                <WeekdaySelect value={weekday} onChange={setWeekday} aria-label="新增星期" />
              </label>
              <label>
                <span>起訖時間</span>
                <TimeRangeEditor
                  value={{ startTime, endTime }}
                  onPendingChange={setTimePending}
                  onCommit={commitTimes}
                  startLabel="新增起始時間"
                  endLabel="新增結束時間"
                  startTriggerLabel="設定新增起始時間"
                  endTriggerLabel="設定新增結束時間"
                  startSliderLabel="新增起始時間"
                  endSliderLabel="新增結束時間"
                />
              </label>
            </>
          )}
        </div>
        {error && <div className="alert alert-danger add-class-conflict" role="alert">{error}</div>}
        <div className="dialogfooter">
          <button type="button" className="btn-secondary" onClick={() => onOpenChange(false)}>
            取消新增
          </button>
          <button type="submit" className="btn-primary" disabled={Boolean(timePending)}>
            確認新增
          </button>
        </div>
      </form>
    </dialog>
  );
}

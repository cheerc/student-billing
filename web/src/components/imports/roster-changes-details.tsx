import React from 'react';
import type {
  RosterChange,
  ClassBreakdown,
  ClassDiscountChange,
  ClassDiscountReason,
  EnrollmentChange,
} from '@/application/roster-changes';
import { formatDiscountBps } from '@/application/roster-changes';

/**
 * 匯入預覽的逐人異動明細（specs/09 §4；operator 裁決 d-20260929111803466480-4／-5／-68／-75／-76）。
 *
 * 只呈現 application 層已算好的 `enrollmentChanges`／`classDiscountChanges`，畫面不自行推導折扣或天數。
 * 對象是補習班行政人員（-76 文案正本：drafts/roster-changes-copy-final.txt）：
 * 禁用詞＝合計折扣、適用率、科數、類別、token、bps；「原本／現在」用既有折扣短標；
 * 原因欄只寫「發生了什麼」，不寫數字、不寫「因為」。
 */

const fmtDays = (v: number | null): string => (v === null ? '不適用' : String(v));

/** 學生層 before → after；兩側相同顯示「不變」。 */
function daysCell(before: number | null, after: number | null): string {
  return before === after ? '不變' : `${fmtDays(before)} → ${fmtDays(after)}`;
}

const STATUS_LABEL: Record<string, string> = {
  not_counted: '不計入',
  no_enrollment: '—',
  schedule_empty: '課表無時段',
  schedule_not_found: '課表找不到',
};

/** 單班單側扣天：有值顯示「扣N天」，沒有值說明原因而不是寫 0。 */
function deductionText(v: number | null, status: string): string {
  if (v !== null) return `扣 ${v} 天`;
  return STATUS_LABEL[status] ?? '—';
}

/** -76：與報名異動同一組詞（「保留」不變，其餘新增／退出）。 */
const PRESENCE_LABEL: Record<ClassBreakdown['presence'], string> = {
  removed: '退出',
  added: '新增',
  kept: '保留',
};

/** 狀態欄：異動／新學生／已不在名單（-76 一）。 */
function statusOf(c: RosterChange): { key: string; label: string } {
  if (c.isNew) return { key: 'new', label: '新學生' };
  if (c.isRemoved) return { key: 'not-appeared', label: '已不在名單' };
  return { key: 'changed', label: '異動' };
}

/**
 * 報名異動（-76 一：每列一件事）。kept 不顯示；switched 成對只出一行「換班 舊 → 新」。
 * 班名一律顯示名冊原文 rawToken（含 [團] 與注記；decision d-20261003090015932342-4／specs/09 §4）。
 * 舊 API payload 的 rawToken 可能等於 baseName（歷史 run／手寫 fixture），此時原樣顯示。
 */
function enrollmentText(rows: EnrollmentChange[] | undefined): string[] {
  const out: string[] = [];
  const emitted = new Set<string>();
  // 舊 API 回應（快取或歷史 run）可能沒有這兩個欄位：視為沒有可呈現的異動，
  // 由呼叫端決定顯示「—」。不可因缺欄位讓整個預覽頁崩潰。
  for (const r of rows ?? []) {
    if (r.presence === 'switched') {
      // 成對的 switched 只顯示一次：以「被換掉的舊班 → 新班」為一行。
      // switchedWith 存的是**另一端的 rawToken**（roster-changes.ts 建構時對稱設定），故需回查。
      if (emitted.has(r.rawToken)) continue;
      emitted.add(r.rawToken);
      emitted.add(r.switchedWith ?? '');
      const partner = (rows ?? []).find((o) => o.rawToken === r.switchedWith);
      out.push(`換班 ${r.rawToken} → ${partner?.rawToken ?? ''}`);
    } else if (r.presence === 'added') {
      out.push(`新增 ${r.rawToken}`);
    } else if (r.presence === 'removed') {
      out.push(`退出 ${r.rawToken}`);
    }
  }
  return out;
}

/** 折扣變動原因的白話（-76 二）：只寫發生了什麼；多個以「、」並列，不加「同時」。班名用名冊原文。 */
function reasonText(reason: ClassDiscountReason): string {
  switch (reason.kind) {
    case 'enrollment_added':
      return `新增 ${reason.rawToken ?? reason.className}`;
    case 'enrollment_removed':
      return `退出 ${reason.rawToken ?? reason.className}`;
    case 'tag_added':
      return `加上標籤「${reason.tag}」`;
    case 'tag_removed':
      return `移除標籤「${reason.tag}」`;
  }
}

function classDiscountText(item: ClassDiscountChange): { values: string; reason: string } {
  return {
    values: `${formatDiscountBps(item.beforeBps)} → ${formatDiscountBps(item.afterBps)}`,
    reason: item.reasons.length === 0 ? '名單資料變動' : item.reasons.map(reasonText).join('、'),
  };
}

function BreakdownList({ rows }: { rows: ClassBreakdown[] }) {
  return (
    <ul className="roster-change-classes">
      {rows.map((r) => (
        <li key={r.rawToken} data-presence={r.presence}>
          <span className="roster-change-class-name">{r.rawToken}</span>
          <span className={`roster-change-presence presence-${r.presence}`}>{PRESENCE_LABEL[r.presence]}</span>
          <span className="roster-change-class-values">
            {`安親 ${deductionText(r.beforeAnqinDeduction, r.statusBefore)} → ${deductionText(r.afterAnqinDeduction, r.statusAfter)}；` +
              `課輔 ${deductionText(r.beforeTutoringDeduction, r.statusBefore)} → ${deductionText(r.afterTutoringDeduction, r.statusAfter)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RosterChangesDetails({ changes }: { changes: RosterChange[] }) {
  if (changes.length === 0) return null;
  return (
    <details className="roster-changes-details">
      <summary>{`查看逐人明細（${changes.length} 人）`}</summary>
      <div className="roster-changes-scroll">
        <table className="roster-changes-table">
          <thead>
            <tr>
              <th>學生</th>
              <th>狀態</th>
              <th>報名異動</th>
              <th>折扣變動</th>
              <th>安親天數</th>
              <th>課輔天數</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const status = statusOf(c);
              // 新學生／已不在名單沒有「前後」可比：報名異動與折扣變動都顯示「—」（-76 一）
              const oneSided = c.isNew || c.isRemoved;
              const enrollments = oneSided ? [] : enrollmentText(c.enrollmentChanges);
              const classDiscounts = oneSided
                ? []
                : (c.classDiscountChanges ?? []).map((item) => ({ item, ...classDiscountText(item) }));
              return (
                <React.Fragment key={`${status.key}-${c.personCode}`}>
                  <tr data-status={status.key}>
                    <td>
                      <span className="roster-change-name">{c.name}</span>{' '}
                      <span className="roster-change-code">{c.personCode}</span>
                    </td>
                    <td data-field="status">{status.label}</td>
                    <td data-field="enrollment">
                      {enrollments.length > 0 ? (
                        <ul className="roster-change-enrollments">
                          {enrollments.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-field="class-discount">
                      {classDiscounts.length > 0 ? (
                        <ul className="roster-change-discounts">
                          {classDiscounts.map(({ item, values, reason }) => (
                            <li key={item.rawToken} data-discount-class="">
                              <span className="roster-change-class-name">{item.rawToken}</span>{'　'}
                              <span className="roster-change-discount-values">{values}</span>{'　'}
                              <span className="roster-change-reason" data-reason="">
                                {reason}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-field="anqin-days">
                      {c.dayChange ? daysCell(c.dayChange.beforeAnqinDays, c.dayChange.afterAnqinDays) : '—'}
                    </td>
                    <td data-field="tutoring-days">
                      {c.dayChange ? daysCell(c.dayChange.beforeTutoringDays, c.dayChange.afterTutoringDays) : '—'}
                    </td>
                  </tr>
                  {c.dayChange && c.dayChange.classBreakdown.length > 0 && (
                    <tr className="roster-change-breakdown">
                      <td colSpan={6}>
                        <BreakdownList rows={c.dayChange.classBreakdown} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

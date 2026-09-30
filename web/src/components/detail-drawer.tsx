'use client';

import React, { useEffect, useRef } from 'react';
import { StudentCalculationItem } from '@/application/query-students';
import { issueLabel, issueMessage } from '@/lib/issue-copy';

interface DetailDrawerProps {
  student: StudentCalculationItem | null;
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export default function DetailDrawer({ student, onClose }: DetailDrawerProps) {
  if (!student) return null;
  return <DrawerPanel student={student} onClose={onClose} />;
}

/**
 * 學生明細抽屜（modal，specs/09 §6／UX16）：
 * 開啟時焦點移入；Tab／Shift+Tab 在抽屜內循環（focus trap）；Esc 關閉；
 * 關閉後焦點回到觸發點（該學生列的姓名按鈕，找不到才回到開啟前的焦點元素）。
 */
function DrawerPanel({ student, onClose }: { student: StudentCalculationItem; onClose: () => void }) {
  const { trace } = student;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const personCode = student.personCode;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('[data-drawer-close]')?.focus();
    return () => {
      const trigger = document.querySelector<HTMLElement>(`[data-student-trigger="${CSS.escape(personCode)}"]`);
      (trigger ?? opener)?.focus?.();
    };
  }, [personCode]);

  const trapTab = (e: React.KeyboardEvent) => {
    const panel = panelRef.current;
    if (e.key !== 'Tab' || !panel) return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${student.name} 的學生明細`}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
        backgroundColor: 'rgba(15, 23, 42, 0.4)',
      }}
      onClick={onClose}
      onKeyDown={(e) => {
        // UX16：Esc 可關閉 drawer（背景 div 預設不可聚焦，故明確綁定）
        if (e.key === 'Escape') onClose();
        trapTab(e);
      }}
    >
      <div
        ref={panelRef}
        style={{
          width: '100%',
          maxWidth: '560px',
          height: '100%',
          backgroundColor: '#ffffff',
          boxShadow: '-4px 0 24px rgba(0, 0, 0, 0.15)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#f8fafc',
          }}
        >
          <div>
            <h3 style={{ fontSize: '1.125rem', fontWeight: 700 }}>{student.name}</h3>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {student.grade ? `${student.grade}年級` : student.gradeRaw || '未識別'}
              {student.enrollments.length > 0 ? ` · ${student.enrollments[0].baseName}` : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
            data-drawer-close
            style={{ padding: '4px 10px', fontSize: '0.875rem' }}
          >
            關閉 ✕
          </button>
        </div>

        {/* Drawer Body */}
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* 問題警告區塊 */}
          {student.issues.length > 0 && (
            <div className="alert alert-warning" style={{ margin: 0 }}>
              <strong>待確認事項 ({student.issues.length})：</strong>
              <ul style={{ paddingLeft: '18px', marginTop: '6px' }}>
                {student.issues.map((iss, i) => (
                  <li key={i} style={{ fontSize: '0.8125rem' }}>
                    <strong>{issueLabel(iss.code)}</strong>：{issueMessage(iss)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 八項總表天數卡片 */}
          <div
            style={{
              backgroundColor: '#f8fafc',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '16px',
            }}
          >
            <h4 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '12px' }}>
              收費結果：每週收費天數
            </h4>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '8px',
                textAlign: 'center',
              }}
            >
              <div style={{ background: '#fff', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>安親天數</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 700, color: '#1d4ed8' }}>
                  {student.anqinDisplay || '-'}
                </div>
              </div>
              <div style={{ background: '#fff', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>課輔天數</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 700, color: '#1d4ed8' }}>
                  {student.tutoringDisplay || '-'}
                </div>
              </div>
              <div style={{ background: '#fff', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>美語天數</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                  {student.englishDays !== null ? `${student.englishDays}` : '-'}
                </div>
              </div>
              <div style={{ background: '#fff', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>數學天數</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                  {student.mathDays !== null ? `${student.mathDays}` : '-'}
                </div>
              </div>
              <div style={{ background: '#fff', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>中文天數</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                  {student.chineseDays !== null ? `${student.chineseDays}` : '-'}
                </div>
              </div>
              <div style={{ background: '#fff', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>寫功課</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                  {student.homeworkDays !== null ? `${student.homeworkDays}` : '-'}
                </div>
              </div>
              <div style={{ background: '#fff', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>加重美語</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                  {student.intensiveEnglishDays !== null ? `${student.intensiveEnglishDays}` : '-'}
                </div>
              </div>
              <div style={{ background: '#fff', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>週六課輔</div>
                <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                  {student.saturdayTutoringDays !== null ? `${student.saturdayTutoringDays}` : '-'}
                </div>
              </div>
            </div>
          </div>

          {/* 折扣比對與推導 */}
          <div
            style={{
              backgroundColor: '#f8fafc',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '16px',
            }}
          >
            <h4 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '8px' }}>
              折扣推導
            </h4>
            <div style={{ fontSize: '0.8125rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div>已補科數：<strong>{student.subjectCount !== null ? `${student.subjectCount} 科` : '無班級 (null)'}</strong></div>
              <div>
                基本折扣率：
                <strong>
                  {student.baseDiscountBps !== null ? `${student.baseDiscountBps / 100}% (${student.baseDiscountBps / 1000}折)` : '無 (null)'}
                </strong>
              </div>
              <div style={{ marginTop: '6px', borderTop: '1px dashed #cbd5e1', paddingTop: '6px' }}>
                各課程適用率：
                <span style={{ marginLeft: '6px' }}>安親: {student.applicableAnqinBps ? `${student.applicableAnqinBps / 100}%` : '-'}</span>
                <span style={{ marginLeft: '12px' }}>課輔: {student.applicableTutoringBps ? `${student.applicableTutoringBps / 100}%` : '-'}</span>
                <span style={{ marginLeft: '12px' }}>美語: {student.applicableEnglishBps ? `${student.applicableEnglishBps / 100}%` : '-'}</span>
                <span style={{ marginLeft: '12px' }}>數學: {student.applicableMathBps ? `${student.applicableMathBps / 100}%` : '-'}</span>
              </div>
            </div>
          </div>

          {/* 米豆奶登記級距比對 */}
          <div>
            <h4 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '8px' }}>
              課程與扣天：米豆奶登記級距比對
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {student.tierComparisons.map((comp, idx) => (
                <div
                  key={idx}
                  style={{
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    padding: '10px 12px',
                    fontSize: '0.8125rem',
                    backgroundColor: comp.status === 'mismatch' ? '#fef2f2' : '#ffffff',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontWeight: 600 }}>{comp.rawToken}</span>
                    <span
                      className="badge"
                      style={{
                        backgroundColor:
                          comp.status === 'match'
                            ? '#d1fae5'
                            : comp.status === 'mismatch'
                            ? '#fee2e2'
                            : '#f1f5f9',
                        color:
                          comp.status === 'match'
                            ? '#065f46'
                            : comp.status === 'mismatch'
                            ? '#991b1b'
                            : '#475569',
                      }}
                    >
                      {comp.status === 'match'
                        ? '吻合'
                        : comp.status === 'mismatch'
                        ? '級距差異'
                        : comp.status === 'not_applicable'
                        ? '非天數課程'
                        : '未識別'}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    系統計算級距: <strong>{comp.computedTier ?? '-'}</strong> 天 · 米豆奶登記級距: <strong>{comp.erpDeclaredTier ?? '-'}</strong> 天
                  </div>
                  {comp.needsReview && (
                    <div style={{ color: '#b45309', marginTop: '4px', fontSize: '0.75rem' }}>
                      ⚠ 排課缺漏，暫以相容數值比較，請核對課表設定。
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 原始資料（摺疊）：來源列、人員代碼、標籤與備註全文；列表不預設倒出（D27 脫敏） */}
          <details
            style={{
              backgroundColor: '#f8fafc',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '14px',
              fontSize: '0.8125rem',
            }}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>原始資料</summary>
            <div style={{ marginTop: '10px' }}>
              <div style={{ marginBottom: '6px' }}>
                <strong>來源列：</strong>來源試算表第 {student.sourceRow} 列
              </div>
              <div style={{ marginBottom: '6px' }}>
                <strong>人員代碼：</strong>
                <span style={{ fontFamily: 'ui-monospace, monospace' }}>{student.personCode}</span>
              </div>
              <div style={{ marginBottom: '6px' }}>
                <strong>標籤 (Tags)：</strong> {trace?.rawTags || '-'}
              </div>
              <div>
                <strong>備註 (Notes)：</strong> {trace?.rawNotes || (trace?.hasNotes ? '（列表已脫敏，請由明細端點查看）' : '-')}
              </div>
            </div>
          </details>

          {/* 技術資訊（摺疊）：維護用，不預設倒出 */}
          <details
            style={{
              backgroundColor: '#f8fafc',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '14px',
              fontSize: '0.8125rem',
            }}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>技術資訊</summary>
            <pre
              style={{
                marginTop: '10px',
                fontSize: '0.6875rem',
                fontFamily: 'ui-monospace, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: 'var(--text-secondary)',
                maxHeight: '240px',
                overflow: 'auto',
              }}
            >
              {JSON.stringify({ personCode: student.personCode, runId: student.runId, issues: student.issues.map((i) => ({ code: i.code, message: i.message })), subjectCount: student.subjectCount, baseDiscountBps: student.baseDiscountBps, applicableRates: { anqin: student.applicableAnqinBps, tutoring: student.applicableTutoringBps, english: student.applicableEnglishBps, math: student.applicableMathBps }, sourceRow: student.sourceRow }, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}

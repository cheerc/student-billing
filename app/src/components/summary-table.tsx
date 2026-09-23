'use client';

import React from 'react';
import { StudentCalculationItem } from '@/application/query-students';

interface SummaryTableProps {
  students: StudentCalculationItem[];
  loading?: boolean;
  onSelectStudent: (student: StudentCalculationItem) => void;
  onResetFilters?: () => void;
}

export default function SummaryTable({
  students,
  loading,
  onSelectStudent,
  onResetFilters,
}: SummaryTableProps) {
  if (loading) {
    return (
      <div style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>
        總表計算資料載入中...
      </div>
    );
  }

  if (students.length === 0) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>🔍</div>
        <div style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: '6px' }}>無符合篩選條件之學生資料</div>
        <div style={{ fontSize: '0.8125rem', marginBottom: '16px' }}>請嘗試調整關鍵字、放寬科別、年級或問題狀態等篩選條件。</div>
        {onResetFilters && (
          <button type="button" className="btn-secondary" style={{ fontSize: '0.8125rem' }} onClick={onResetFilters}>
            重置所有篩選條件
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>序號</th>
            <th>人員代碼</th>
            <th>姓名</th>
            <th>年級</th>
            <th>所屬班級</th>
            <th style={{ color: '#1d4ed8' }}>安親天數</th>
            <th style={{ color: '#1d4ed8' }}>課輔天數</th>
            <th>美語天數</th>
            <th>數學天數</th>
            <th>中文天數</th>
            <th>寫功課</th>
            <th>基本折扣</th>
            <th>級距比對</th>
            <th>狀態提示</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {students.map((stu, idx) => (
            <tr
              key={stu.personCode}
              style={{
                cursor: 'pointer',
                backgroundColor: stu.tierMismatch ? '#fff5f5' : undefined,
              }}
              onClick={() => onSelectStudent(stu)}
            >
              <td style={{ color: 'var(--text-muted)' }}>{idx + 1}</td>
              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{stu.personCode}</td>
              <td style={{ fontWeight: 600 }}>{stu.name}</td>
              <td>{stu.grade ? `${stu.grade}年級` : stu.gradeRaw || '-'}</td>
              <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {stu.enrollments.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {stu.enrollments.map((e, eIdx) => (
                      <span key={eIdx}>{e.rawToken}</span>
                    ))}
                  </div>
                ) : (
                  '-'
                )}
              </td>
              <td style={{ fontWeight: stu.anqinDays ? 700 : 400, color: stu.anqinDays ? '#1d4ed8' : undefined }}>
                {stu.anqinDisplay || '-'}
              </td>
              <td style={{ fontWeight: stu.tutoringDays ? 700 : 400, color: stu.tutoringDays ? '#1d4ed8' : undefined }}>
                {stu.tutoringDisplay || '-'}
              </td>
              <td>{stu.englishDays !== null ? stu.englishDays : '-'}</td>
              <td>{stu.mathDays !== null ? stu.mathDays : '-'}</td>
              <td>{stu.chineseDays !== null ? stu.chineseDays : '-'}</td>
              <td>{stu.homeworkDays !== null ? stu.homeworkDays : '-'}</td>
              <td>
                {stu.baseDiscountBps !== null ? `${stu.baseDiscountBps / 100}%` : '-'}
              </td>
              <td>
                {stu.tierMismatch ? (
                  <span className="badge" style={{ backgroundColor: '#fee2e2', color: '#991b1b' }}>
                    級距差異 (5筆)
                  </span>
                ) : (
                  <span className="badge" style={{ backgroundColor: '#ecfdf5', color: '#065f46' }}>
                    吻合
                  </span>
                )}
              </td>
              <td>
                {stu.hasIssues ? (
                  <span className="badge" style={{ backgroundColor: '#fef3c7', color: '#92400e' }}>
                    {stu.issues.length > 0 ? stu.issues[0].code : '待核對'}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>正常</span>
                )}
              </td>
              <td>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectStudent(stu);
                  }}
                >
                  明細 ↗
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

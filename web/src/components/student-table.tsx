'use client';

import React from 'react';
import { StudentSnapshot } from '@/domain/students';

interface StudentTableProps {
  students: StudentSnapshot[];
  loading?: boolean;
}

export default function StudentTable({ students, loading }: StudentTableProps) {
  if (loading) {
    return (
      <div style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>
        名單載入中...
      </div>
    );
  }

  if (students.length === 0) {
    return (
      <div style={{ padding: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>
        無符合篩選條件的學生資料。
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
            <th>所屬分校</th>
            <th>報名班級（解析與級距）</th>
            <th>標籤</th>
            <th>備註</th>
          </tr>
        </thead>
        <tbody>
          {students.map((stu, idx) => (
            <tr key={stu.personCode}>
              <td style={{ color: 'var(--text-muted)' }}>{idx + 1}</td>
              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{stu.personCode}</td>
              <td style={{ fontWeight: 600 }}>{stu.name}</td>
              <td>
                {stu.grade ? (
                  <span>{stu.grade} 年級</span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>{stu.gradeRaw || '未識別'}</span>
                )}
              </td>
              <td style={{ color: 'var(--text-secondary)' }}>{stu.branch || '-'}</td>
              <td>
                {stu.enrollments.length > 0 ? (
                  <div className="token-list">
                    {stu.enrollments.map((enr, eIdx) => (
                      <div key={eIdx} className="token-item">
                        <span className="badge badge-class">{enr.rawToken}</span>
                        {enr.erpBillingTier !== null && (
                          <span className="badge badge-tier">
                            級距: {enr.erpBillingTier} 天
                            {enr.tierParseStatus === 'defaulted' ? ' (預設)' : ''}
                          </span>
                        )}
                        {enr.withdrawalDate && (
                          <span className="badge badge-withdrawal">
                            離班: {enr.withdrawalDate}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>無班級</span>
                )}
              </td>
              <td>
                {stu.tagsRaw ? (
                  <span style={{ fontSize: '0.75rem', color: '#1d4ed8' }}>{stu.tagsRaw}</span>
                ) : (
                  '-'
                )}
              </td>
              <td>
                {stu.notesRaw ? (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {stu.notesRaw}
                  </span>
                ) : (
                  '-'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

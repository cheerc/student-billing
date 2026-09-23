'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import { ImportPreviewResult } from '@/application/import-preview';
import { StudentSnapshot } from '@/domain/students';

export default function ImportsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'with-class' | 'no-class' | 'withdrawn'>('all');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (file: File) => {
    if (!file.name.endsWith('.xlsx')) {
      setError('僅支援 .xlsx 格式之試算表檔案，不支援 .xls、CSV 或其他格式。');
      return;
    }

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/v1/imports/preview', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        const errorCode = data.code ? `[${data.code}] ` : '';
        throw new Error(`${errorCode}${data.error || '解析上傳試算表失敗'}`);
      }

      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  // 篩選學生清單
  const filteredStudents = (preview?.students || []).filter((s: StudentSnapshot) => {
    // 關鍵字搜尋
    const query = searchQuery.trim().toLowerCase();
    const matchQuery =
      !query ||
      s.name.toLowerCase().includes(query) ||
      s.personCode.toLowerCase().includes(query) ||
      (s.branch && s.branch.toLowerCase().includes(query));

    if (!matchQuery) return false;

    if (filterMode === 'with-class') return s.enrollments.length > 0;
    if (filterMode === 'no-class') return s.enrollments.length === 0;
    if (filterMode === 'withdrawn') return s.enrollments.some((e) => e.withdrawalDate !== null);
    return true;
  });

  return (
    <div>
      <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>上傳 ERP 學生名單與預覽</h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            支援任意欄位順序、隱藏欄位與非 Excel 原生之 inlineStr OOXML 試算表。
          </p>
        </div>
        <Link href="/" className="btn-secondary">
          返回首頁
        </Link>
      </div>

      {/* 錯誤警示 */}
      {error && (
        <div className="alert alert-danger" role="alert" style={{ marginBottom: '20px' }}>
          <div style={{ fontWeight: 700, marginBottom: '4px' }}>上傳與解析錯誤：</div>
          <div>{error}</div>
          <div style={{ marginTop: '8px', fontSize: '0.75rem', color: '#7f1d1d' }}>
            系統已拒絕此不合法檔案，既有資料庫不受任何影響（安全不變）。
          </div>
        </div>
      )}

      {/* 上傳區塊 */}
      <div
        className="upload-card"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <div className="upload-icon">📄</div>
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '6px' }}>
          {loading ? '正在解析試算表...' : '拖曳 ERP 學生名單 XLSX 至此，或點擊選取檔案'}
        </h3>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          限制單一工作表前 20 列含有完整必要標頭，大小上限 20 MB。
        </p>

        <input
          type="file"
          ref={fileInputRef}
          className="file-input-hidden"
          accept=".xlsx"
          onChange={handleFileChange}
          disabled={loading}
        />

        <button
          type="button"
          className="btn-primary"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
        >
          {loading ? '處理中...' : '選擇 XLSX 檔案'}
        </button>
      </div>

      {/* 預覽結果展示 */}
      {preview && (
        <div>
          {/* 統計指標卡片 */}
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">學生總人數</span>
              <span className="stat-value">{preview.stats.totalStudents}</span>
              <span className="stat-sub">去重人員代碼總數</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">有報名班級人數</span>
              <span className="stat-value" style={{ color: '#059669' }}>
                {preview.stats.studentsWithClass}
              </span>
              <span className="stat-sub">至少有一門班級 token</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">無班級人數</span>
              <span className="stat-value" style={{ color: '#d97706' }}>
                {preview.stats.studentsWithoutClass}
              </span>
              <span className="stat-sub">未報名班級，保留名冊</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">離班標記人數</span>
              <span className="stat-value" style={{ color: '#dc2626' }}>
                {preview.stats.withdrawnStudentsCount}
              </span>
              <span className="stat-sub">標有 (離班日期) 之學生</span>
            </div>
          </div>

          {/* 檔案中繼與雜湊資訊 */}
          <div className="meta-panel">
            <div className="meta-item">
              <span className="meta-item-label">來源檔名</span>
              <span className="meta-item-val">{preview.fileName}</span>
            </div>
            <div className="meta-item">
              <span className="meta-item-label">工作表 (Sheet)</span>
              <span className="meta-item-val">{preview.sheetName}</span>
            </div>
            <div className="meta-item">
              <span className="meta-item-label">標頭列位置</span>
              <span className="meta-item-val">第 {preview.headerRowIndex} 列</span>
            </div>
            <div className="meta-item">
              <span className="meta-item-label">檔案雜湊 (SHA-256)</span>
              <span className="meta-item-val">{preview.fileHash.slice(0, 16)}...</span>
            </div>
            <div className="meta-item">
              <span className="meta-item-label">內容雜湊 (contentHash)</span>
              <span className="meta-item-val">{preview.contentHash.slice(0, 16)}...</span>
            </div>
          </div>

          {/* 警告提示清單 */}
          {preview.issues.length > 0 && (
            <div className="alert alert-warning">
              <strong>匯入注意事項：</strong>
              <ul style={{ paddingLeft: '20px', marginTop: '6px' }}>
                {preview.issues.map((issue, idx) => (
                  <li key={idx}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 學生名單表格與篩選操作 */}
          <div className="table-container">
            <div className="table-header">
              <div className="table-title">
                學生名單預覽 ({filteredStudents.length} / {preview.students.length})
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="搜尋姓名或代碼..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)',
                    fontSize: '0.8125rem',
                  }}
                />
                <select
                  value={filterMode}
                  onChange={(e) => setFilterMode(e.target.value as 'all' | 'with-class' | 'no-class' | 'withdrawn')}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)',
                    fontSize: '0.8125rem',
                    background: '#fff',
                  }}
                >
                  <option value="all">全部學生 ({preview.stats.totalStudents})</option>
                  <option value="with-class">有班級 ({preview.stats.studentsWithClass})</option>
                  <option value="no-class">無班級 ({preview.stats.studentsWithoutClass})</option>
                  <option value="withdrawn">有離班標記 ({preview.stats.withdrawnStudentsCount})</option>
                </select>
              </div>
            </div>

            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>序號</th>
                    <th>人員代碼</th>
                    <th>姓名</th>
                    <th>年級</th>
                    <th>所屬分校</th>
                    <th>所屬班級 Tokens (解析與級距)</th>
                    <th>標籤</th>
                    <th>備註</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStudents.slice(0, 100).map((stu, idx) => (
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

            {filteredStudents.length > 100 && (
              <div style={{ padding: '10px 16px', background: '#fafbfc', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                僅預覽前 100 筆資料，完整資料將於 T02 篩選與分頁切片支援全量分頁檢視。
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

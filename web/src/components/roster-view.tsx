'use client';

import React, { useState } from 'react';
import StudentTable from './student-table';
import { RosterQueryResult } from '@/application/roster-query';
import { ACTIVATE_CONFLICT_MESSAGE } from '@/lib/user-messages';

interface RosterViewProps {
  importId: string;
  fileName: string;
  initialAvailableClasses: string[];
  initialData: RosterQueryResult;
  currentRevision?: number;
}

export default function RosterView({
  importId,
  fileName,
  initialAvailableClasses,
  initialData,
  currentRevision = 0,
}: RosterViewProps) {
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState(false);
  const [data, setData] = useState<RosterQueryResult>(initialData);
  const [error, setError] = useState<string | null>(null);

  // 篩選狀態
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedHasClass, setSelectedHasClass] = useState('');

  // 分頁狀態
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyCursors, setHistoryCursors] = useState<string[]>([]);

  const fetchWithParams = async (
    targetCursor: string | null,
    qVal: string,
    gradeVal: string,
    classVal: string,
    hasClassVal: string
  ) => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    params.set('limit', '50');

    if (targetCursor) {
      params.set('cursor', targetCursor);
    }
    if (qVal.trim()) {
      params.set('q', qVal.trim());
    }
    if (gradeVal) {
      params.set('grade', gradeVal);
    }
    if (classVal) {
      params.set('enrollmentKey', classVal);
    }
    if (hasClassVal) {
      params.set('hasClass', hasClassVal);
    }

    try {
      const res = await fetch(`/api/v1/imports/${importId}/students?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || '查詢名單失敗');
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleActivate = async () => {
    setActivating(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/imports/${importId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: currentRevision,
          idempotencyKey: `act-${Date.now()}`,
          asOfDate: new Date().toISOString().split('T')[0],
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error(ACTIVATE_CONFLICT_MESSAGE);
        }
        throw new Error(json.error || '啟用計算失敗');
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActivating(false);
    }
  };

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, val, selectedGrade, selectedClass, selectedHasClass);
  };

  const handleGradeChange = (val: string) => {
    setSelectedGrade(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, val, selectedClass, selectedHasClass);
  };

  const handleClassChange = (val: string) => {
    setSelectedClass(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, val, selectedHasClass);
  };

  const handleHasClassChange = (val: string) => {
    setSelectedHasClass(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, selectedClass, val);
  };

  const handleNextPage = () => {
    if (data?.nextCursor) {
      setHistoryCursors((prev) => [...prev, cursor || '']);
      setCursor(data.nextCursor);
      fetchWithParams(data.nextCursor, searchQuery, selectedGrade, selectedClass, selectedHasClass);
    }
  };

  const handlePrevPage = () => {
    if (historyCursors.length > 0) {
      const prevHistory = [...historyCursors];
      const prevCursor = prevHistory.pop() || null;
      setHistoryCursors(prevHistory);
      const target = prevCursor === '' ? null : prevCursor;
      setCursor(target);
      fetchWithParams(target, searchQuery, selectedGrade, selectedClass, selectedHasClass);
    }
  };

  const stats = data?.stats || {
    totalStudents: 0,
    studentsWithClass: 0,
    studentsWithoutClass: 0,
  };

  return (
    <div>
      <header className="page-header" style={{ marginBottom: '16px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '0 0 6px' }}>尚未使用這份名單</h1>
        <p className="note" style={{ margin: 0 }}>
          名單已匯入，但還沒開始核對。按下「使用這份名單」才會計算收費結果。
        </p>
      </header>

      {/* 頂部狀態列 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: '#eff6ff',
          border: '1px solid #bfdbfe',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '20px',
        }}
      >
        <div>
          <span style={{ fontWeight: 600, color: '#1e40af' }}>
            已載入就緒名單：{fileName}
          </span>
          <span
            style={{
              marginLeft: '12px',
              fontSize: '0.75rem',
              backgroundColor: '#dbeafe',
              color: '#1e40af',
              padding: '2px 8px',
              borderRadius: '9999px',
              fontWeight: 600,
            }}
          >
            尚未啟用
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            className="btn-primary"
            onClick={handleActivate}
            disabled={activating}
            style={{ fontSize: '0.8125rem', padding: '6px 14px' }}
          >
            {activating ? '計算中…' : '使用這份名單'}
          </button>
          <a href="/imports" className="btn-secondary" style={{ fontSize: '0.8125rem', padding: '6px 12px' }}>
            匯入其他名單
          </a>
        </div>
      </div>

      {/* 統計指標卡片 */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">符合篩選學生數</span>
          <span className="stat-value">{data?.totalStudents ?? 0}</span>
          <span className="stat-sub">去重人員代碼總數</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">有報名班級人數</span>
          <span className="stat-value" style={{ color: '#059669' }}>
            {stats.studentsWithClass}
          </span>
          <span className="stat-sub">至少報名 1 個班級</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">無班級學生人數</span>
          <span className="stat-value" style={{ color: '#d97706' }}>
            {stats.studentsWithoutClass}
          </span>
          <span className="stat-sub">未報名班級保留名冊</span>
        </div>
      </div>

      {/* 錯誤警告 */}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {/* 篩選工具列與名單表格 */}
      <div className="table-container">
        <div
          className="table-header"
          style={{ flexWrap: 'wrap', gap: '12px', padding: '12px 16px' }}
        >
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {/* 關鍵字搜尋 */}
            <input
              type="text"
              placeholder="搜尋姓名或代碼..."
              aria-label="搜尋姓名或人員代碼"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                minWidth: '150px',
              }}
            />

            {/* 年級篩選 */}
            <select
              aria-label="年級篩選"
              value={selectedGrade}
              onChange={(e) => handleGradeChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                background: '#fff',
              }}
            >
              <option value="">全部年級</option>
              <option value="1">一年級</option>
              <option value="2">二年級</option>
              <option value="3">三年級</option>
              <option value="4">四年級</option>
              <option value="5">五年級</option>
              <option value="6">六年級</option>
            </select>

            {/* 班級候選篩選 (四年級 A/B 分開) */}
            <select
              aria-label="班級篩選"
              value={selectedClass}
              onChange={(e) => handleClassChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                background: '#fff',
                maxWidth: '220px',
              }}
            >
              <option value="">全部班級</option>
              {initialAvailableClasses.map((cls) => (
                <option key={cls} value={cls}>
                  {cls}
                </option>
              ))}
            </select>

            {/* 有無班級 */}
            <select
              aria-label="有無班級篩選"
              value={selectedHasClass}
              onChange={(e) => handleHasClassChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                background: '#fff',
              }}
            >
              <option value="">全部有無班級</option>
              <option value="true">僅有班級</option>
              <option value="false">僅無班級</option>
            </select>
          </div>

          {/* 分頁按鈕 */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              顯示 {data?.items.length ?? 0} 筆 (共 {data?.totalStudents ?? 0} 人)
            </span>
            <button
              type="button"
              className="btn-secondary"
              style={{ padding: '4px 10px', fontSize: '0.75rem' }}
              onClick={handlePrevPage}
              disabled={historyCursors.length === 0 || loading}
            >
              上一頁
            </button>
            <button
              type="button"
              className="btn-secondary"
              style={{ padding: '4px 10px', fontSize: '0.75rem' }}
              onClick={handleNextPage}
              disabled={!data?.nextCursor || loading}
            >
              下一頁
            </button>
          </div>
        </div>

        {/* 學生表格 */}
        <StudentTable students={data?.items || []} loading={loading} />
      </div>
    </div>
  );
}

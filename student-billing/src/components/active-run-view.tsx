'use client';

import React, { useState, useEffect, useCallback } from 'react';
import SummaryTable from './summary-table';
import DetailDrawer from './detail-drawer';
import {
  RunStudentsQueryResult,
  StudentCalculationItem,
} from '@/application/query-students';

interface ActiveRunViewProps {
  runId: string;
  revision: number;
  asOfDate: string;
  initialAvailableClasses: string[];
  initialData: RunStudentsQueryResult;
}

export default function ActiveRunView({
  runId,
  revision,
  asOfDate,
  initialAvailableClasses,
  initialData,
}: ActiveRunViewProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RunStudentsQueryResult>(initialData);
  const [error, setError] = useState<string | null>(null);

  // 篩選狀態
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedMismatch, setSelectedMismatch] = useState('');
  const [selectedHasIssues, setSelectedHasIssues] = useState('');

  // 分頁狀態
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyCursors, setHistoryCursors] = useState<string[]>([]);

  // 抽屜狀態
  const [selectedStudent, setSelectedStudent] = useState<StudentCalculationItem | null>(null);

  const fetchWithParams = useCallback(
    async (
      targetCursor: string | null,
      qVal: string,
      gradeVal: string,
      classVal: string,
      mismatchVal: string,
      hasIssuesVal: string
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
      if (mismatchVal) {
        params.set('tierMismatch', mismatchVal);
      }
      if (hasIssuesVal) {
        params.set('hasIssues', hasIssuesVal);
      }

      try {
        const res = await fetch(`/api/v1/runs/${runId}/students?${params.toString()}`);
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || '查詢總表資料失敗');
        }
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [runId]
  );

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, val, selectedGrade, selectedClass, selectedMismatch, selectedHasIssues);
  };

  const handleGradeChange = (val: string) => {
    setSelectedGrade(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, val, selectedClass, selectedMismatch, selectedHasIssues);
  };

  const handleClassChange = (val: string) => {
    setSelectedClass(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, val, selectedMismatch, selectedHasIssues);
  };

  const handleMismatchChange = (val: string) => {
    setSelectedMismatch(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, selectedClass, val, selectedHasIssues);
  };

  const handleHasIssuesChange = (val: string) => {
    setSelectedHasIssues(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, selectedClass, selectedMismatch, val);
  };

  const handleNextPage = () => {
    if (data?.nextCursor) {
      setHistoryCursors((prev) => [...prev, cursor || '']);
      setCursor(data.nextCursor);
      fetchWithParams(
        data.nextCursor,
        searchQuery,
        selectedGrade,
        selectedClass,
        selectedMismatch,
        selectedHasIssues
      );
    }
  };

  const handlePrevPage = () => {
    if (historyCursors.length > 0) {
      const prevHistory = [...historyCursors];
      const prevCursor = prevHistory.pop() || null;
      setHistoryCursors(prevHistory);
      const target = prevCursor === '' ? null : prevCursor;
      setCursor(target);
      fetchWithParams(
        target,
        searchQuery,
        selectedGrade,
        selectedClass,
        selectedMismatch,
        selectedHasIssues
      );
    }
  };

  const stats = data?.stats || {
    totalStudents: 0,
    mismatchCount: 0,
    issuesCount: 0,
  };

  return (
    <div>
      {/* 頂部正式狀態橫幅 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '20px',
        }}
      >
        <div>
          <span style={{ fontWeight: 700, color: '#166534', fontSize: '1rem' }}>
            已啟用正式計算 Run：{runId}
          </span>
          <span
            style={{
              marginLeft: '12px',
              fontSize: '0.75rem',
              backgroundColor: '#dcfce7',
              color: '#15803d',
              padding: '2px 8px',
              borderRadius: '9999px',
              fontWeight: 700,
            }}
          >
            展示B / 版本 rev {revision} · 基準日 {asOfDate}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <a
            href={`/api/v1/runs/${runId}/comparison?againstRuleSet=excel-v260922-compat`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
            style={{ fontSize: '0.8125rem', padding: '6px 12px' }}
          >
            查看雙軌差異 JSON ↗
          </a>
          <a
            href="/imports"
            className="btn-secondary"
            style={{ fontSize: '0.8125rem', padding: '6px 12px' }}
          >
            上傳新版本 ERP
          </a>
        </div>
      </div>

      {/* 統計指標卡片 */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">符合篩選學生數</span>
          <span className="stat-value">{data?.totalStudents ?? 0}</span>
          <span className="stat-sub">去重學生總數</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">ERP 級距差異學生數</span>
          <span className="stat-value" style={{ color: stats.mismatchCount > 0 ? '#dc2626' : '#166534' }}>
            {stats.mismatchCount}
          </span>
          <span className="stat-sub">計算天數與 ERP 標記不符 (預期 5 人)</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">待確認事項學生數</span>
          <span className="stat-value" style={{ color: '#d97706' }}>
            {stats.issuesCount}
          </span>
          <span className="stat-sub">包含缺排課、重複科別、備註衝突</span>
        </div>
      </div>

      {/* 錯誤警告 */}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {/* 篩選工具列與總表 */}
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
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                minWidth: '140px',
              }}
            />

            {/* 年級篩選 */}
            <select
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

            {/* 班級篩選 */}
            <select
              value={selectedClass}
              onChange={(e) => handleClassChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                background: '#fff',
                maxWidth: '180px',
              }}
            >
              <option value="">全部班級</option>
              {initialAvailableClasses.map((cls) => (
                <option key={cls} value={cls}>
                  {cls}
                </option>
              ))}
            </select>

            {/* 級距比對篩選 (展示B 驗收重點: 篩出 5 筆級距差異) */}
            <select
              value={selectedMismatch}
              onChange={(e) => handleMismatchChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: selectedMismatch === 'true' ? '2px solid #ef4444' : '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                background: selectedMismatch === 'true' ? '#fef2f2' : '#fff',
                fontWeight: selectedMismatch === 'true' ? 700 : 400,
              }}
            >
              <option value="">全部級距狀態</option>
              <option value="true">⚠ 僅顯示級距差異 (5筆)</option>
              <option value="false">✓ 僅顯示級距吻合</option>
            </select>

            {/* 問題篩選 */}
            <select
              value={selectedHasIssues}
              onChange={(e) => handleHasIssuesChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                background: '#fff',
              }}
            >
              <option value="">全部問題狀態</option>
              <option value="true">僅顯示有待確認事項</option>
              <option value="false">僅顯示完全正常</option>
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

        {/* 核對總表 */}
        <SummaryTable
          students={data?.items || []}
          loading={loading}
          onSelectStudent={(s) => setSelectedStudent(s)}
        />
      </div>

      {/* 學生計算明細側欄 Drawer */}
      <DetailDrawer
        student={selectedStudent}
        onClose={() => setSelectedStudent(null)}
      />
    </div>
  );
}

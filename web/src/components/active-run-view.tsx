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

const UNMAPPED_CLASSES = new Set([
  '交通車',
  '小六國文加強班',
  '小六數學加強班',
  '小六英文加強班',
  '正音A班',
  '正音B班',
  '國小輔導-寫功課',
  '國小輔導-四年級A',
  '國小輔導-四年級B',
  '國小數學-一',
  '國小國語文-小三四',
  '美語',
]);

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
  const [selectedSubject, setSelectedSubject] = useState('');
  const [selectedMismatch, setSelectedMismatch] = useState('');
  const [selectedHasIssues, setSelectedHasIssues] = useState('');
  const [selectedIssueCode, setSelectedIssueCode] = useState('');

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
      subjectVal: string,
      mismatchVal: string,
      hasIssuesVal: string,
      issueCodeVal: string
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
      if (subjectVal) {
        params.set('subject', subjectVal);
      }
      if (mismatchVal) {
        params.set('tierMismatch', mismatchVal);
      }
      if (hasIssuesVal) {
        params.set('hasIssues', hasIssuesVal);
      }
      if (issueCodeVal) {
        params.set('issueCode', issueCodeVal);
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
    fetchWithParams(null, val, selectedGrade, selectedClass, selectedSubject, selectedMismatch, selectedHasIssues, selectedIssueCode);
  };

  const handleGradeChange = (val: string) => {
    setSelectedGrade(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, val, selectedClass, selectedSubject, selectedMismatch, selectedHasIssues, selectedIssueCode);
  };

  const handleClassChange = (val: string) => {
    setSelectedClass(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, val, selectedSubject, selectedMismatch, selectedHasIssues, selectedIssueCode);
  };

  const handleSubjectChange = (val: string) => {
    setSelectedSubject(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, selectedClass, val, selectedMismatch, selectedHasIssues, selectedIssueCode);
  };

  const handleMismatchChange = (val: string) => {
    setSelectedMismatch(val);
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, selectedClass, selectedSubject, val, selectedHasIssues, selectedIssueCode);
  };

  const handleHasIssuesChange = (val: string) => {
    setSelectedHasIssues(val);
    // 若選擇僅顯示完全正常，同時清空 issueCode 避免 400 衝突
    const nextIssueCode = val === 'false' ? '' : selectedIssueCode;
    if (val === 'false') {
      setSelectedIssueCode('');
    }
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, selectedClass, selectedSubject, selectedMismatch, val, nextIssueCode);
  };

  const handleIssueCodeChange = (val: string) => {
    setSelectedIssueCode(val);
    // 若選擇了特定問題碼，確保 hasIssues 不為 false
    const nextHasIssues = (val && selectedHasIssues === 'false') ? '' : selectedHasIssues;
    if (val && selectedHasIssues === 'false') {
      setSelectedHasIssues('');
    }
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, searchQuery, selectedGrade, selectedClass, selectedSubject, selectedMismatch, nextHasIssues, val);
  };

  const handleResetFilters = () => {
    setSearchQuery('');
    setSelectedGrade('');
    setSelectedClass('');
    setSelectedSubject('');
    setSelectedMismatch('');
    setSelectedHasIssues('');
    setSelectedIssueCode('');
    setCursor(null);
    setHistoryCursors([]);
    fetchWithParams(null, '', '', '', '', '', '', '');
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
        selectedSubject,
        selectedMismatch,
        selectedHasIssues,
        selectedIssueCode
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
        selectedSubject,
        selectedMismatch,
        selectedHasIssues,
        selectedIssueCode
      );
    }
  };

  const stats = data?.stats || {
    totalStudents: 0,
    mismatchCount: 0,
    issuesCount: 0,
    classScopeTotal: 0,
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
            已啟用正式計算 Run
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
            核對基準日 {asOfDate}
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

      {/* 技術資訊摺疊區（版本識別與長 ID 收納於此，不在日常介面顯示） */}
      <details
        style={{
          marginBottom: '16px',
          padding: '8px 14px',
          background: '#fafbfc',
          border: '1px solid var(--border-color)',
          borderRadius: '8px',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
        }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>技術資訊</summary>
        <div style={{ marginTop: '8px', fontFamily: 'ui-monospace, monospace' }}>
          Run ID：{runId}｜版本 rev {revision}｜基準日 {asOfDate}
        </div>
      </details>

      {/* 人數一行（09 §5.1）：本班N人 · 符合篩選M人 · N位需確認 —— 三者 scope 不同，不可互相冒充 */}
      <div className="counts-line" role="status" aria-live="polite">
        <span className="counts-item">
          本班 <strong>{stats.classScopeTotal}</strong> 人
        </span>
        <span className="counts-sep" aria-hidden="true">·</span>
        <span className="counts-item">
          符合篩選 <strong>{data?.totalStudents ?? 0}</strong> 人
        </span>
        <span className="counts-sep" aria-hidden="true">·</span>
        <span className="counts-item">
          <strong>{stats.issuesCount}</strong> 位需確認
        </span>
        {stats.mismatchCount > 0 && (
          <>
            <span className="counts-sep" aria-hidden="true">·</span>
            <span className="counts-item">
              <strong>{stats.mismatchCount}</strong> 位計算天數與 ERP 登記不符
            </span>
          </>
        )}
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

            {/* 科別篩選 */}
            <select
              value={selectedSubject}
              onChange={(e) => handleSubjectChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                background: '#fff',
              }}
            >
              <option value="">全部科別</option>
              <option value="國小輔導">國小輔導</option>
              <option value="國小數學">國小數學</option>
              <option value="兒童美語">兒童美語</option>
              <option value="國語文">國語文</option>
              <option value="加強班">加強班</option>
              <option value="寫功課">寫功課</option>
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

            {/* 問題代碼跳轉篩選 */}
            <select
              value={selectedIssueCode}
              onChange={(e) => handleIssueCodeChange(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: '4px',
                border: selectedIssueCode ? '2px solid #d97706' : '1px solid var(--border-color)',
                fontSize: '0.8125rem',
                background: selectedIssueCode ? '#fffbeb' : '#fff',
                maxWidth: '180px',
              }}
            >
              <option value="">問題類型...</option>
              {/* 選項不硬寫筆數（09 §7：預期N人只屬 fixture）。
                  實際筆數由篩選後的同範圍查詢結果即時回填到「符合篩選／需確認」欄。 */}
              <option value="SCHEDULE_NOT_FOUND">排課缺漏（SCHEDULE_NOT_FOUND）</option>
              <option value="DUPLICATE_SUBJECT_ENROLLMENT">重複報名（DUPLICATE_SUBJECT_ENROLLMENT）</option>
              <option value="STAFF_FAMILY_NO_DISCOUNT">員工家屬無折扣（STAFF_FAMILY_NO_DISCOUNT）</option>
              <option value="CONFLICTING_NOTE_SOURCE">備註衝突（CONFLICTING_NOTE_SOURCE）</option>
              <option value="NUMERIC_POLICY_DIFFERENCE">數值政策差異（NUMERIC_POLICY_DIFFERENCE）</option>
              <option value="SCHEDULE_EMPTY">排課空時段（SCHEDULE_EMPTY）</option>
              <option value="UNKNOWN_WEEKDAY">未知星期（UNKNOWN_WEEKDAY）</option>
            </select>

            {/* 重置按鈕 */}
            {(searchQuery || selectedGrade || selectedClass || selectedSubject || selectedMismatch || selectedHasIssues || selectedIssueCode) && (
              <button
                type="button"
                className="btn-secondary"
                style={{ padding: '6px 10px', fontSize: '0.75rem', color: '#64748b' }}
                onClick={handleResetFilters}
              >
                重置篩選 ✕
              </button>
            )}
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

        {/* 待設定清單定位提示 */}
        {selectedClass && UNMAPPED_CLASSES.has(selectedClass) && (
          <div
            style={{
              margin: '0 16px 12px 16px',
              padding: '10px 14px',
              backgroundColor: '#fffbeb',
              border: '1px solid #fef3c7',
              borderRadius: '6px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.8125rem',
              color: '#92400e',
            }}
          >
            <span>
              <strong>待設定班級提示：</strong>班級「{selectedClass}」尚未建立排課時段或別名映射。
            </span>
            <a
              href="/settings"
              className="btn-secondary"
              style={{ padding: '2px 10px', fontSize: '0.75rem', background: '#ffffff' }}
            >
              前往課程設定 (Settings) 進行映射 ↗
            </a>
          </div>
        )}

        {/* 核對總表 */}
        <SummaryTable
          students={data?.items || []}
          loading={loading}
          onSelectStudent={(s) => setSelectedStudent(s)}
          onResetFilters={handleResetFilters}
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

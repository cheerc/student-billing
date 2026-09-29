'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import SummaryTable from './summary-table';
import DetailDrawer from './detail-drawer';
import ClassDeductionsPanel from './results/class-deductions-panel';
import { DeductionsResponse } from '@/application/schedule-deductions';
import { formatDateTime } from '@/lib/datetime';
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
  /** 班級扣天 read model（09 §5.2；與學生總表同一份 run 課表快照）。快照不可用時改傳 deductionsUnavailable。 */
  initialDeductions?: DeductionsResponse;
  /** 歷史 run 的課表快照不存在（或屬診斷軌）：明示資料不足、無法重建，不顯示表格（09 §5.2） */
  deductionsUnavailable?: { code: string; message: string };
  /**
   * 待設定班級（09 §8.3）：由伺服器依該 run 的課表快照與班名對應動態判斷，取代舊的寫死班名集合。
   * 選定班級在此清單內時顯示提示；null／未提供＝無法判斷，不顯示（不猜）。
   */
  unmappedClasses?: string[] | null;
  /** current＝目前使用的資料；history＝歷史資料（唯讀，來自匯入紀錄）。預設 current。 */
  mode?: 'current' | 'history';
  /** 資料來源（檔名與日期）；橫幅據此標示來源日期（09 §2）。 */
  source?: { fileName: string; importedAt: string; updatedAt: string };
}

export default function ActiveRunView({
  runId,
  revision,
  asOfDate,
  initialAvailableClasses,
  initialData,
  initialDeductions,
  deductionsUnavailable,
  unmappedClasses = null,
  mode = 'current',
  source,
}: ActiveRunViewProps) {
  const isHistory = mode === 'history';
  // 結果雙頁籤（09 §2／§5.2）：學生總表、班級扣天
  const [resultTab, setResultTab] = useState<'students' | 'deductions'>('students');
  const router = useRouter();
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

  // UX16：Esc 關閉學生明細抽屜
  useEffect(() => {
    if (!selectedStudent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedStudent(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedStudent]);

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
      {/* 資料來源橫幅（09 §2：來源時間／檔名一行，核對基準日另外標明）。
          現行資料與歷史資料用文字＋顏色區分；歷史資料為唯讀，不提供任何寫入動作（09 §8.3）。 */}
      <section
        className={`data-banner ${isHistory ? 'data-banner-history' : 'data-banner-current'}`}
        aria-label={isHistory ? '歷史資料' : '目前使用的資料'}
      >
        <div className="data-banner-main">
          <h1 className="data-banner-title">{isHistory ? '歷史資料（唯讀）' : '核對結果'}</h1>
          <p className="data-banner-line">
            {!isHistory && <span className="data-banner-label">目前使用的資料</span>}
            {source && <span className="data-banner-file">{source.fileName}</span>}
            {source && (
              <span className="data-banner-meta">
                {isHistory
                  ? `名單匯入於 ${formatDateTime(source.importedAt)} · 資料更新於 ${formatDateTime(source.updatedAt)}`
                  : `資料更新於 ${formatDateTime(source.updatedAt)}`}
              </span>
            )}
            <span className="pill">{`核對基準日 ${asOfDate}`}</span>
          </p>
        </div>
        <div className="data-banner-actions">
          {isHistory ? (
            <a href="/history" className="btn-secondary">回到匯入紀錄</a>
          ) : (
            <a href="/imports" className="btn-secondary">匯入新名單</a>
          )}
        </div>
      </section>

      {/* 技術資訊摺疊區（版本識別、長 ID 與計算說明入口收納於此，不在日常介面顯示，09 §7） */}
      <details className="tech-info tech-info-block">
        <summary>技術資訊</summary>
        <div className="tech-pre">
          {isHistory ? `Run ID：${runId}｜基準日 ${asOfDate}` : `Run ID：${runId}｜版本 rev ${revision}｜基準日 ${asOfDate}`}
        </div>
        <a
          href={`/api/v1/runs/${runId}/comparison?againstRuleSet=excel-v260922-compat`}
          target="_blank"
          rel="noopener noreferrer"
        >
          計算說明（雙軌差異 JSON）
        </a>
      </details>

      {/* 人數一行（09 §5.1）：本班N人 · 符合篩選M人 · N位需確認 —— 三者 scope 不同，不可互相冒充 */}
      <div className="counts-line" role="status" aria-live="polite">
        {/* 數字另以 data 屬性供自動化與螢幕閱讀器取用（文字節點間有標籤，不宜以純文字正則解析） */}
        <span className="counts-item">
          本班{' '}
          <strong data-count="class-scope">{stats.classScopeTotal}</strong> 人
        </span>
        <span className="counts-sep" aria-hidden="true">·</span>
        <span className="counts-item">
          符合篩選{' '}
          <strong data-count="matched">{data?.totalStudents ?? 0}</strong> 人
        </span>
        <span className="counts-sep" aria-hidden="true">·</span>
        <span className="counts-item">
          <strong data-count="needs-review">{stats.issuesCount}</strong> 位需確認
        </span>
        {stats.mismatchCount > 0 && (
          <>
            <span className="counts-sep" aria-hidden="true">·</span>
            <span className="counts-item">
              <strong data-count="mismatch">{stats.mismatchCount}</strong> 位計算天數與 ERP 登記不符
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

            {/* 級距比對篩選（筆數由查詢結果決定，不在文案寫死；09 §7） */}
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
              <option value="true">⚠ 僅顯示級距差異</option>
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

        {/* 待設定班級提示（09 §8.3）：依該 run 課表快照與班名對應動態判斷，不用寫死的班名清單 */}
        {selectedClass && unmappedClasses?.includes(selectedClass) && (
          <div className="notice-warn" role="status">
            <span>
              <strong>待設定班級提示：</strong>班級「{selectedClass}」還沒有對應的課表班級，扣天無法計算。
            </span>
            {!isHistory && (
              <a href="/settings" className="btn-secondary">前往課表設定，確認班名對應</a>
            )}
          </div>
        )}

        {/* 結果雙頁籤（09 §2） */}
        <div className="tabs" role="tablist" aria-label="結果頁籤">
          <button
            type="button"
            role="tab"
            aria-selected={resultTab === 'students'}
            className={resultTab === 'students' ? 'selected' : ''}
            onClick={() => setResultTab('students')}
          >
            學生總表
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={resultTab === 'deductions'}
            className={resultTab === 'deductions' ? 'selected' : ''}
            onClick={() => setResultTab('deductions')}
          >
            班級扣天
          </button>
        </div>

        {resultTab === 'students' ? (
          <SummaryTable
            students={data?.items || []}
            loading={loading}
            onSelectStudent={(s) => setSelectedStudent(s)}
            onResetFilters={handleResetFilters}
          />
        ) : (
          <ClassDeductionsPanel
            data={initialDeductions}
            unavailable={deductionsUnavailable}
            onEditClass={() => router.push('/settings?tab=schedule')}
          />
        )}
      </div>

      {/* 學生計算明細側欄 Drawer */}
      <DetailDrawer
        student={selectedStudent}
        onClose={() => setSelectedStudent(null)}
      />
    </div>
  );
}

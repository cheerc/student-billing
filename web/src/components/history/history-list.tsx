'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { HistoryEntry, HistoryStatus } from '@/application/history-view';
import { formatDateTime } from '@/lib/datetime';

/**
 * 匯入紀錄（specs/09 §2 次入口、§7 去技術化、§8.3 只讀；UX21 四態）。
 *
 * 日常欄位只放行政人員需要的：名單檔案、資料更新時間、核對基準日、人數、待確認、狀態。
 * Run／版本／長 ID／雜湊等技術資訊收進每列的摺疊區（可查、不占日常畫面）。
 * 這裡沒有任何寫入動作：不提供「恢復為現行」（09 §8.3）。
 */

const STATUS_LABEL: Record<HistoryStatus, string> = {
  current: '目前使用',
  history: '歷史資料',
  unused: '尚未使用',
};

type StatusFilter = HistoryStatus | 'all';

interface HistoryListProps {
  entries: HistoryEntry[];
  /** 初始檔名篩選（供伺服器端渲染測試空篩選態；使用者操作時由輸入框改變） */
  initialQuery?: string;
  initialStatus?: StatusFilter;
}

function TechInfo({ entry }: { entry: HistoryEntry }) {
  const t = entry.tech;
  return (
    <details className="tech-info">
      <summary>技術資訊</summary>
      <dl className="tech-list">
        {t.runId && (<><dt>Run ID</dt><dd>{t.runId}</dd></>)}
        <dt>匯入批次 ID</dt><dd>{t.importId}</dd>
        {t.scheduleVersionId && (<><dt>課表版本</dt><dd>{t.scheduleVersionId}</dd></>)}
        {t.ruleSetVersion && (<><dt>規則版本</dt><dd>{t.ruleSetVersion}</dd></>)}
        {t.numericPolicy && (<><dt>數值政策</dt><dd>{t.numericPolicy}</dd></>)}
        {t.sheetName && (<><dt>工作表</dt><dd>{t.sheetName}</dd></>)}
        {t.fileHash && (<><dt>檔案雜湊</dt><dd>{t.fileHash}</dd></>)}
      </dl>
    </details>
  );
}

export function HistoryList({ entries, initialQuery = '', initialStatus = 'all' }: HistoryListProps) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState<StatusFilter>(initialStatus);

  const current = entries.find((e) => e.status === 'current');
  const filtered = entries.filter(
    (e) => (status === 'all' || e.status === status) && (query.trim() === '' || e.fileName.includes(query.trim()))
  );
  const clearFilters = () => {
    setQuery('');
    setStatus('all');
  };

  return (
    <div className="history-page">
      <header className="page-header history-header">
        <div>
          <h1>匯入紀錄</h1>
          <p className="note">查看過去匯入的名單，以及當時的核對結果（唯讀）。</p>
        </div>
        <Link href="/imports" className="btn-primary">匯入新名單</Link>
      </header>

      <p className="history-current">
        {current
          ? `目前使用的資料：${current.fileName} · 資料更新於 ${formatDateTime(current.updatedAt)} · 核對基準日 ${current.asOfDate}`
          : '目前尚未使用任何名單。'}
      </p>

      {entries.length === 0 ? (
        <div className="state-card">
          <h2 className="state-title">還沒有匯入紀錄</h2>
          <p className="state-desc">匯入學生名單後，這裡會列出每一次的名單與當時的核對結果。</p>
          <Link href="/imports" className="btn-primary">匯入學生名單</Link>
        </div>
      ) : (
        <>
          <div className="toolbar history-toolbar">
            <div className="field">
              <label htmlFor="history-search">檔名</label>
              <input
                id="history-search"
                type="search"
                className="search"
                placeholder="輸入檔名關鍵字"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="history-status">狀態</label>
              <select
                id="history-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as StatusFilter)}
              >
                <option value="all">全部</option>
                <option value="current">{STATUS_LABEL.current}</option>
                <option value="history">{STATUS_LABEL.history}</option>
                <option value="unused">{STATUS_LABEL.unused}</option>
              </select>
            </div>
            <span className="note end" role="status" aria-live="polite">共 {filtered.length} 筆</span>
          </div>

          {filtered.length === 0 ? (
            <div className="state-card" role="status">
              <h2 className="state-title">沒有符合的紀錄</h2>
              <p className="state-desc">換一個檔名關鍵字或狀態試試，或清除篩選看全部紀錄。</p>
              <button type="button" className="btn-secondary" onClick={clearFilters}>清除篩選</button>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table history-table">
                <caption className="sr-only">匯入紀錄，由新到舊</caption>
                <thead>
                  <tr>
                    <th scope="col">名單檔案</th>
                    <th scope="col">資料更新時間</th>
                    <th scope="col">核對基準日</th>
                    <th scope="col" className="number">人數</th>
                    <th scope="col">待確認</th>
                    <th scope="col">狀態</th>
                    <th scope="col">查看</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.key} data-status={e.status}>
                      <th scope="row" className="history-file">
                        <span className="history-file-name">{e.fileName}</span>
                        <span className="subtle">{`名單匯入於 ${formatDateTime(e.importedAt)}`}</span>
                        <TechInfo entry={e} />
                      </th>
                      <td>{formatDateTime(e.updatedAt)}</td>
                      <td>{e.asOfDate ?? '—'}</td>
                      <td className="number">{`${e.studentCount} 人`}</td>
                      <td>
                        {e.issueCount === null
                          ? '—'
                          : e.issueCount > 0
                            ? <span className="badge badge-warn">{`${e.issueCount} 項待確認`}</span>
                            : '無待確認'}
                      </td>
                      <td>
                        <span className={`badge status-${e.status}`}>{STATUS_LABEL[e.status]}</span>
                      </td>
                      <td>
                        {e.runId ? (
                          <Link
                            href={`/history/${e.runId}`}
                            className="btn-secondary"
                            aria-label={`查看 ${e.fileName} 的當時結果`}
                          >
                            查看當時結果
                          </Link>
                        ) : (
                          <span className="subtle">尚無核對結果</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default HistoryList;

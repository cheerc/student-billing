import Link from 'next/link';
import { getDatabase } from '@/adapters/sqlite';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const db = getDatabase();
  const currentActive = getCurrentActiveRun(db);

  // 查詢所有計算 runs
  const runRows = db
    .prepare(`
      SELECT r.*, b.file_name
      FROM calculation_runs r
      LEFT JOIN import_batches b ON b.id = r.import_id
      ORDER BY r.created_at DESC
    `)
    .all() as any[];

  // 查詢所有匯入 batches
  const batchRows = db
    .prepare(`
      SELECT *
      FROM import_batches
      ORDER BY created_at DESC
    `)
    .all() as any[];

  return (
    <div>
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>批次清單與歷史 Run 查閱</h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            查閱所有歷史匯入批次與正式計算 Run。所有舊 Run 資料均受不可變性保護，無法被竄改。
          </p>
        </div>
        <Link href="/" className="btn-secondary">
          返回首頁核對
        </Link>
      </div>

      {/* 狀態摘要卡片 */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">目前啟用正式 Run</span>
          <span className="stat-value" style={{ fontSize: '1.25rem', color: '#166534' }}>
            {currentActive.activeRunId ? `rev ${currentActive.revision}` : '無'}
          </span>
          <span className="stat-sub">{currentActive.activeRunId || '尚未啟用正式 run'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">累計正式 Run 數</span>
          <span className="stat-value">{runRows.length}</span>
          <span className="stat-sub">所有版本均完整保留</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">累計匯入批次數</span>
          <span className="stat-value">{batchRows.length}</span>
          <span className="stat-sub">ready 與已啟用批次</span>
        </div>
      </div>

      {/* 正式計算 Run 歷程 */}
      <div className="table-container" style={{ marginBottom: '32px' }}>
        <div className="table-header">
          <div className="table-title">正式計算 Run 歷程清單 ({runRows.length})</div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>來源批次 / 檔案</th>
                <th>基準日</th>
                <th>學生人數</th>
                <th>規則集與政策</th>
                <th>問題統計</th>
                <th>狀態</th>
                <th>建立時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {runRows.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                    尚無任何正式計算 Run 記錄。
                  </td>
                </tr>
              ) : (
                runRows.map((r) => {
                  const isActive = r.id === currentActive.activeRunId;
                  const issues = JSON.parse(r.issue_counts || '{}') as Record<string, number>;
                  const issueCountTotal: number = Object.values(issues).reduce((sum, n) => sum + (Number(n) || 0), 0);

                  return (
                    <tr key={r.id} style={{ backgroundColor: isActive ? '#f0fdf4' : undefined }}>
                      <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.id}</td>
                      <td>
                        <span style={{ fontSize: '0.8125rem' }}>{r.file_name || r.import_id}</span>
                      </td>
                      <td>{r.as_of_date}</td>
                      <td>{r.total_students} 人</td>
                      <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        <div>{r.rule_set_version}</div>
                        <div>{r.numeric_policy}</div>
                      </td>
                      <td>
                        {issueCountTotal > 0 ? (
                          <span className="badge" style={{ backgroundColor: '#fef3c7', color: '#92400e' }}>
                            {issueCountTotal} 項待確認
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>正常</span>
                        )}
                      </td>
                      <td>
                        {isActive ? (
                          <span className="badge" style={{ backgroundColor: '#dcfce7', color: '#15803d', fontWeight: 700 }}>
                            現行 Active (rev {currentActive.revision})
                          </span>
                        ) : (
                          <span className="badge" style={{ backgroundColor: '#f1f5f9', color: '#64748b' }}>
                            歷史版本
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {new Date(r.created_at).toLocaleString('zh-TW')}
                      </td>
                      <td>
                        <a
                          href={`/api/v1/runs/${r.id}/students?limit=50`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-secondary"
                          style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                        >
                          學生資料 API ↗
                        </a>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 匯入批次歷程 */}
      <div className="table-container">
        <div className="table-header">
          <div className="table-title">匯入批次歷程清單 ({batchRows.length})</div>
          <Link href="/imports" className="btn-secondary" style={{ fontSize: '0.8125rem', padding: '4px 10px' }}>
            + 上傳新批次
          </Link>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>批次 ID</th>
                <th>來源檔名</th>
                <th>工作表</th>
                <th>學生筆數</th>
                <th>檔案雜湊 (SHA-256)</th>
                <th>狀態</th>
                <th>匯入時間</th>
                <th>說明</th>
              </tr>
            </thead>
            <tbody>
              {batchRows.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                    尚無任何匯入批次記錄。
                  </td>
                </tr>
              ) : (
                batchRows.map((b) => (
                  <tr key={b.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{b.id}</td>
                    <td style={{ fontWeight: 600 }}>{b.file_name}</td>
                    <td>{b.sheet_name || '-'}</td>
                    <td>{b.row_count} 人</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {b.file_hash.slice(0, 16)}...
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          backgroundColor: b.status === 'ready' ? '#dbeafe' : '#f1f5f9',
                          color: b.status === 'ready' ? '#1e40af' : '#475569',
                        }}
                      >
                        {b.status}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {new Date(b.created_at).toLocaleString('zh-TW')}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {b.scope_note || '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

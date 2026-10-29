'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import { ImportPreviewResult } from '@/application/import-preview';
import type { RosterChange } from '@/application/roster-changes';
import { StudentSnapshot } from '@/domain/students';
import { RosterChangesDetails } from './roster-changes-details';
import {
  describeActivateError,
  describeImportUploadError,
  failureFromException,
  readRawFailure,
  type UserFacingError,
} from '@/lib/user-messages';
import { ErrorNotice } from '@/components/ui/error-notice';
import { ClassNameReportSummaryCard } from '@/components/imports/class-name-report-summary';
import type { ClassNameReportSummary } from '@/application/class-name-match-report';
import { formatDateTime, todayInTaipei } from '@/lib/datetime';
import { announceImportActivated } from '@/lib/import-success-guide';

/**
 * 匯入預覽回應（含相對於現行名單的差異統計，specs/09 §4）。
 * rosterDiff.baseImportId 為 null 表示尚無任何名單可比較，統計欄位此時不適用。
 * 異動（changedStudents／changes）由 API 以 before/after 計算結果判定
 * （operator 裁決 d-20260929111803466480-4／-5），畫面只呈現、不自行推導。
 *
 * isDuplicate／duplicateReason 仍由 API 回傳（判重是後端行為，且 batchId 的解析需要它），
 * 但 #83 起畫面不消費：米豆奶每次匯出的檔名固定，「已經上傳過同名檔案」只會讓行政人員
 * 誤以為上傳失敗或選錯舊檔。詳見 preview route 的說明。
 */
type PreviewWithDiff = ImportPreviewResult & {
  isDuplicate?: boolean;
  duplicateReason?: 'same_file' | 'same_content';
  rosterDiff?: {
    baseImportId: string | null;
    newStudents: number;
    changedStudents: number;
    unchangedStudents: number;
    notAppearedStudents: number;
    /** 逐人明細：新增、異動、未出現（未異動者不列）。 */
    changes?: RosterChange[];
  };
  /**
   * 實際保存的批次 id。重傳同檔時判重會回傳既有批次（此時與 previewId 不同），
   * 啟用必須用這個 id，否則會以不存在的批次呼叫 activate 而失敗。
   */
  batchId?: string;
  /** 班名比對摘要（D1；04 §8 UX47）：兩份清單的班數與影響人數，連到課表設定的完整報告。 */
  classNameReport?: ClassNameReportSummary;
};

/**
 * 啟用要用「實際保存的批次 id」（batchId）。重傳同檔時 saveImportBatch 判重會回傳既有批次，
 * 此時 batchId 與本次 previewId 不同；用 previewId 呼叫 activate 會指向從未寫入的批次而失敗。
 * 舊回應沒有 batchId 時退回 previewId。
 */
export function resolveActivationImportId(preview: { previewId: string; batchId?: string }): string {
  return preview.batchId ?? preview.previewId;
}

interface ImportsWorkflowProps {
  initialStage?: 'upload' | 'preview' | 'success';
  initialPreview?: PreviewWithDiff | null;
  activatedCount?: number;
  currentRevision: number;
  lastScheduleSavedAt?: string | null;
}

export function ImportsWorkflow({
  initialStage = 'upload',
  initialPreview = null,
  activatedCount: defaultActivatedCount = 0,
  currentRevision,
  lastScheduleSavedAt = null,
}: ImportsWorkflowProps) {
  const [stage, setStage] = useState<'upload' | 'preview' | 'success'>(initialStage);
  const [preview, setPreview] = useState<PreviewWithDiff | null>(initialPreview);
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<UserFacingError | null>(null);
  /**
   * 啟用的 CAS 版本。必須是「本頁自己看得見」的版本——初值來自 server render，
   * 之後只由本頁剛完成的啟用回應更新；不可在啟用前向伺服器討要最新值，否則會消滅
   * 「另一視窗已啟用」的衝突偵測。每完成一次啟用，伺服器 revision 就前進一次。
   *
   * #84 移除完成畫面的「再匯入其他名單」之後，同一頁面 session 內第二次啟用的產品路徑
   * 已不存在：完成畫面唯一可點的項目是導向 `/` 的連結，會讓 pathname 改變並重掛載元件樹，
   * `revision` 隨之回到 server render 的最新值。這一行因而在現行架構下沒有可達的測試覆蓋
   * （原先守護它的 R4-F02 同頁連續啟用路徑隨該按鈕一同消失）——詳見
   * tests/e2e/r4-f02-reimport-activate.spec.ts 檔頭。它本身仍是正確且必要的：若日後
   * 重新提供同頁連續啟用的入口，這一行就是讓第二次啟用不會誤判 409 的關鍵。
   */
  const [revision, setRevision] = useState(currentRevision);
  // 核對基準日預設＝台北的今天（O02：不用 UTC 或瀏覽器時區）
  const [asOfDate, setAsOfDate] = useState(() => todayInTaipei());
  const [activatedCount, setActivatedCount] = useState(defaultActivatedCount);

  // 篩選與搜尋狀態
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'with-class' | 'no-class' | 'withdrawn'>('all');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 課表儲存時間：全站統一 Asia/Taipei、YYYY-MM-DD HH:mm（O02）
  const scheduleTimeLabel = lastScheduleSavedAt
    ? `${formatDateTime(lastScheduleSavedAt)} 已儲存`
    : '已載入初始課表，請確認';

  // 檔案上傳與預覽處理
  const handleFileUpload = async (file: File) => {
    if (!file.name.endsWith('.xlsx')) {
      setError({ message: '僅支援 .xlsx 格式之試算表檔案，不支援 .xls、CSV 或其他格式。', detail: '' });
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

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // D39：白話主文；錯誤代碼與原始訊息只在「詳細資訊」
        setError(describeImportUploadError(readRawFailure(res.status, data)));
        return;
      }

      setPreview(data);
      setStage('preview');
    } catch (err) {
      setError(describeImportUploadError(failureFromException(err)));
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

  // 啟用名單 (使用這份名單)
  const handleActivate = async () => {
    if (!preview) return;

    setActivating(true);
    setError(null);

    try {
      const idempotencyKey = `ui-act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // 啟用以「實際保存的批次 id」：重傳同檔時 previewId 與 batchId 不同（判重回傳既有批次）
      const batchId = resolveActivationImportId(preview);
      const res = await fetch(`/api/v1/imports/${batchId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: revision,
          idempotencyKey,
          asOfDate,
        }),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(describeActivateError(readRawFailure(res.status, json)));
        return;
      }

      // 本頁剛完成的啟用所回傳的新版本，成為下一次啟用的 expectedRevision（R4-F02）。
      // 只信任啟用回應本體，不在此刻另外讀取伺服器狀態——那會掩蓋並行衝突。
      if (typeof json?.revision === 'number') setRevision(json.revision);
      setActivatedCount(preview.stats.totalStudents);
      // #84：通知側邊欄指向「03 核對結果」（本頁的按鈕之外的第二個導引出口）。
      announceImportActivated();
      setStage('success');
    } catch (err) {
      setError(describeActivateError(failureFromException(err)));
    } finally {
      setActivating(false);
    }
  };

  // 篩選學生清單
  const filteredStudents = (preview?.students || []).filter((s: StudentSnapshot) => {
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
    <div className="imports-workflow-container">
      {/* 頁面標頭與課表連結 */}
      <header className="page-header" style={{ marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '0 0 6px' }}>匯入學生</h1>
          <p className="note" style={{ margin: 0 }}>
            上傳米豆奶名單，更新學生的收費資料。
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <Link href="/settings?tab=schedule" className="btn-secondary">
            查看課表 →
          </Link>
        </div>
      </header>

      {/* 流程三步驟標示 */}
      <div className="step-indicator" role="navigation" aria-label="匯入進度步驟">
        <div className={`step-item ${stage === 'upload' ? 'step-active' : 'step-done'}`}>
          <span className="step-number">1</span>
          <span className="step-text">選擇檔案</span>
        </div>
        <div className="step-divider" aria-hidden="true" />
        <div className={`step-item ${stage === 'preview' ? 'step-active' : stage === 'success' ? 'step-done' : ''}`}>
          <span className="step-number">2</span>
          <span className="step-text">確認名單</span>
        </div>
        <div className="step-divider" aria-hidden="true" />
        <div className={`step-item ${stage === 'success' ? 'step-active' : ''}`}>
          <span className="step-number">3</span>
          <span className="step-text">完成</span>
        </div>
      </div>

      {/* 目前課表儲存時間提示 */}
      <div className="schedule-meta-note">
        <span className="dot dot-clean" aria-hidden="true" style={{ width: '7px', height: '7px' }} />
        <span>目前課表：{scheduleTimeLabel}</span>
      </div>

      {/* 錯誤警示 */}
      {error && (
        <ErrorNotice title="操作錯誤：" message={error.message} detail={error.detail} style={{ marginBottom: '20px' }} />
      )}

      {/* 階段 1：選擇檔案 (Upload) */}
      {stage === 'upload' && (
        <div
          className="upload-dropzone card"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="upload-icon-circle">↑</div>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
            {loading ? '正在解析試算表...' : '上傳米豆奶匯出的學生Excel'}
          </h2>
          <p className="note" style={{ marginBottom: '24px' }}>
            支援 .xlsx，請選擇最新的學生資料。
          </p>

          <input
            type="file"
            ref={fileInputRef}
            className="file-input-hidden"
            accept=".xlsx"
            onChange={handleFileChange}
            disabled={loading}
            aria-label="選擇 Excel 檔案"
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
      )}

      {/* 階段 2：確認名單 (Preview) */}
      {stage === 'preview' && preview && (
        <div className="preview-stage-container">
          <div className="card" style={{ marginBottom: '20px' }}>
            <div className="toolbar">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontWeight: 700, fontSize: '15px' }}>{preview.fileName}</span>
                <span className="note">尚未使用這份名單，目前的核對結果不會改變。</span>
              </div>
              <button
                type="button"
                className="btn-secondary end"
                onClick={() => {
                  setStage('upload');
                  setPreview(null);
                }}
              >
                重新選擇檔案
              </button>
            </div>

            {/* 統計指標卡片 */}
            <div className="stats-grid" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
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
                <span className="stat-sub">至少報名一門班級</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">無課程</span>
                <span className="stat-value" style={{ color: '#d97706' }}>
                  {preview.stats.studentsWithoutClass}
                </span>
                <span className="stat-sub">請至米豆奶辦理離籍</span>
                {preview.stats.studentsWithoutClass > 0 && (
                  <button type="button" className="link-button" onClick={() => setFilterMode('no-class')}>
                    只看無課程的學生
                  </button>
                )}
              </div>
              <div className="stat-card">
                <span className="stat-label">離班標記人數</span>
                <span className="stat-value" style={{ color: '#dc2626' }}>
                  {preview.stats.withdrawnStudentsCount}
                </span>
                <span className="stat-sub">標有 (離班日期) 之學生</span>
              </div>
            </div>

            {/* 相對於現行名單的差異統計（specs/09 §4：需 API 真實提供；異動以計算結果判定） */}
            {preview.rosterDiff && preview.rosterDiff.baseImportId !== null && (
              <>
                <div className="roster-diff-bar" role="status">
                  <span className="roster-diff-label">與目前名單相比</span>
                  <span className="roster-diff-item" data-diff="new">
                    新增 <strong>{preview.rosterDiff.newStudents}</strong> 人
                  </span>
                  <span className="roster-diff-item" data-diff="changed">
                    異動 <strong>{preview.rosterDiff.changedStudents}</strong> 人
                  </span>
                  <span className="roster-diff-item" data-diff="not-appeared">
                    未出現 <strong>{preview.rosterDiff.notAppearedStudents}</strong> 人
                  </span>
                </div>
                <div className="roster-changes-wrap">
                  <RosterChangesDetails changes={preview.rosterDiff.changes ?? []} />
                </div>
              </>
            )}

            {/*
              匯入注意事項（Rework B1，PR #31 REJECTED）：
              erp-reader 對空白人員代碼等狀況會記 issue 後略過該列，該列不進名冊。
              這裡必須照實呈現（含列號／欄名／原因），否則畫面只顯示總人數、
              使用者無從得知有學生被略過而未計入（違反 D17 照實呈現、specs/09 §4）。
              刻意放在班級名稱提示之前：被略過的資料列比班名待確認更需要優先處理。
            */}
            {preview.issues.length > 0 && (
              <div className="alert alert-warning issues-alert" style={{ margin: '16px 20px 0' }}>
                <strong>匯入注意事項：</strong>
                <ul style={{ paddingLeft: '20px', marginTop: '6px' }}>
                  {preview.issues.map((issue, idx) => (
                    <li key={idx}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 未知班名提示 */}
            {preview.pendingClasses.length > 0 && (
              <div className="alert alert-warning" style={{ margin: '16px 20px 0' }}>
                <strong>班級名稱提示：</strong>
                <span>本次匯入名冊中發現 {preview.pendingClasses.length} 個班名待確認。您可以在啟用後至「課表設定 → 班名同步」逐列處理。</span>
              </div>
            )}

            {/* 班名比對摘要：使用這份名單之前先看到兩份清單的班數與影響人數，可連到完整報告（D1） */}
            {preview.classNameReport && <ClassNameReportSummaryCard summary={preview.classNameReport} />}

            {/* 學生名單表格與篩選操作 */}
            <div style={{ padding: '16px 20px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ fontWeight: 600, fontSize: '14px' }}>
                  名單預覽 ({filteredStudents.length} / {preview.students.length})
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="搜尋姓名或代碼..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="search"
                    style={{ width: '200px' }}
                    aria-label="搜尋預覽學生"
                  />
                  <select
                    value={filterMode}
                    onChange={(e) => setFilterMode(e.target.value as 'all' | 'with-class' | 'no-class' | 'withdrawn')}
                    aria-label="篩選學生狀態"
                  >
                    <option value="all">全部學生 ({preview.stats.totalStudents})</option>
                    <option value="with-class">有班級 ({preview.stats.studentsWithClass})</option>
                    <option value="no-class">無課程 ({preview.stats.studentsWithoutClass})</option>
                    <option value="withdrawn">有離班標記 ({preview.stats.withdrawnStudentsCount})</option>
                  </select>
                </div>
              </div>

              <div className="scroll table-scroll-container" style={{ maxHeight: '420px', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '48px' }}>序號</th>
                      <th>人員代碼</th>
                      <th>姓名</th>
                      <th>年級</th>
                      <th>所屬分校</th>
                      <th>報名班級</th>
                      <th>標籤</th>
                      <th>備註</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStudents.slice(0, 100).map((stu, idx) => (
                      <tr key={stu.personCode}>
                        <td style={{ color: 'var(--text-muted)' }}>{idx + 1}</td>
                        <td className="code-text" style={{ fontWeight: 600 }}>{stu.personCode}</td>
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
                                  {enr.previewErpBillingTier !== undefined && enr.previewErpBillingTier !== null && (
                                    <span className="badge badge-tier">
                                      設定預覽級距: {enr.previewErpBillingTier} 天
                                      {/*
                                        Rework B2：(預設) 表示該級距是解析失敗後採用的預設值，
                                        非 米豆奶 原始登記值。移除此標記會讓使用者把預設值
                                        誤認為實登值，直接影響級距差異的判讀基礎。
                                      */}
                                      {enr.previewTierParseStatus === 'defaulted' ? ' (預設)' : ''}
                                    </span>
                                  )}
                                  {enr.previewErpBillingTier === null && enr.previewTierParseStatus === 'unavailable' && (
                                    <span className="badge badge-warn">級距待設定／無法判定</span>
                                  )}
                                  {/*
                                    Rework B2：離班徽章。篩選器與統計卡雖有離班資訊，
                                    但表格必須看得出是哪幾位學生離班。
                                  */}
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
            </div>

            {/* 底部啟用操作列 */}
            <div className="tablefoot" style={{ marginTop: '16px', padding: '16px 20px', background: '#f8fafc', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600 }}>
                <span>核對基準日</span>
                <input
                  type="date"
                  value={asOfDate}
                  onChange={(e) => setAsOfDate(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
                  aria-label="核對基準日"
                />
              </label>

              <button
                type="button"
                className="btn-primary"
                onClick={handleActivate}
                disabled={activating}
                style={{ minWidth: '140px' }}
              >
                {activating ? '啟用計算中...' : '使用這份名單'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 階段 3：完成 (Success) */}
      {stage === 'success' && (
        <div className="success-stage-card card" style={{ padding: '48px 24px', textAlign: 'center', maxWidth: '640px', margin: '24px auto' }}>
          <div style={{ display: 'inline-block', marginBottom: '16px' }}>
            <span className="pill ok" style={{ fontSize: '14px', padding: '4px 12px' }}>✓ 已更新</span>
          </div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>
            {activatedCount} 位學生資料已備妥
          </h2>
          {/*
            #84：每次匯入都是「以新資料替換現行資料」，不是疊加。
            「再匯入其他名單」會讓行政人員誤以為系統支援追加匯入，故整個移除；
            重新匯入的路徑就是側邊欄的「02 匯入學生」，不需要在完成畫面另開一個按鈕。
          */}
          <p className="note" style={{ fontSize: '14px', marginBottom: '28px' }}>
            系統已依最新課表完成排課衝堂與天數扣除計算，請前往「03 核對結果」查看各班天數與折扣。
          </p>

          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Link href="/" className="btn-primary" style={{ padding: '10px 20px', fontSize: '15px' }}>
              前往核對結果 →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
export default ImportsWorkflow;

'use client';

import React, { useState, useMemo } from 'react';
import {
  SettingsDraft,
  ScheduleGridRow,
  classesToGridRows,
  gridRowsToClasses,
  timeStringToMinutes,
  minutesToTimeString,
  buildSeedGridRows,
  detectSplitClasses,
} from '@/contracts/settings';

interface Candidate {
  rawBaseName: string;
  targetBaseName: string;
  reason: string;
  category?: 'D18' | 'D22';
  isValid?: boolean;
}

const TIME_FORMAT_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface SettingsEditorProps {
  importId: string;
  currentRevision: number;
  initialDraft: SettingsDraft;
  unmatched: string[];
  seedNotAppeared: string[];
  matchedCount: number;
  candidates: Candidate[];
}

export default function SettingsEditor({
  importId,
  currentRevision,
  initialDraft,
  unmatched,
  seedNotAppeared,
  matchedCount,
  candidates,
}: SettingsEditorProps) {
  const [draft, setDraft] = useState<SettingsDraft>(initialDraft);

  // 初始化平鋪時段列（對齊 S 表 R4:E96 89 筆）
  const initialRows = useMemo(() => {
    const fromClasses = classesToGridRows(initialDraft.classes);
    if (fromClasses.length > 0) return fromClasses;
    return buildSeedGridRows();
  }, [initialDraft]);

  const [rows, setRows] = useState<ScheduleGridRow[]>(initialRows);
  const [preview, setPreview] = useState<any>(null);
  const [applied, setApplied] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 新增時段列輸入狀態
  const [newClassName, setNewClassName] = useState('');
  const [newTeacher, setNewTeacher] = useState('');
  const [newWeekday, setNewWeekday] = useState('六');
  const [newStartTime, setNewStartTime] = useState('13:00');
  const [newEndTime, setNewEndTime] = useState('15:00');

  // N1: 起訖時間檢驗 (格式合法性 + 起 < 迄)
  const rowTimeErrors = useMemo(() => {
    const errMap = new Map<string, string>();
    for (const r of rows) {
      if (r.startTime !== '' && !TIME_FORMAT_REGEX.test(r.startTime)) {
        errMap.set(r.rowId, '起始時間格式必須為 HH:mm');
        continue;
      }
      if (r.endTime !== '' && !TIME_FORMAT_REGEX.test(r.endTime)) {
        errMap.set(r.rowId, '結束時間格式必須為 HH:mm');
        continue;
      }
      if (r.startMinutes !== null && r.endMinutes !== null && r.startMinutes >= r.endMinutes) {
        errMap.set(r.rowId, '結束時間 (迄) 必須大於起始時間 (起)');
        continue;
      }
      if ((r.startMinutes !== null && r.endMinutes === null) || (r.startMinutes === null && r.endMinutes !== null)) {
        errMap.set(r.rowId, '時段起訖必須同時填寫');
        continue;
      }
    }
    return errMap;
  }, [rows]);

  // D28: 班級改散警告（原同名多時段班級被拆散改名）
  const splitWarnings = useMemo(() => {
    return detectSplitClasses(initialRows, rows);
  }, [initialRows, rows]);

  const hasTimeErrors = rowTimeErrors.size > 0;

  // F1 rework: 班級名稱清空檢查（與 hasTimeErrors 同級阻擋 preview）
  const hasEmptyClassName = useMemo(() => {
    return rows.some((r) => r.className.trim() === '');
  }, [rows]);

  const toggleAlias = (raw: string, target: string) => {
    setDraft((prev) => {
      const exists = prev.aliases.some((a) => a.rawBaseName === raw && a.targetBaseName === target);
      return {
        ...prev,
        aliases: exists
          ? prev.aliases.filter((a) => !(a.rawBaseName === raw && a.targetBaseName === target))
          : [...prev.aliases, { rawBaseName: raw, targetBaseName: target }],
      };
    });
    setPreview(null);
    setApplied(null);
  };

  // D28: 逐列改名
  const updateRowClassName = (rowId: string, className: string) => {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, className } : r))
    );
    setPreview(null);
    setApplied(null);
  };

  // 星期欄位編輯（僅供顯示與點名表，不影響扣天）
  const updateRowWeekday = (rowId: string, weekday: string) => {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, weekday } : r))
    );
    setPreview(null);
    setApplied(null);
  };

  // D29: 單列刪除時段
  const deleteSessionRow = (rowId: string) => {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
    setPreview(null);
    setApplied(null);
  };

  const updateRowTeacher = (rowId: string, teacher: string) => {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, teacher: teacher || null } : r))
    );
    setPreview(null);
    setApplied(null);
  };

  // N1: 即時同步計算分鐘數，非法格式時將分鐘設為 null 以觸發檢驗錯誤
  const updateRowTime = (rowId: string, field: 'startTime' | 'endTime', value: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId) return r;
        const updated = { ...r, [field]: value };
        const startVal = field === 'startTime' ? value : r.startTime;
        const endVal = field === 'endTime' ? value : r.endTime;
        updated.startMinutes = timeStringToMinutes(startVal);
        updated.endMinutes = timeStringToMinutes(endVal);
        return updated;
      })
    );
    setPreview(null);
    setApplied(null);
  };

  // 停用班級一律軟停用（active=false），停用不硬刪
  const toggleClassActive = (className: string) => {
    setRows((prev) => {
      const isCurrentlyActive = prev.some((r) => r.className === className && r.active);
      return prev.map((r) =>
        r.className === className ? { ...r, active: !isCurrentlyActive } : r
      );
    });
    setPreview(null);
    setApplied(null);
  };

  const addSessionRow = () => {
    const name = newClassName.trim();
    if (!name) return;
    const startMin = timeStringToMinutes(newStartTime) ?? 780;
    const endMin = timeStringToMinutes(newEndTime) ?? 900;
    const newRow: ScheduleGridRow = {
      rowId: `user-row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      className: name,
      teacher: newTeacher.trim() || null,
      weekday: newWeekday.trim() || '六',
      startTime: minutesToTimeString(startMin),
      endTime: minutesToTimeString(endMin),
      startMinutes: startMin,
      endMinutes: endMin,
      active: true,
    };
    setRows((prev) => [...prev, newRow]);
    setNewClassName('');
    setNewTeacher('');
    setPreview(null);
    setApplied(null);
  };

  const doPreview = async () => {
    if (hasEmptyClassName) {
      setError('排課表格中存在班級名稱為空的時段列，請填寫班級名稱後再行預覽。');
      return;
    }
    if (hasTimeErrors) {
      setError('排課表格中存在起訖時間倒置（起大於等於迄），請修正後再行預覽。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const currentClasses = gridRowsToClasses(rows, draft.classes);
      const updatedDraft: SettingsDraft = {
        ...draft,
        classes: currentClasses,
      };
      const res = await fetch('/api/v1/settings/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importId, draft: updatedDraft, expectedRevision: currentRevision }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '預覽失敗');
      setPreview(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      // idempotencyKey 附加隨機後綴防範衝突
      const idempotencyKey = `ui-apply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await fetch('/api/v1/settings/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewId: preview.previewId,
          expectedRevision: currentRevision,
          idempotencyKey,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error(
            '設定版本衝突 (409)：目前系統版本已推進，先前預覽草稿已過期 (stale preview)。請重新點擊「預覽影響 (dry-run)」更新草稿後再行套用。'
          );
        }
        if (res.status === 400 && (json.error?.includes('PREVIEW_EXPIRED') || json.error?.includes('逾期'))) {
          throw new Error(
            '設定預覽已逾期 (400 PREVIEW_EXPIRED)：預覽有效期限為 15 分鐘，請重新點擊「預覽影響 (dry-run)」後再行套用。'
          );
        }
        throw new Error(json.error || '套用失敗');
      }
      setApplied(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {/* 全科別初始總量 */}
      <div className="meta-panel">
        <div className="meta-item">
          <span className="meta-item-label">自動候選</span>
          <span className="meta-item-val">{matchedCount} 個 baseName</span>
        </div>
        <div className="meta-item">
          <span className="meta-item-label">待設定</span>
          <span className="meta-item-val">{unmatched.length} 個 baseName</span>
        </div>
        <div className="meta-item">
          <span className="meta-item-label">seed 本批未出現</span>
          <span className="meta-item-val">{seedNotAppeared.length} 個 baseName</span>
        </div>
        <div className="meta-item">
          <span className="meta-item-label">目前 revision</span>
          <span className="meta-item-val">rev {currentRevision}</span>
        </div>
      </div>

      {/* 具名漂移候選確認（D18 ＋ D22） */}
      <div className="table-container" style={{ marginBottom: '20px' }}>
        <div className="table-header">
          <div className="table-title">具名漂移候選確認（D18 ＋ D22，需人工逐項確認，軟體不自動批准）</div>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {candidates.map((c) => {
            const checked = draft.aliases.some(
              (a) => a.rawBaseName === c.rawBaseName && a.targetBaseName === c.targetBaseName
            );
            const isTargetValid = c.isValid !== false;
            return (
              <label
                key={`${c.rawBaseName}→${c.targetBaseName}`}
                style={{
                  display: 'flex',
                  gap: '8px',
                  alignItems: 'center',
                  fontSize: '0.875rem',
                  opacity: isTargetValid ? 1 : 0.6,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!isTargetValid}
                  onChange={() => isTargetValid && toggleAlias(c.rawBaseName, c.targetBaseName)}
                />
                <span>
                  {c.category && (
                    <span className="badge" style={{ fontSize: '0.75rem', marginRight: '6px' }}>{c.category}</span>
                  )}
                  <strong>{c.rawBaseName}</strong> → <strong>{c.targetBaseName}</strong>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>{c.reason}</span>
                  {!isTargetValid && (
                    <span style={{ color: '#ef4444', fontSize: '0.75rem', marginLeft: '6px' }}>
                      （目標班級已停用或未設定）
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* 雙向對照同畫面並列 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
        <div className="table-container">
          <div className="table-header">
            <div className="table-title">待設定清單（{unmatched.length}）</div>
          </div>
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '260px', overflowY: 'auto' }}>
            {unmatched.map((b) => (
              <div key={b} style={{ fontSize: '0.8125rem' }}>
                <span className="badge badge-class">{b}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="table-container">
          <div className="table-header">
            <div className="table-title">seed 本批未出現（{seedNotAppeared.length}）</div>
          </div>
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '260px', overflowY: 'auto' }}>
            {seedNotAppeared.map((b) => (
              <div key={b} style={{ fontSize: '0.8125rem' }}>
                <span className="badge badge-class">{b}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* D1: S表五欄平鋪排課設定表格 */}
      <div className="table-container" style={{ marginBottom: '20px' }}>
        <div className="table-header">
          <div className="table-title">
            S 表平鋪排課設定（共 {rows.length} 筆時段列）
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '8px' }}>
              （五欄皆可逐列編輯；星期僅供顯示與點名表，不影響衝堂扣天）
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="班級名稱 (如 兒童美語-Gino)"
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem' }}
            />
            <input
              type="text"
              placeholder="老師 (選填)"
              value={newTeacher}
              onChange={(e) => setNewTeacher(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem', width: '100px' }}
            />
            <input
              type="text"
              placeholder="星期 (如 六)"
              value={newWeekday}
              onChange={(e) => setNewWeekday(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem', width: '70px' }}
            />
            <input
              type="text"
              placeholder="起 (13:00)"
              value={newStartTime}
              onChange={(e) => setNewStartTime(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem', width: '75px' }}
            />
            <input
              type="text"
              placeholder="迄 (15:00)"
              value={newEndTime}
              onChange={(e) => setNewEndTime(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem', width: '75px' }}
            />
            <button type="button" className="btn-secondary" onClick={addSessionRow}>
              新增時段
            </button>
          </div>
        </div>
        {splitWarnings.length > 0 && (
          <div style={{ padding: '8px 16px', background: '#fef3c7', color: '#92400e', fontSize: '0.8125rem', borderBottom: '1px solid #fde68a' }}>
            <strong>⚠ 班級改散警告 (D28)：</strong> 偵測到以下多時段班級被拆散改名為不同班名，請確認是否為業務本意：
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              {splitWarnings.map((w) => (
                <li key={w.originalName}>
                  原班名 <strong>{w.originalName}</strong> 已拆為：{w.splitNames.join('、')}
                </li>
              ))}
            </ul>
          </div>
        )}
        {hasTimeErrors && (
          <div style={{ padding: '8px 16px', background: '#fee2e2', color: '#b91c1c', fontSize: '0.8125rem' }}>
            ⚠ 表格中存在結束時間 (迄) 小於或等於起始時間 (起) 之無效時段，請修正紅框欄位。
          </div>
        )}
        <div className="table-scroll" style={{ maxHeight: '480px' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '200px' }}>班級名稱</th>
                <th style={{ width: '130px' }}>帶班老師</th>
                <th style={{ width: '80px' }}>星期</th>
                <th style={{ width: '110px' }}>上課時間(起)</th>
                <th style={{ width: '110px' }}>上課時間(迄)</th>
                <th style={{ width: '120px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const hasErr = rowTimeErrors.has(r.rowId);
                return (
                  <tr key={r.rowId} style={{ opacity: r.active ? 1 : 0.55 }}>
                    <td>
                      <input
                        type="text"
                        value={r.className}
                        onChange={(e) => updateRowClassName(r.rowId, e.target.value)}
                        placeholder="班級名稱"
                        style={{
                          padding: '4px 8px',
                          borderRadius: '4px',
                          border: r.className.trim() === '' ? '1px solid #ef4444' : '1px solid var(--border-color)',
                          fontSize: '0.8125rem',
                          width: '100%',
                          fontWeight: 600,
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={r.teacher ?? ''}
                        placeholder="未設定"
                        onChange={(e) => updateRowTeacher(r.rowId, e.target.value)}
                        style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem', width: '100%' }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={r.weekday}
                        onChange={(e) => updateRowWeekday(r.rowId, e.target.value)}
                        placeholder="星期"
                        style={{
                          padding: '4px 6px',
                          borderRadius: '4px',
                          border: '1px solid var(--border-color)',
                          fontSize: '0.8125rem',
                          width: '55px',
                        }}
                        title="星期僅供顯示與點名表，不影響衝堂扣天"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={r.startTime}
                        onChange={(e) => updateRowTime(r.rowId, 'startTime', e.target.value)}
                        style={{
                          padding: '4px 8px',
                          borderRadius: '4px',
                          border: hasErr ? '1px solid #ef4444' : '1px solid var(--border-color)',
                          background: hasErr ? '#fef2f2' : undefined,
                          fontSize: '0.8125rem',
                          width: '75px',
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={r.endTime}
                        onChange={(e) => updateRowTime(r.rowId, 'endTime', e.target.value)}
                        style={{
                          padding: '4px 8px',
                          borderRadius: '4px',
                          border: hasErr ? '1px solid #ef4444' : '1px solid var(--border-color)',
                          background: hasErr ? '#fef2f2' : undefined,
                          fontSize: '0.8125rem',
                          width: '75px',
                        }}
                      />
                      {hasErr && (
                        <div style={{ color: '#ef4444', fontSize: '0.6875rem', marginTop: '2px' }}>
                          起≥迄倒置
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          type="button"
                          className="btn-secondary"
                          style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                          onClick={() => toggleClassActive(r.className)}
                          title="停用班級保留歷史（不硬刪）"
                        >
                          {r.active ? '停用' : '啟用'}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          style={{ padding: '2px 8px', fontSize: '0.75rem', color: '#b91c1c' }}
                          onClick={() => deleteSessionRow(r.rowId)}
                          title="刪除此時段列"
                        >
                          刪除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* preview / apply 操作 */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
        <button
          type="button"
          className="btn-primary"
          onClick={doPreview}
          disabled={busy || hasTimeErrors || hasEmptyClassName}
        >
          {busy ? '處理中...' : '預覽影響 (dry-run)'}
        </button>
        <button type="button" className="btn-secondary" onClick={doApply} disabled={busy || !preview}>
          套用並重算
        </button>
        {preview && (
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', alignSelf: 'center' }}>
            previewId: {preview.previewId} · expiresAt: {preview.expiresAt?.slice(11, 19)} · inputHash: {String(preview.inputHash).slice(0, 12)}…
          </span>
        )}
      </div>

      {/* preview 結果 */}
      {preview && (
        <div className="table-container" style={{ marginBottom: '20px' }}>
          <div className="table-header">
            <div className="table-title">
              影響預覽：{preview.affectedStudents} 人天數變化 · mismatch {preview.mismatchBefore} → {preview.mismatchAfter}
            </div>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>人員代碼</th>
                  <th>姓名</th>
                  <th>變更前天數</th>
                  <th>變更後天數</th>
                </tr>
              </thead>
              <tbody>
                {(preview.dayDeltas as any[]).slice(0, 50).map((d) => (
                  <tr key={d.personCode}>
                    <td style={{ fontFamily: 'monospace' }}>{d.personCode}</td>
                    <td>{d.name}</td>
                    <td>{d.before ?? '-'}</td>
                    <td style={{ fontWeight: 700 }}>{d.after ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* apply 結果 */}
      {applied && (
        <div className="alert alert-success">
          已套用並重算：settingsVersion {applied.settingsVersionId} · 新 run {applied.runId} ·
          revision {applied.revision} · mismatch {applied.mismatchCount} 筆
        </div>
      )}
    </div>
  );
}

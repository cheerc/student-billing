'use client';

import React, { useState } from 'react';
import { SettingsDraft } from '@/contracts/settings';

interface Candidate {
  rawBaseName: string;
  targetBaseName: string;
  reason: string;
}

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
  const [preview, setPreview] = useState<any>(null);
  const [applied, setApplied] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newClassName, setNewClassName] = useState('');
  const [newClassTeacher, setNewClassTeacher] = useState('');

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

  const toggleClassActive = (baseName: string) => {
    setDraft((prev) => ({
      ...prev,
      classes: prev.classes.map((c) =>
        c.baseName === baseName ? { ...c, active: !c.active } : c
      ),
    }));
    setPreview(null);
    setApplied(null);
  };

  const updateTeacher = (baseName: string, teacher: string) => {
    setDraft((prev) => ({
      ...prev,
      classes: prev.classes.map((c) =>
        c.baseName === baseName ? { ...c, teacher: teacher || null } : c
      ),
    }));
    setPreview(null);
    setApplied(null);
  };

  const addClass = () => {
    const name = newClassName.trim();
    if (!name) return;
    setDraft((prev) => ({
      ...prev,
      classes: [
        ...prev.classes,
        {
          baseName: name,
          subject: '其他',
          teacher: newClassTeacher.trim() || null,
          active: true,
          sessions: [],
        },
      ],
    }));
    setNewClassName('');
    setNewClassTeacher('');
    setPreview(null);
    setApplied(null);
  };

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/settings/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importId, draft, expectedRevision: currentRevision }),
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
      const res = await fetch('/api/v1/settings/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewId: preview.previewId,
          expectedRevision: currentRevision,
          idempotencyKey: `ui-apply-${Date.now()}`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '套用失敗');
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

      {/* D18 候選區 */}
      <div className="table-container" style={{ marginBottom: '20px' }}>
        <div className="table-header">
          <div className="table-title">D18 已確認候選（需人工一次確認，軟體不自動批准）</div>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {candidates.map((c) => {
            const checked = draft.aliases.some(
              (a) => a.rawBaseName === c.rawBaseName && a.targetBaseName === c.targetBaseName
            );
            return (
              <label key={`${c.rawBaseName}→${c.targetBaseName}`} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '0.875rem' }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleAlias(c.rawBaseName, c.targetBaseName)}
                />
                <span>
                  <strong>{c.rawBaseName}</strong> → <strong>{c.targetBaseName}</strong>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>{c.reason}</span>
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

      {/* 班級 CRUD */}
      <div className="table-container" style={{ marginBottom: '20px' }}>
        <div className="table-header">
          <div className="table-title">班級設定 CRUD（{draft.classes.length} 班）</div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="新班級 baseName"
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem' }}
            />
            <input
              type="text"
              placeholder="老師（選填）"
              value={newClassTeacher}
              onChange={(e) => setNewClassTeacher(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem' }}
            />
            <button type="button" className="btn-secondary" onClick={addClass}>
              新增班級
            </button>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>班級 baseName</th>
                <th>科別</th>
                <th>老師</th>
                <th>啟用</th>
              </tr>
            </thead>
            <tbody>
              {draft.classes.map((c) => (
                <tr key={c.baseName} style={{ opacity: c.active ? 1 : 0.55 }}>
                  <td style={{ fontWeight: 600 }}>{c.baseName}</td>
                  <td>{c.subject}</td>
                  <td>
                    <input
                      type="text"
                      value={c.teacher ?? ''}
                      placeholder="未設定"
                      onChange={(e) => updateTeacher(c.baseName, e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border-color)', fontSize: '0.8125rem' }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ padding: '2px 10px', fontSize: '0.75rem' }}
                      onClick={() => toggleClassActive(c.baseName)}
                    >
                      {c.active ? '停用' : '啟用'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* preview / apply 操作 */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
        <button type="button" className="btn-primary" onClick={doPreview} disabled={busy}>
          {busy ? '處理中...' : '預覽影響 (dry-run)'}
        </button>
        <button type="button" className="btn-secondary" onClick={doApply} disabled={busy || !preview}>
          套用並重算
        </button>
        {preview && (
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', alignSelf: 'center' }}>
            previewId: {preview.previewId} · inputHash: {String(preview.inputHash).slice(0, 12)}…
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

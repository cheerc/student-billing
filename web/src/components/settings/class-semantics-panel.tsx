'use client';

import React, { useState } from 'react';
import {
  ClassTypeDefinitionSchema,
  SUMMARY_DAY_ROLES,
  classTypeDefinitionOf,
  legacyClassTypeForDefinition,
  type ClassSetting,
  type ClassTypeDefinition,
  type SupportedClassAttributeKey,
  type SummaryDayRole,
} from '@/contracts/settings';
import { clearUnsupportedClassSemantics } from '@/domain/classification/class-semantics';

const ROLE_LABELS: Record<SummaryDayRole, string> = {
  anqinDays: '安親天數',
  tutoringDays: '課輔天數',
  englishDays: '美語天數',
  mathDays: '數學天數',
  chineseDays: '國語文天數',
  homeworkDays: '寫功課天數',
  intensiveEnglishDays: '密集美語天數',
  saturdayTutoringDays: '週六課輔天數',
};

const ATTRIBUTE_LABELS: Record<SupportedClassAttributeKey, string> = {
  subject: '科目',
  category: '折扣類別',
  fixedFiveDays: '固定 5 天',
  skipDeduction: '不計扣天',
  summaryDayRoles: '摘要天數欄位角色',
  erpTierApplicability: 'ERP 級距適用性',
};

interface ClassSemanticsPanelProps {
  classes: ClassSetting[];
  definitions: ClassTypeDefinition[];
  onUpdateClass: (baseName: string, patch: Partial<ClassSetting>) => void;
  onUpdateDefinition: (id: string, patch: Partial<ClassTypeDefinition>) => void;
  onAddDefinition: (definition: ClassTypeDefinition) => void;
  onDeleteDefinition: (id: string) => void;
  onClearUnsupported: (baseName: string) => void;
}

export function ClassSemanticsPanel({
  classes,
  definitions,
  onUpdateClass,
  onUpdateDefinition,
  onAddDefinition,
  onDeleteDefinition,
  onClearUnsupported,
}: ClassSemanticsPanelProps) {
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newMode, setNewMode] = useState<'care_window' | 'timetable'>('timetable');
  const [error, setError] = useState('');

  const addDefinition = () => {
    const mode = newMode;
    const supportedAttributeKeys: ClassTypeDefinition['supportedAttributeKeys'] = [
      'subject', 'category', ...(mode === 'care_window' ? ['fixedFiveDays' as const] : ['skipDeduction' as const]),
      'summaryDayRoles', 'erpTierApplicability',
    ];
    const definition = {
      id: newId.trim(),
      label: newLabel.trim(),
      scheduleMode: mode,
      supportedAttributeKeys,
      summaryRoleOptions: [...SUMMARY_DAY_ROLES],
    };
    const parsed = ClassTypeDefinitionSchema.safeParse(definition);
    if (!parsed.success || definitions.some((item) => item.id === definition.id)) {
      setError('請輸入未使用的小寫英文 id（可含數字與底線）及課程類型名稱。');
      return;
    }
    onAddDefinition(parsed.data);
    setNewId('');
    setNewLabel('');
    setError('');
  };

  return (
    <section aria-label="班級語意與課程類型" style={{ marginTop: 18, padding: 16, border: '1px solid #d0d7de', borderRadius: 8 }}>
      <h2 style={{ marginTop: 0 }}>班級語意設定</h2>
      <p>科目、課程類型、摘要欄位角色與 ERP 級距適用性各自保存。未設定時會保留為未設定，不依班名推測。</p>

      <details>
        <summary>課程類型登錄表（{definitions.length} 種）</summary>
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {definitions.map((definition) => {
            const used = classes.some((item) => item.classTypeId === definition.id || item.classType === definition.id);
            const builtin = definition.id === 'care' || definition.id === 'non_care';
            return (
              <div key={definition.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, 180px) minmax(120px, 1fr) auto', gap: 8, alignItems: 'center' }}>
                <code>{definition.id}</code>
                <input
                  aria-label={`課程類型名稱 ${definition.id}`}
                  value={definition.label}
                  onChange={(event) => onUpdateDefinition(definition.id, { label: event.target.value })}
                />
                <button type="button" disabled={builtin || used} onClick={() => onDeleteDefinition(definition.id)}>
                  刪除
                </button>
                <small style={{ gridColumn: '1 / -1' }}>
                  {definition.scheduleMode === 'care_window' ? '安親時段排課' : '個別時段排課'} · 可用角色：{definition.summaryRoleOptions.map((role) => ROLE_LABELS[role]).join('、') || '無'}
                </small>
                <fieldset style={{ gridColumn: '1 / -1' }}>
                  <legend>此課程類型支援的屬性欄位</legend>
                  {(['subject', 'category', 'erpTierApplicability', 'fixedFiveDays', 'skipDeduction'] as SupportedClassAttributeKey[])
                    .filter((key) => key !== 'fixedFiveDays' || definition.scheduleMode === 'care_window')
                    .filter((key) => key !== 'skipDeduction' || definition.scheduleMode === 'timetable')
                    .map((key) => (
                      <label key={key} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
                        <input
                          type="checkbox"
                          checked={definition.supportedAttributeKeys.includes(key)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...definition.supportedAttributeKeys, key]
                              : definition.supportedAttributeKeys.filter((value) => value !== key);
                            onUpdateDefinition(definition.id, {
                              supportedAttributeKeys: [...new Set<SupportedClassAttributeKey>(next)],
                            });
                          }}
                        />
                        {ATTRIBUTE_LABELS[key]}
                      </label>
                    ))}
                </fieldset>
                <fieldset style={{ gridColumn: '1 / -1' }}>
                  <legend>此課程類型可用的摘要角色</legend>
                  {SUMMARY_DAY_ROLES.map((role) => (
                    <label key={role} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        checked={definition.summaryRoleOptions.includes(role)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...definition.summaryRoleOptions, role]
                            : definition.summaryRoleOptions.filter((value) => value !== role);
                          onUpdateDefinition(definition.id, {
                            summaryRoleOptions: SUMMARY_DAY_ROLES.filter((value) => next.includes(value)),
                            supportedAttributeKeys: next.length > 0
                              ? [...new Set<ClassTypeDefinition['supportedAttributeKeys'][number]>([
                                  ...definition.supportedAttributeKeys,
                                  'summaryDayRoles',
                                ])]
                              : definition.supportedAttributeKeys.filter((key) => key !== 'summaryDayRoles'),
                          });
                        }}
                      />
                      {ROLE_LABELS[role]}
                    </label>
                  ))}
                </fieldset>
              </div>
            );
          })}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', borderTop: '1px solid #d0d7de', paddingTop: 10 }}>
            <input aria-label="新課程類型 id" placeholder="study_room" value={newId} onChange={(event) => setNewId(event.target.value)} />
            <input aria-label="新課程類型名稱" placeholder="課程類型名稱" value={newLabel} onChange={(event) => setNewLabel(event.target.value)} />
            <select aria-label="新課程類型排課形式" value={newMode} onChange={(event) => setNewMode(event.target.value as typeof newMode)}>
              <option value="timetable">個別時段排課</option>
              <option value="care_window">安親時段排課</option>
            </select>
            <button type="button" onClick={addDefinition}>新增類型</button>
            {error && <span role="alert">{error}</span>}
          </div>
        </div>
      </details>

      <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        {classes.map((item) => {
          const typeId = item.classTypeId ?? item.classType ?? '';
          const definition = classTypeDefinitionOf(typeId, definitions);
          const supports = (key: SupportedClassAttributeKey) => definition?.supportedAttributeKeys.includes(key) ?? false;
          const roleOptions = definition?.summaryRoleOptions ?? [];
          const roles = item.summaryDayRoles ?? [];
          const unsupported: string[] = [];
          if (item.subject?.trim() && !supports('subject')) unsupported.push('科目');
          if (item.category && item.category !== 'unset' && !supports('category')) unsupported.push('折扣類別');
          if (item.fixedFiveDays === true && !supports('fixedFiveDays')) unsupported.push('固定 5 天');
          if (item.sessions.some((session) => session.skipDeduction) && !supports('skipDeduction')) unsupported.push('不計扣天');
          const unavailableRoles = roles.filter((role) => !roleOptions.includes(role));
          if ((roles.length > 0 || item.summaryDayRolesStatus === 'configured') && !supports('summaryDayRoles')) unsupported.push('摘要角色');
          else if (unavailableRoles.length > 0) {
            unsupported.push(`摘要角色選項：${unavailableRoles.map((role) => ROLE_LABELS[role]).join('、')}`);
          }
          if (item.erpTierApplicability && item.erpTierApplicability !== 'unset' && !supports('erpTierApplicability')) unsupported.push('ERP 級距適用性');
          return (
            <details key={item.baseName}>
              <summary>{item.baseName} · {item.subject?.trim() || '科目未設定'} · {definition?.label ?? '課程類型未設定'}</summary>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, padding: '12px 4px' }}>
                <label>
                  科目
                  {supports('subject') ? (
                    <input
                      aria-label={`${item.baseName} 科目`}
                      value={item.subject ?? ''}
                      placeholder="未設定"
                      onChange={(event) => onUpdateClass(item.baseName, {
                        subject: event.target.value,
                        subjectSource: event.target.value.trim() ? 'manual' : 'unset',
                      })}
                    />
                  ) : <span>{item.subject?.trim() || '此類型未宣告科目欄位'}</span>}
                </label>
                <label>
                  課程類型
                  <select
                    aria-label={`${item.baseName} 課程類型`}
                    value={typeId}
                    onChange={(event) => {
                      const next = classTypeDefinitionOf(event.target.value, definitions);
                      if (!next) return;
                      if (next.scheduleMode === 'care_window' && item.sessions.length > 0 && !window.confirm('選擇安親時段排課會清除這個班的個別時段。要繼續嗎？')) return;
                      const cleared = clearUnsupportedClassSemantics(item, next);
                      const incompatible = [
                        item.subject?.trim() && !next.supportedAttributeKeys.includes('subject') ? '科目' : null,
                        item.category && item.category !== 'unset' && !next.supportedAttributeKeys.includes('category') ? '折扣類別' : null,
                        item.fixedFiveDays === true && !next.supportedAttributeKeys.includes('fixedFiveDays') ? '固定 5 天' : null,
                        item.sessions.some((session) => session.skipDeduction) && !next.supportedAttributeKeys.includes('skipDeduction') ? '不計扣天' : null,
                        (roles.length > 0 || item.summaryDayRolesStatus === 'configured') && !next.supportedAttributeKeys.includes('summaryDayRoles') ? '摘要角色' : null,
                        item.erpTierApplicability && item.erpTierApplicability !== 'unset' && !next.supportedAttributeKeys.includes('erpTierApplicability') ? 'ERP 級距適用性' : null,
                      ].filter((field): field is string => Boolean(field));
                      if (incompatible.length > 0 && !window.confirm(`切換課程類型會清除不支援的設定：${incompatible.join('、')}。要繼續嗎？`)) return;
                      onUpdateClass(item.baseName, {
                        ...cleared,
                        classTypeId: next.id,
                        classType: legacyClassTypeForDefinition(next),
                      });
                    }}
                  >
                    <option value="">請選擇課程類型</option>
                    {definitions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
                <label>
                  ERP 級距適用性
                  {supports('erpTierApplicability') ? (
                    <select
                      aria-label={`${item.baseName} ERP 級距適用性`}
                      value={item.erpTierApplicability ?? 'unset'}
                      onChange={(event) => onUpdateClass(item.baseName, {
                        erpTierApplicability: event.target.value as ClassSetting['erpTierApplicability'],
                        erpTierApplicabilitySource: event.target.value === 'unset' ? 'unset' : 'manual',
                      })}
                    >
                      <option value="unset">未設定</option>
                      <option value="applicable">適用</option>
                      <option value="not_applicable">不適用</option>
                    </select>
                  ) : <span>{item.erpTierApplicability ?? '此類型未宣告 ERP 級距欄位'}</span>}
                </label>
                <fieldset style={{ gridColumn: '1 / -1' }}>
                  <legend>摘要天數欄位角色（只使用現有欄位）</legend>
                  {supports('summaryDayRoles') && roleOptions.map((role) => (
                    <label key={role} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        checked={roles.includes(role)}
                        onChange={(event) => {
                          const nextRoles = event.target.checked
                            ? [...roles, role]
                            : roles.filter((value) => value !== role);
                          onUpdateClass(item.baseName, {
                            summaryDayRoles: SUMMARY_DAY_ROLES.filter((value) => nextRoles.includes(value)),
                            summaryDayRolesStatus: 'configured',
                            summaryDayRolesSource: 'manual',
                          });
                        }}
                      />
                      {ROLE_LABELS[role]}
                    </label>
                  ))}
                  {!supports('summaryDayRoles') && <span>此類型未宣告摘要角色欄位。</span>}
                  {supports('summaryDayRoles') && roleOptions.length === 0 && <span>此課程類型尚未設定摘要角色選項。</span>}
                </fieldset>
              </div>
              <small>
                科目來源：{item.subjectSource ?? 'unset'} · 摘要角色：{item.summaryDayRolesStatus ?? 'unset'}（{item.summaryDayRolesSource ?? 'unset'}） · ERP 級距：{item.erpTierApplicabilitySource ?? 'unset'}
              </small>
              {unsupported.length > 0 && (
                <p role="alert" data-unsupported-semantic="">
                  此班已有未受課程類型支援的設定（{unsupported.join('、')}），因此無法儲存。請為課程類型宣告欄位或清除該值。
                  <button type="button" onClick={() => onClearUnsupported(item.baseName)}>清除未支援的設定</button>
                </p>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}

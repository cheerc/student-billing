import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsEditor from '@/components/settings-editor';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';

describe('Ruling 1: settings-editor 升級入口解耦（支援 v3 升級至 v4）', () => {
  it('1. 當現行 run 為 erp-tag-v3 時，canUpgrade 為 true，呈現改用新規則（v4）橫幅', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: 'erp-tag-v3',
      } as any)
    );
    expect(html).toContain('data-upgrade-banner');
    expect(html).toContain('改用新規則（v4）');
    expect(html).toContain('aria-label="改用新規則（erp-tag-v4）"');
  });

  it('2. 當現行 run 為 erp-tag-v2 時，canUpgrade 亦為 true，呈現改用新規則（v4）橫幅', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: 'erp-tag-v2',
      } as any)
    );
    expect(html).toContain('data-upgrade-banner');
    expect(html).toContain('改用新規則（v4）');
  });

  it('3. 當現行 run 為 erp-tag-v1 時，身為正式軌且未達目標版本，canUpgrade 亦為 true，呈現改用新規則（v4）橫幅', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: 'erp-tag-v1',
      } as any)
    );
    expect(html).toContain('data-upgrade-banner');
    expect(html).toContain('改用新規則（v4）');
  });

  it('4. 當現行 run 已為 erp-tag-v4（最新目標版本）時，canUpgrade 為 false，不呈現升級橫幅', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: 'erp-tag-v4',
      } as any)
    );
    expect(html).not.toContain('data-upgrade-banner');
  });

  it('5. 當現行 run 為 compat 或未知版本時，仍提供明確 v4 升級入口', () => {
    const compatHtml = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: 'excel-v260922-compat',
      } as any)
    );
    expect(compatHtml).toContain('data-upgrade-banner');

    const unknownHtml = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: 'erp-tag-corrupt',
      } as any)
    );
    expect(unknownHtml).toContain('data-upgrade-banner');

    const nullHtml = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: null,
      } as any)
    );
    expect(nullHtml).not.toContain('data-upgrade-banner');
  });

  it('舊語意遷移動作前先呈現不含班名的逐欄匿名建議表', () => {
    const draft = buildSeedDraft();
    const privateName = '私人識別內容-國小數學A';
    draft.classes.push({
      baseName: privateName,
      subject: '',
      teacher: null,
      active: true,
      sessions: [],
      classTypeId: 'non_care',
      classType: 'non_care',
    } as any);
    const html = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: draft,
        legacySemanticMigrationCandidates: [{
          baseName: privateName,
          migrateSummaryDayRoles: true,
          migrateErpTierApplicability: true,
        }],
      } as any)
    );
    const tableStart = html.indexOf('aria-label="舊規則語意遷移匿名建議表"');
    const tableEnd = html.indexOf('</table>', tableStart);
    const tableMarkup = html.slice(tableStart, tableEnd);

    expect(tableStart).toBeGreaterThanOrEqual(0);
    expect(tableMarkup).toContain('舊班 1');
    expect(tableMarkup).toContain('數學天數');
    expect(tableMarkup).toContain('未保存');
    expect(tableMarkup).not.toContain(privateName);
  });
});

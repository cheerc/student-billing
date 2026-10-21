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

  it('5. 當現行 run 為非正式軌（如 excel-v260922-compat）或 null 時，canUpgrade 為 false，不呈現升級橫幅', () => {
    const compatHtml = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: 'excel-v260922-compat',
      } as any)
    );
    expect(compatHtml).not.toContain('data-upgrade-banner');

    const nullHtml = renderToStaticMarkup(
      React.createElement(SettingsEditor, {
        currentRevision: 1,
        initialDraft: buildSeedDraft(),
        currentRuleSetVersion: null,
      } as any)
    );
    expect(nullHtml).not.toContain('data-upgrade-banner');
  });
});

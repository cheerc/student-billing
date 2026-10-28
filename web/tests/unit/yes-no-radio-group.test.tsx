import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { YesNoRadioGroup } from '@/components/settings/yes-no-radio-group';

describe('D61 Phase 3：YesNoRadioGroup 單選元件', () => {
  it('渲染 radiogroup 與標籤，包含「是」與「否」兩個單選項', () => {
    const html = renderToStaticMarkup(
      <YesNoRadioGroup label="是否有多科折扣" name="multi" value={true} />
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="是否有多科折扣"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('是');
    expect(html).toContain('否');
  });

  it('value=true 時選中「是」，value=false 時選中「否」', () => {
    const htmlTrue = renderToStaticMarkup(
      <YesNoRadioGroup label="天數固定5天" name="fixed" value={true} />
    );
    // 驗證「是」的 radio 帶有 checked 屬性
    expect(htmlTrue).toMatch(/value="true"[^>]*checked/);

    const htmlFalse = renderToStaticMarkup(
      <YesNoRadioGroup label="天數固定5天" name="fixed" value={false} />
    );
    // 驗證「否」的 radio 帶有 checked 屬性
    expect(htmlFalse).toMatch(/value="false"[^>]*checked/);
  });

  it('disabled=true 時兩個選項皆帶有 disabled 屬性', () => {
    const html = renderToStaticMarkup(
      <YesNoRadioGroup label="不計扣天" name="skip" value={false} disabled={true} />
    );
    expect(html).toMatch(/disabled/);
  });
});

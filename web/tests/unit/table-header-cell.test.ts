import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TableHeaderCell from '@/components/tables/table-header-cell';
import { columnLabels } from '@/components/tables/column-def';

const th = (el: React.ReactElement) => renderToStaticMarkup(React.createElement('tr', null, el));

describe('TableHeaderCell（B1：無 sort 設定時與舊 <th> 相同）', () => {
  it('只輸出欄名與 className，無 aria-sort／排序按鈕', () => {
    const html = th(React.createElement(TableHeaderCell, { column: { label: '年級', className: 'cblue' } }));
    expect(html).toBe('<tr><th class="cblue">年級</th></tr>');
  });

  it('篩選觸發鈕與附加內容依序跟在欄名後，名稱「{欄名}篩選」由呼叫端元件提供', () => {
    const btn = React.createElement('button', { 'aria-label': '年級篩選' }, 'f');
    const html = th(
      React.createElement(TableHeaderCell, { column: { label: '年級' }, filter: btn }, React.createElement('span', { className: 'th-unit' }, '天')),
    );
    expect(html).toBe('<tr><th>年級<span class="th-unit">天</span><button aria-label="年級篩選">f</button></th></tr>');
  });

  it('有排序狀態才輸出 aria-sort 與按鈕', () => {
    const html = th(React.createElement(TableHeaderCell, { column: { label: '班級' }, sort: { dir: 'ascending', onToggle: () => {} } }));
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('<button');
  });

  it('columnLabels 由欄位定義推導欄名', () => {
    expect(columnLabels([{ label: 'a' }, { label: 'b' }] as const)).toEqual(['a', 'b']);
  });
});

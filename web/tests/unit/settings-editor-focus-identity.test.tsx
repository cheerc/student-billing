// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import SettingsEditor from '@/components/settings-editor';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps every focused schedule row visible when a row is renamed through SettingsEditor', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
  );

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(
        <SettingsEditor
          importId={null}
          currentRevision={1}
          initialDraft={buildSeedDraft()}
          focusClass="國小數學-四A"
        />
      );
    });

    const mathTable = host.querySelector<HTMLTableElement>('table.schedule-table-math');
    expect(mathTable).not.toBeNull();
    expect(host.querySelector('#class-type-tab-math')?.getAttribute('aria-selected')).toBe('true');

    const rowNames = () =>
      [...host.querySelectorAll<HTMLInputElement>('table.schedule-table-math input.input-classname')].map(
        (input) => input.value
      );
    expect(rowNames()).toEqual(['國小數學-四A', '國小數學-四A']);

    const firstNameInput = host.querySelector<HTMLInputElement>(
      'table.schedule-table-math input.input-classname'
    );
    expect(firstNameInput).not.toBeNull();
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    expect(nativeValueSetter).toBeTypeOf('function');

    await act(async () => {
      nativeValueSetter?.call(firstNameInput, '國小數學-四B');
      firstNameInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(rowNames()).toEqual(['國小數學-四B', '國小數學-四A']);
    expect(mathTable?.querySelectorAll('tbody tr.schedule-row')).toHaveLength(2);
    expect(host.querySelector('[data-focus-class]')?.textContent).toContain('2 個時段');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

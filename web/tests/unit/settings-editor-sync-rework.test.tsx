// @vitest-environment jsdom
/**
 * #189 D62 Phase 2 rework r2（F1／F2）— 使用者可達入口的行為測試。
 *
 * 這兩條測試都必須**真的掛載 `SettingsEditor` 並點擊畫面按鈕**：
 *  - F1：暫存新增班級後按「到課表填時段 →」，課表頁必須收到該班名並顯示焦點列
 *    （specs/17 §2.2「切到課表頁籤並以 `focusClass` 定位」）。只斷言「有切頁籤」抓不到把參數丟掉的實作。
 *  - F2：按「確認變更」後送往 preview 的草稿，新班類別必須是 `unset`（UX95／specs/17 §2.2）。
 *    這條走的是元件自己的 state → 存檔草稿轉換，不是測試自己組一份 unset 屬性（那會對實作零鑑別力）。
 *
 * 靜態轉譯（renderToStaticMarkup）做不到這兩件事：沒有點擊、沒有 state 更新。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsEditor from '@/components/settings-editor';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import type { ClassNameSyncReport } from '@/application/class-name-match-report';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPORT: ClassNameSyncReport = {
  importId: 'imp_rework',
  scope: { kind: 'latest' },
  snapshotStatus: 'ok',
  rosterClassCount: 3,
  exactMatchCount: 1,
  unmappedStudents: 2,
  mismatches: [
    { erpBaseName: '交通車', students: 1, tokens: 1, legacyAliasTarget: null },
    { erpBaseName: '安親新生班', students: 1, tokens: 1, legacyAliasTarget: null },
  ],
  systemOnly: [
    {
      baseName: '兒童美語-Gino',
      active: true,
      classType: 'english',
      sessionCount: 1,
      legacyAliasFrom: [],
    },
  ],
};

interface FetchCall {
  url: string;
  body: unknown;
}

let container: HTMLDivElement;
let root: Root;
let calls: FetchCall[];

beforeEach(() => {
  calls = [];
  // jsdom 沒有實作 <dialog> 的 showModal／close；ImpactDialog 會在開啟時呼叫它。
  // 這裡只補這兩個方法，不影響任何被測邏輯（元件在 isOpen=false 時整個不渲染）。
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes('/settings/preview')) {
        return { ok: true, status: 200, json: async () => ({ previewId: 'p_rework', mode: 'settings_only' }) };
      }
      // 唯讀計算：失敗路徑即可（本測試不看計算結果，也不讓 250ms debounce 影響斷言）
      return { ok: false, status: 503, json: async () => ({}) };
    })
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function mountEditor(initialTab: 'schedule' | 'sync'): Promise<void> {
  const draft = buildSeedDraft();
  await act(async () => {
    root.render(
      <SettingsEditor
        importId="imp_rework"
        currentRevision={1}
        initialDraft={draft}
        classNameReport={REPORT}
        reportImportId="imp_rework"
        hasActiveImport={true}
        initialTab={initialTab}
      />
    );
  });
  // 互動測試要的是「展開後的那一列」：先取得列元素，展開表單會插在列之後的兄弟節點，
  // 因此後續按鈕改從列所在的 <tbody> 取，避免指向已失效的舊節點。
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el, '要點擊的元素必須存在').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** 差異表目前的那一列（每次重新查詢，展開表單會改變 DOM）。 */
function mismatchRow(erpBaseName: string): HTMLElement | null {
  return container.querySelector(`tr[data-mismatch-row="${erpBaseName}"]`);
}

/** 某列的列內動作按鈕（只找這一列，不要撈到同一 tbody 的其他列）。 */
function rowAction(erpBaseName: string, text: string): HTMLButtonElement | undefined {
  const row = mismatchRow(erpBaseName);
  return row ? buttonByText(row, text) : undefined;
}

/** 展開表單插在該列之後的兄弟 <tr>；表單內的按鈕與單選都在那裡。 */
function rowForm(erpBaseName: string): HTMLElement | null {
  const row = mismatchRow(erpBaseName);
  return (row?.nextElementSibling as HTMLElement | null) ?? null;
}

function formButton(erpBaseName: string, text: string): HTMLButtonElement | undefined {
  const form = rowForm(erpBaseName);
  return form ? buttonByText(form, text) : undefined;
}

describe('#189 D62 rework r2：班名同步 → 課表', () => {
  it('F1：暫存新增後按「到課表填時段 →」，課表頁以該班名定位（focusClass）', async () => {
    await mountEditor('sync');

    await click(container.querySelector('#settings-tab-sync'));
    expect(mismatchRow('交通車'), '差異表應列出交通車').toBeTruthy();

    await click(rowAction('交通車', '新增為課表班級'));
    await click(rowForm('交通車')!.querySelector('input[type="radio"][value="unscheduled"]'));
    await click(formButton('交通車', '暫存新增'));

    expect(mismatchRow('交通車')!.textContent).toContain('已暫存新增課表班級（未儲存）');

    await click(rowAction('交通車', '到課表填時段'));

    // 行為斷言：課表頁收到的是「交通車」這個班名，而不是只切到預設頁籤顯示全部班級
    const banner = container.querySelector('[data-focus-class]');
    expect(banner, '課表頁應顯示焦點班級列').toBeTruthy();
    expect(banner!.textContent).toContain('交通車');
    expect(container.querySelector('[data-focus-class-missing]')).toBeNull();
    // 預設安親頁籤沒有任何時段欄；不排課班級應落在「不排課」頁籤
    expect(container.querySelector('#class-type-panel-unscheduled')).toBeTruthy();
  });

  it('F2：按「確認變更」送出的草稿中，新增班級類別為 unset（不替使用者決定折扣）', async () => {
    await mountEditor('sync');

    await click(container.querySelector('#settings-tab-sync'));
    expect(mismatchRow('安親新生班'), '差異表應列出安親新生班').toBeTruthy();

    await click(rowAction('安親新生班', '新增為課表班級'));
    await click(rowForm('安親新生班')!.querySelector('input[type="radio"][value="math"]'));
    await click(formButton('安親新生班', '暫存新增'));

    await click(buttonByText(container, '確認變更'));

    const previewCall = calls.find((c) => c.url.includes('/settings/preview'));
    expect(previewCall, '應送出 preview 請求').toBeTruthy();
    const payload = previewCall!.body as { draft: { classes: Array<Record<string, unknown>> } };
    const newClass = payload.draft.classes.find((c) => c.baseName === '安親新生班');

    expect(newClass, '送出的草稿應含新班級').toBeTruthy();
    expect(newClass!.classType, '課程類型仍是使用者選的數學班').toBe('math');
    expect(newClass!.category, '類別必須是 unset').toBe('unset');
    expect(newClass!.categorySource, '類別來源必須是 unset').toBe('unset');
    expect(newClass!.fixedFiveDays).toBe(false);
  });
});

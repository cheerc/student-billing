'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import SummaryTable, { type StudentColumnKey } from './summary-table';
import DetailDrawer from './detail-drawer';
import { TabList, tabPanelProps } from './ui/tabs';
import ClassDeductionsPanel from './results/class-deductions-panel';
import { HeaderFilter, FilterChips, type FilterSection, type ChipItem } from './filters/header-filter';
import { DeductionsResponse } from '@/application/schedule-deductions';
import { formatDateTime } from '@/lib/datetime';
import { describeLoadError, failureFromException, readRawFailure, type UserFacingError } from '@/lib/user-messages';
import { ErrorNotice } from '@/components/ui/error-notice';
import {
  RunStudentsQueryResult,
  StudentCalculationItem,
} from '@/application/query-students';
import type { RunStudentOptions } from '@/application/query-student-options';
import {
  BLANK,
  EMPTY,
  STUDENT_FILTER_FIELDS,
  buildResultsQuery,
  buildStudentApiParams,
  chipsOf,
  compareOptionValues,
  displayValue,
  exactlyOneClass,
  findStudentField,
  hasAnySelection,
  scopeOf,
  unescapeWire,
  type DeductionFilters,
  type StudentFilterKey,
  type StudentFilters,
} from '@/lib/results-filters';

interface ActiveRunViewProps {
  runId: string;
  revision: number;
  asOfDate: string;
  initialData: RunStudentsQueryResult;
  /** 全 run 的欄位選項（來自指定 run 全部學生，不受分頁與篩選限制；03 §5.1 options read model） */
  initialOptions: RunStudentOptions;
  /** 網址還原的頁籤與各頁籤條件（F03／F04：兩頁籤各自保留條件） */
  initialView?: 'students' | 'deductions';
  initialFilters?: StudentFilters;
  initialDeductionFilters?: DeductionFilters;
  /** 載入時被移除的選值／被忽略的無效網址條件 */
  initialNotices?: { invalid?: boolean; pruned?: Array<{ column: string; label: string }> };
  /** 班級扣天 read model（09 §5.2；與學生總表同一份 run 課表快照）。快照不可用時改傳 deductionsUnavailable。 */
  initialDeductions?: DeductionsResponse;
  /** 歷史 run 的課表快照不存在（或屬診斷軌）：明示資料不足、無法重建，不顯示表格（09 §5.2） */
  deductionsUnavailable?: { code: string; message: string };
  /**
   * 待設定班級（09 §8.3）：由伺服器依該 run 的課表快照與班名對應動態判斷，取代舊的寫死班名集合。
   * 選定班級在此清單內時顯示提示；null／未提供＝無法判斷，不顯示（不猜）。
   */
  unmappedClasses?: string[] | null;
  /** current＝目前使用的資料；history＝歷史資料（唯讀，來自匯入紀錄）。預設 current。 */
  mode?: 'current' | 'history';
  /** 資料來源（檔名與日期）；橫幅據此標示來源日期（09 §2）。 */
  source?: { fileName: string; importedAt: string; updatedAt: string };
}

/** 各欄表頭篩選對應的條件（需確認欄有兩個分區：米豆奶天數比較、問題類型）。 */
const COLUMN_FILTERS: Record<StudentColumnKey, StudentFilterKey[]> = {
  grade: ['grade'],
  enrollment: ['enrollmentKey'],
  anqinDays: ['anqinDays'],
  tutoringDays: ['tutoringDays'],
  extra: ['hasExtraDeduction'],
  baseDiscount: ['baseDiscountBps'],
  applicable: ['applicableDiscountBps'],
  sibling: ['sibling'],
  special: ['specialDiscount'],
  internal: ['internalStudent'],
  review: ['tierMismatch', 'issueCode'],
};

const Q_KEY = (runId: string) => `sb.results.q:${runId}`;
const SCROLL_KEY = (runId: string, view: string) => `sb.results.scroll:${runId}:${view}`;

/** 瀏覽器返回（popstate）後短時間內掛載的頁面，視為「返回」，還原捲動位置。 */
let lastPopAt = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    lastPopAt = Date.now();
  });
}

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* 頁內保存不可用時，功能降級為不保存 */
  }
}

export default function ActiveRunView({
  runId,
  revision,
  asOfDate,
  initialData,
  initialOptions,
  initialView = 'students',
  initialFilters = {},
  initialDeductionFilters = {},
  initialNotices,
  initialDeductions,
  deductionsUnavailable,
  unmappedClasses = null,
  mode = 'current',
  source,
}: ActiveRunViewProps) {
  const isHistory = mode === 'history';
  const router = useRouter();
  // 結果雙頁籤（09 §2／§5.2）：學生總表、班級扣天；頁籤與條件寫在網址，重新整理／返回不丟
  const [resultTab, setResultTab] = useState<'students' | 'deductions'>(initialView);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RunStudentsQueryResult>(initialData);
  const [options, setOptions] = useState<RunStudentOptions>(initialOptions);
  const [error, setError] = useState<UserFacingError | null>(null);

  const [filters, setFilters] = useState<StudentFilters>(initialFilters);
  const [deductionFilters, setDeductionFilters] = useState<DeductionFilters>(initialDeductionFilters);
  const [searchQuery, setSearchQuery] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [prunedNotice, setPrunedNotice] = useState(initialNotices?.pruned ?? []);
  const [invalidNotice, setInvalidNotice] = useState(Boolean(initialNotices?.invalid));
  const [applicableRemoved, setApplicableRemoved] = useState(false);

  // 分頁狀態
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyCursors, setHistoryCursors] = useState<string[]>([]);

  // 抽屜狀態
  const [selectedStudent, setSelectedStudent] = useState<StudentCalculationItem | null>(null);

  const filtersRef = useRef(filters);
  const qRef = useRef('');
  const optionsRef = useRef(options);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScroll = useRef<{ top: number; win: number } | null>(null);
  // 還原捲動位置前，等姓名搜尋還原後的那次查詢完成（用 ref：同一個 commit 內的 effect 讀得到最新值）
  const awaitingLoad = useRef(false);
  const [loadedTick, setLoadedTick] = useState(0);

  // UX16：Esc 關閉學生明細抽屜
  useEffect(() => {
    if (!selectedStudent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedStudent(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedStudent]);

  /** 查詢學生名單。只採用「最新一次」的回應：晚到的舊回應不得覆蓋新條件的結果（03 §5.1）。 */
  const load = useCallback(
    async (nextFilters: StudentFilters, q: string, targetCursor: string | null) => {
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      setError(null);
      const extra: Record<string, string> = { limit: '50' };
      if (targetCursor) extra.cursor = targetCursor;
      const params = buildStudentApiParams(nextFilters, q, extra);
      try {
        const res = await fetch(`/api/v1/runs/${runId}/students?${params.toString()}`, { signal: ac.signal });
        const json = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;
        if (!res.ok) {
          setError(describeLoadError('查詢學生總表', readRawFailure(res.status, json)));
          return;
        }
        setData(json);
      } catch (err) {
        if (seq !== seqRef.current || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(describeLoadError('查詢學生總表', failureFromException(err)));
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          awaitingLoad.current = false;
          setLoadedTick((n) => n + 1);
        }
      }
    },
    [runId]
  );

  /** 恰選一班時，取該班的本班適用折扣選項（其他欄選項取自整個 run，不受影響）。 */
  const ensureApplicableOptions = useCallback(
    async (next: StudentFilters) => {
      const single = exactlyOneClass(next);
      const wire = next.enrollmentKey?.[0];
      if (!single || !wire || optionsRef.current.applicableRateContext.classKey === wire) return;
      try {
        const res = await fetch(`/api/v1/runs/${runId}/students?options=true&enrollmentKey=${encodeURIComponent(wire)}`);
        if (!res.ok) return;
        const json = (await res.json()) as RunStudentOptions;
        if (exactlyOneClass(filtersRef.current) !== single) return;
        setOptions((prev) => ({
          ...prev,
          options: { ...prev.options, applicableDiscountBps: json.options.applicableDiscountBps },
          applicableRateContext: json.applicableRateContext,
        }));
      } catch {
        /* 選項載入失敗時，本班適用折扣的篩選面板維持空清單；欄位值本身不受影響 */
      }
    },
    [runId]
  );

  const resetPaging = () => {
    setCursor(null);
    setHistoryCursors([]);
  };

  /** 套用學生條件：條件改變即清 cursor 從第一頁重查（03 §5.1）；本班適用折扣在不再恰選一班時自動移除並提示。 */
  const applyFilters = useCallback(
    (next: StudentFilters) => {
      const merged: StudentFilters = {};
      for (const [k, v] of Object.entries(next)) {
        if (v && v.length > 0) merged[k as StudentFilterKey] = v;
      }
      let removed = false;
      if (merged.applicableDiscountBps && !exactlyOneClass(merged)) {
        delete merged.applicableDiscountBps;
        removed = true;
      }
      setApplicableRemoved(removed);
      setPrunedNotice([]);
      setInvalidNotice(false);
      setFilters(merged);
      resetPaging();
      void load(merged, qRef.current, null);
      void ensureApplicableOptions(merged);
    },
    [load, ensureApplicableOptions]
  );

  const commitQuery = useCallback(
    (value: string) => {
      const q = value.trim();
      qRef.current = q;
      setAppliedQ(q);
      writeStorage(Q_KEY(runId), q === '' ? null : q);
      resetPaging();
      void load(filtersRef.current, q, null);
    },
    [load, runId]
  );

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => commitQuery(val), 250);
  };

  const handleResetFilters = useCallback(() => {
    if (qTimer.current) clearTimeout(qTimer.current);
    setSearchQuery('');
    setAppliedQ('');
    qRef.current = '';
    writeStorage(Q_KEY(runId), null);
    setApplicableRemoved(false);
    setPrunedNotice([]);
    setInvalidNotice(false);
    setFilters({});
    resetPaging();
    void load({}, '', null);
  }, [load, runId]);

  // 掛載：還原頁內保存的姓名搜尋與捲動位置；條件與頁籤來自網址（伺服器已還原）
  useEffect(() => {
    const savedQ = readStorage(Q_KEY(runId));
    const nav = (performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined)?.type;
    const returning = Date.now() - lastPopAt < 3000 || nav === 'back_forward' || nav === 'reload';
    // 開發模式的 StrictMode 會重跑 effect：已讀到但尚未套用的位置不重讀（重讀會讀到被覆寫的值）
    if (returning && !pendingScroll.current) {
      try {
        const raw = readStorage(SCROLL_KEY(runId, initialView));
        if (raw) pendingScroll.current = JSON.parse(raw);
      } catch {
        pendingScroll.current = null;
      }
    }
    if (savedQ) {
      qRef.current = savedQ;
      awaitingLoad.current = true;
      queueMicrotask(() => {
        setSearchQuery(savedQ);
        setAppliedQ(savedQ);
        void load(filtersRef.current, savedQ, null);
      });
    }
    void ensureApplicableOptions(filtersRef.current);
    // 只在掛載時執行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 頁籤與條件同步到網址（不含姓名搜尋）；用 replaceState，不堆疊瀏覽器歷史。
  // 預設狀態（學生總表、無條件）網址保持乾淨（不寫 view／runId）；網址原本帶了參數而現在回到預設（清除全部、run 變更後選值全被移除）才改寫回乾淨路徑
  useEffect(() => {
    const isDefault = resultTab === 'students' && !hasAnySelection(filters) && !hasAnySelection(deductionFilters);
    if (isDefault && !window.location.search) return;
    const query = isDefault ? '' : buildResultsQuery({ view: resultTab, runId, filters, deductionFilters });
    const target = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    if (target !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', target);
    }
  }, [resultTab, filters, deductionFilters, runId]);

  // 捲動位置：儲存（表內與整頁），返回時還原
  useEffect(() => {
    const scroller = () => document.querySelector<HTMLElement>('.results-tabpanel .table-scroll');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      // 尚未還原前不覆寫已保存的位置（此時畫面在最上方，寫進去會弄丟要還原的值）
      if (pendingScroll.current) return;
      const el = scroller();
      writeStorage(SCROLL_KEY(runId, resultTab), JSON.stringify({ top: el?.scrollTop ?? 0, win: window.scrollY }));
    };
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 120);
    };
    const el = scroller();
    el?.addEventListener('scroll', onScroll);
    window.addEventListener('scroll', onScroll);
    window.addEventListener('pagehide', save);
    return () => {
      if (timer) clearTimeout(timer);
      save();
      el?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', save);
    };
  }, [runId, resultTab, data]);

  useEffect(() => {
    if (awaitingLoad.current || !pendingScroll.current) return;
    const target = pendingScroll.current;
    pendingScroll.current = null;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>('.results-tabpanel .table-scroll');
      if (el) el.scrollTop = target.top;
      window.scrollTo(0, target.win);
    });
  }, [loadedTick, data]);

  const handleNextPage = () => {
    if (data?.nextCursor) {
      setHistoryCursors((prev) => [...prev, cursor || '']);
      setCursor(data.nextCursor);
      void load(filters, qRef.current, data.nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (historyCursors.length > 0) {
      const prevHistory = [...historyCursors];
      const prevCursor = prevHistory.pop() || null;
      setHistoryCursors(prevHistory);
      const target = prevCursor === '' ? null : prevCursor;
      setCursor(target);
      void load(filters, qRef.current, target);
    }
  };

  const selectTab = (k: string) => {
    setResultTab(k as 'students' | 'deductions');
  };

  const goEditClass = (classKey: string) => {
    router.push(`/settings?tab=schedule&class=${encodeURIComponent(classKey)}`);
  };

  const stats = data?.stats || {
    totalStudents: 0,
    mismatchCount: 0,
    issuesCount: 0,
    classScopeTotal: 0,
    filteredNoCourseCount: 0,
  };

  // ── 表頭篩選：各欄選項（整個 run）與已套用條件 ─────────────────
  const singleClass = exactlyOneClass(filters);
  const singleWire = filters.enrollmentKey?.[0] ?? null;

  const sectionFor = (key: StudentFilterKey): FilterSection => {
    const def = findStudentField(key)!;
    let raw = options.options[key] ?? [];
    if (key === 'applicableDiscountBps' && options.applicableRateContext.classKey !== singleWire) raw = [];
    const opts = [...raw]
      .sort((a, b) => compareOptionValues(def, a.value, b.value))
      .map((o) => ({
        value: o.value,
        label: o.labelKey === 'unparsedClassLabel' ? '班名無法解析' : displayValue(def, o.value),
        count: o.count,
      }));
    return { key, title: def.section, options: opts };
  };

  const renderFilter = (column: StudentColumnKey) => {
    const keys = COLUMN_FILTERS[column];
    const sections = keys.map(sectionFor);
    const value = Object.fromEntries(keys.map((k) => [k, filters[k]]));
    const name = findStudentField(keys[0])!.column;
    return (
      <HeaderFilter
        column={name}
        sections={sections}
        value={value}
        onApply={(next) => applyFilters({ ...filtersRef.current, ...next })}
      />
    );
  };

  const chipItems: ChipItem[] = [
    ...chipsOf(filters, STUDENT_FILTER_FIELDS).map((c) => ({
      id: `${c.key}:${c.label}`,
      column: c.column,
      label: c.label,
      onRemove: () => applyFilters({ ...filtersRef.current, [c.key]: c.remaining.length > 0 ? c.remaining : undefined }),
    })),
    ...(appliedQ
      ? [{ id: 'q', column: '姓名或代碼', label: appliedQ, onRemove: () => { setSearchQuery(''); commitQuery(''); } }]
      : []),
  ];

  const scope = scopeOf(filters);
  const noCourseTotal = data?.noCourseTotal ?? 0;
  const noCourseFiltered = stats.filteredNoCourseCount ?? 0;
  const selectedRealClasses = (filters.enrollmentKey ?? [])
    .filter((w) => w !== BLANK && w !== EMPTY && w !== '~none')
    .map(unescapeWire);
  const unmappedSelected = selectedRealClasses.filter((c) => unmappedClasses?.includes(c));

  const scopeLabel = (() => {
    const total = <strong data-count="class-scope">{stats.classScopeTotal}</strong>;
    switch (scope.kind) {
      case 'single':
        return <>本班 {total} 人</>;
      case 'multi':
        return <>已選 <strong data-count="selected-classes">{scope.count}</strong> 班，共 {total} 人</>;
      case 'special':
        return <>已選「{scope.special}」，共 {total} 人</>;
      case 'none':
        return <>已取消全選，共 {total} 人</>;
      default:
        return <>全部 {total} 人</>;
    }
  })();

  return (
    <div className="results-page">
      {/* 資料來源橫幅（09 §2：來源時間／檔名一行，核對基準日另外標明）。
          現行資料與歷史資料用文字＋顏色區分；歷史資料為唯讀，不提供任何寫入動作（09 §8.3）。 */}
      <section
        className={`data-banner ${isHistory ? 'data-banner-history' : 'data-banner-current'}`}
        aria-label={isHistory ? '歷史資料' : '目前使用的資料'}
      >
        <div className="data-banner-main">
          <h1 className="data-banner-title">{isHistory ? '歷史資料（唯讀）' : '核對結果'}</h1>
          <p className="data-banner-line">
            {!isHistory && <span className="data-banner-label">目前使用的資料</span>}
            {source && <span className="data-banner-file">{source.fileName}</span>}
            {source && (
              <span className="data-banner-meta">
                {isHistory
                  ? `名單匯入於 ${formatDateTime(source.importedAt)} · 資料更新於 ${formatDateTime(source.updatedAt)}`
                  : `資料更新於 ${formatDateTime(source.updatedAt)}`}
              </span>
            )}
            <span className="pill">{`核對基準日 ${asOfDate}`}</span>
          </p>
        </div>
        <div className="data-banner-actions">
          {isHistory ? (
            <Link href="/history" className="btn-secondary">回到匯入紀錄</Link>
          ) : (
            <Link href="/imports" className="btn-secondary">匯入新名單</Link>
          )}
        </div>
      </section>

      {/* 技術資訊摺疊區（版本識別、長 ID 與計算說明入口收納於此，不在日常介面顯示，09 §7）；預設收合 */}
      <details className="tech-info tech-info-block">
        <summary>技術資訊</summary>
        <div className="tech-pre">
          {isHistory ? `Run ID：${runId}｜基準日 ${asOfDate}` : `Run ID：${runId}｜版本 rev ${revision}｜基準日 ${asOfDate}`}
        </div>
        <a
          href={`/api/v1/runs/${runId}/comparison?againstRuleSet=excel-v260922-compat`}
          target="_blank"
          rel="noopener noreferrer"
        >
          計算說明（雙軌差異 JSON）
        </a>
      </details>

      {/* 結果雙頁籤（09 §2；09 §6 鍵盤可操作：方向鍵／Home／End、Enter／Space、tabpanel 對應） */}
      <TabList
        label="結果頁籤"
        idPrefix="results"
        selected={resultTab}
        onSelect={selectTab}
        tabs={[
          { key: 'students', label: '學生總表' },
          { key: 'deductions', label: '班級扣天' },
        ]}
      />

      <div className="table-container results-tabpanel" {...tabPanelProps('results', resultTab)}>
        {resultTab === 'students' ? (
          <>
            {/* 篩選列：姓名搜尋（不入網址）＋已套用條件 chips ＋「清除全部」 */}
            <div className="results-filterbar">
              <input
                type="text"
                className="results-search"
                placeholder="搜尋姓名或代碼..."
                aria-label="搜尋姓名或人員代碼"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
              <FilterChips items={chipItems} onClearAll={handleResetFilters} />
              {scope.kind !== 'single' && (
                <span className="scope-hint">選擇單一班級後，才會顯示本班適用折扣</span>
              )}
            </div>

            {prunedNotice.length > 0 && (
              <div className="notice-inline" role="status" data-notice="filters-pruned">
                已移除 {prunedNotice.length} 個在這份資料中不存在的篩選值：
                {prunedNotice.map((p) => `${p.column}「${p.label}」`).join('、')}
              </div>
            )}
            {invalidNotice && (
              <div className="notice-inline" role="status" data-notice="filters-invalid">
                網址中的篩選條件無效，已忽略並顯示全部結果。
              </div>
            )}
            {applicableRemoved && (
              <div className="notice-inline" role="status" data-notice="applicable-removed">
                已移除「本班適用折扣」條件：它只在恰選一個班級時適用。
              </div>
            )}
            {error && <ErrorNotice message={error.message} detail={error.detail} />}

            {/* 人數一行（09 §5.1）：全部／本班／已選N班 · 符合篩選M人 · N位需確認 —— 範圍不同，不可互相冒充 */}
            <div className="results-summary">
            <div className="counts-line" role="status" aria-live="polite">
              <span className="counts-item" data-scope={scope.kind}>{scopeLabel}</span>
              <span className="counts-sep" aria-hidden="true">·</span>
              <span className="counts-item">
                符合篩選{' '}
                <strong data-count="matched">{data?.totalStudents ?? 0}</strong> 人
              </span>
              <span className="counts-sep" aria-hidden="true">·</span>
              <span className="counts-item">
                <strong data-count="needs-review">{stats.issuesCount}</strong> 位需確認
              </span>
              {stats.mismatchCount > 0 && (
                <>
                  <span className="counts-sep" aria-hidden="true">·</span>
                  <span className="counts-item">
                    <strong data-count="mismatch">{stats.mismatchCount}</strong> 位計算天數與米豆奶登記不符
                  </span>
                </>
              )}
              {noCourseTotal > 0 && (
                <span className="no-course-wrap">
                  <span className="counts-sep" aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="no-course-hint"
                    data-count="no-course"
                    onClick={() => applyFilters({ ...filtersRef.current, enrollmentKey: [BLANK] })}
                  >
                    無課程 <strong>{noCourseTotal}</strong> 人 · 請至米豆奶辦理離籍
                  </button>
                  {noCourseFiltered !== noCourseTotal && (
                    <span className="counts-item">
                      （目前條件內 <strong data-count="no-course-filtered">{noCourseFiltered}</strong> 人）
                    </span>
                  )}
                </span>
              )}
            </div>
            </div>

            {/* 待設定班級提示（09 §8.3）：依該 run 課表快照與班名對應動態判斷，不用寫死的班名清單 */}
            {unmappedSelected.length > 0 && (
              <div className="notice-warn" role="status">
                <span>
                  <strong>待設定班級提示：</strong>班級{unmappedSelected.map((c) => `「${c}」`).join('、')}還沒有對應的課表班級，扣天無法計算。
                </span>
                {!isHistory && (
                  <a href="/settings" className="btn-secondary">前往課表設定，確認班名對應</a>
                )}
              </div>
            )}

            <SummaryTable
              students={data?.items || []}
              loading={loading}
              singleClass={singleClass}
              renderFilter={renderFilter}
              onSelectStudent={(s) => setSelectedStudent(s)}
              onResetFilters={handleResetFilters}
            />
            <div className="results-pager">
              <span className="counts-item">顯示 {data?.items.length ?? 0} 筆 (共 {data?.totalStudents ?? 0} 人)</span>
              <button type="button" className="btn-secondary pager-btn" onClick={handlePrevPage} disabled={historyCursors.length === 0 || loading}>
                上一頁
              </button>
              <button type="button" className="btn-secondary pager-btn" onClick={handleNextPage} disabled={!data?.nextCursor || loading}>
                下一頁
              </button>
            </div>
          </>
        ) : (
          <ClassDeductionsPanel
            data={initialDeductions}
            unavailable={deductionsUnavailable}
            filters={deductionFilters}
            onFiltersChange={setDeductionFilters}
            onEditClass={goEditClass}
          />
        )}
      </div>

      {/* 學生計算明細側欄 Drawer */}
      <DetailDrawer
        student={selectedStudent}
        onClose={() => setSelectedStudent(null)}
      />
    </div>
  );
}

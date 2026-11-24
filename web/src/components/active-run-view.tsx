'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { parseResultsState, pruneResultsState } from '@/lib/results-state';
import SummaryTable, { type StudentColumnKey } from './summary-table';
import type { RunClassCategorySnapshot } from '@/application/applicable-rate';
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
import { isCurrentRunResponse } from '@/application/run-scope';
import { UNPARSEABLE_CLASS_TEXT } from '@/contracts/column-filter';
import {
  BLANK,
  NONE,
  STUDENT_FILTER_FIELDS,
  buildResultsQuery,
  parseSortWire,
  buildStudentApiParams,
  chipsOf,
  exactlyOneClass,
  findStudentField,
  hasAnySelection,
  optionWire,
  reconcileStudentFilters,
  scopeOf,
  unescapeWire,
  type DeductionFilters,
  type PrunedEntry,
  type StudentFilterKey,
  type StudentFilters,
} from '@/lib/results-filters';

interface ActiveRunViewProps {
  runId: string;
  revision: number;
  asOfDate: string;
  initialData: RunStudentsQueryResult;
  /** 全 run 值宇宙，計數依其他已套用篩選、不受分頁限制（03 §5.1 options read model）。 */
  initialOptions: RunStudentOptions;
  /** `initialOptions` 是以哪個「恰選一班」取得的（`columnOptions.applicableDiscount` 只屬於該班）；null＝取得時沒有恰選一班 */
  initialOptionsClass?: string | null;
  /** 網址還原的頁籤與各頁籤條件（F03／F04：兩頁籤各自保留條件） */
  initialView?: 'students' | 'deductions';
  initialFilters?: StudentFilters;
  initialDeductionFilters?: DeductionFilters;
  /** 載入時被移除的選值／被忽略的無效網址條件 */
  initialNotices?: { invalid?: boolean; pruned?: PrunedEntry[] };
  /** 班級扣天 read model（09 §5.2；與學生總表同一份 run 課表快照）。快照不可用時改傳 deductionsUnavailable。 */
  initialDeductions?: DeductionsResponse;
  /** 歷史 run 的課表快照不存在（或屬診斷軌）：明示資料不足、無法重建，不顯示表格（09 §5.2） */
  deductionsUnavailable?: { code: string; message: string };
  /**
   * 待設定班級（09 §8.3）：由伺服器依該 run 的課表快照與班名對應動態判斷，取代舊的寫死班名集合。
   * 選定班級在此清單內時顯示提示；null／未提供＝無法判斷，不顯示（不猜）。
   */
  unmappedClasses?: string[] | null;
  /**
   * 該 run 的班級類別快照（server 由 run_class_categories 讀出，以名冊班名為 key）。
   * 學生總表的「本班適用折扣」依它判斷；缺該班快照時顯示「未設定」。
   */
  classCategorySnapshots?: RunClassCategorySnapshot[] | null;
  /** 資料來源（檔名與日期）；橫幅據此標示來源日期（09 §2）。 */
  source?: { fileName: string; importedAt: string; updatedAt: string };
}

/** 各欄表頭篩選對應的 `col.<columnKey>`（D66：每欄一張選項清單，需確認欄也是單一清單）。 */
const COLUMN_FILTERS: Record<StudentColumnKey, StudentFilterKey> = {
  grade: 'grade',
  enrollment: 'enrollment',
  anqinDays: 'anqinDays',
  tutoringDays: 'tutoringDays',
  extra: 'extraDeduction',
  baseDiscount: 'baseDiscount',
  applicable: 'applicableDiscount',
  sibling: 'sibling',
  special: 'specialDiscount',
  internal: 'internalStudent',
  review: 'review',
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
  initialOptionsClass = null,
  initialFilters = {},
  initialNotices,
  initialDeductions,
  deductionsUnavailable,
  unmappedClasses = null,
  classCategorySnapshots = null,
  source,
}: ActiveRunViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // render 時的路由；URL-sync effect 以它確認「目前 history entry 仍是自己的路由」（#264）
  const renderPathname = usePathname();
  // Back 的 RSC props 可能來自無條件入口；在首次 render 用目前網址還原，不在 effect 後跳頁籤。
  const [restored] = useState(() => {
    const parsed = parseResultsState(new URLSearchParams(searchParams.toString()));
    const deferredRate = Boolean(parsed.filters.applicableDiscount && exactlyOneClass(parsed.filters)
      && initialOptionsClass !== exactlyOneClass(parsed.filters));
    const state = pruneResultsState(parsed, initialOptions.columnOptions, deferredRate);
    return { ...state, deferredRate, needsLoad: deferredRate || JSON.stringify(state.filters) !== JSON.stringify(initialFilters) };
  });
  const [restoring, setRestoring] = useState(restored.needsLoad);
  // 結果雙頁籤（09 §2／§5.2）：學生總表、班級扣天；頁籤與條件寫在網址，重新整理／返回不丟
  const [resultTab, setResultTab] = useState<'students' | 'deductions'>(restored.view);
  const [loading, setLoading] = useState(restored.needsLoad);
  const [data, setData] = useState<RunStudentsQueryResult>(initialData);
  const [options, setOptions] = useState<RunStudentOptions>(initialOptions);
  const [error, setError] = useState<UserFacingError | null>(null);

  const [filters, setFilters] = useState<StudentFilters>(restored.filters);
  const [deductionFilters, setDeductionFilters] = useState<DeductionFilters>(restored.deductionFilters);
  // 學生總表 server 排序（D65）：入網址、換排序清 cursor 重查；null＝預設 person_code 序
  const [sort, setSort] = useState<string | null>(restored.sort);
  const sortRef = useRef<string | null>(restored.sort);
  const [searchQuery, setSearchQuery] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsHydrated(true);
  }, []);
  const [prunedNotice, setPrunedNotice] = useState(restored.pruned.length ? restored.pruned : initialNotices?.pruned ?? []);
  const [invalidNotice, setInvalidNotice] = useState(restored.invalid || Boolean(initialNotices?.invalid));
  const [applicableRemoved, setApplicableRemoved] = useState<'not-single' | 'class-changed' | null>(null);
  // `options.columnOptions.applicableDiscount` 屬於哪一班（取得選項時恰選的班）；與目前選的班不同＝過期，面板不顯示
  const [optionsClass, setOptionsClass] = useState<string | null>(initialOptionsClass);

  // 分頁狀態
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyCursors, setHistoryCursors] = useState<string[]>([]);

  // 抽屜狀態
  const [drawerSelection, setDrawerSelection] = useState<{
    runId: string;
    student: StudentCalculationItem | null;
  }>(() => ({ runId, student: null }));
  // Reset the selection during render when the route supplies another Run. This keeps a stale
  // student's drawer from appearing for even one frame after the runId prop changes.
  if (drawerSelection.runId !== runId) setDrawerSelection({ runId, student: null });
  const selectedStudent = drawerSelection.runId === runId ? drawerSelection.student : null;

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
  const optionsSeqRef = useRef(0);
  const optionsAbortRef = useRef<AbortController | null>(null);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScroll = useRef<{ top: number; win: number } | null>(null);
  // 還原捲動位置前，等姓名搜尋還原後的那次查詢完成（用 ref：同一個 commit 內的 effect 讀得到最新值）
  const awaitingLoad = useRef(false);
  const [loadedTick, setLoadedTick] = useState(0);

  // UX16：Esc 關閉學生明細抽屜
  useEffect(() => {
    if (!selectedStudent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerSelection({ runId, student: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedStudent, runId]);

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
      if (sortRef.current) extra.sort = sortRef.current;
      const params = buildStudentApiParams(nextFilters, q, extra);
      try {
        const res = await fetch(`/api/v1/runs/${runId}/students?${params.toString()}`, { signal: ac.signal });
        const json = await res.json().catch(() => null);
        if (seq !== seqRef.current || ac.signal.aborted) return;
        if (!res.ok) {
          setError(describeLoadError('查詢學生總表', readRawFailure(res.status, json)));
          return;
        }
        if (!isCurrentRunResponse({
          expectedRunId: runId,
          responseRunId: json?.runId,
          requestSequence: seq,
          currentSequence: seqRef.current,
          requestActive: !ac.signal.aborted,
        })) {
          setError(describeLoadError('查詢學生總表', { raw: '回應資料與目前的 Run 不一致' }));
          return;
        }
        setData(json);
        setRestoring(false);
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

  /** 已套用條件變動時重取全部facet；面板草稿不影響查詢，晚到舊回應不能覆蓋新計數。 */
  const ensureApplicableOptions = useCallback(
    async (next: StudentFilters, resolveDeferred = false): Promise<StudentFilters | null> => {
      const seq = ++optionsSeqRef.current;
      optionsAbortRef.current?.abort();
      const ac = new AbortController();
      optionsAbortRef.current = ac;
      const q = qRef.current;
      const params = buildStudentApiParams(next, q, { options: 'true' });
      try {
        const res = await fetch(`/api/v1/runs/${runId}/students?${params.toString()}`, { signal: ac.signal });
        if (!res.ok) throw new Error('無法載入篩選選項');
        const json = (await res.json()) as RunStudentOptions;
        if (!isCurrentRunResponse({
          expectedRunId: runId,
          responseRunId: json?.runId,
          requestSequence: seq,
          currentSequence: optionsSeqRef.current,
          requestActive: !ac.signal.aborted,
        }) || JSON.stringify(filtersRef.current) !== JSON.stringify(next) || qRef.current !== q) return null;
        optionsRef.current = json;
        setOptions(json);
        setOptionsClass(exactlyOneClass(next));
        if (!resolveDeferred) return next;
        const resolved = pruneResultsState({ ...restored, filters: next, pruned: [] }, json.columnOptions);
        filtersRef.current = resolved.filters;
        setFilters(resolved.filters);
        if (resolved.pruned.length) setPrunedNotice((prev) => [...prev, ...resolved.pruned]);
        return resolved.filters;
      } catch (error) {
        if (seq !== optionsSeqRef.current || ac.signal.aborted) return null;
        if (resolveDeferred && JSON.stringify(filtersRef.current) === JSON.stringify(next)) {
          setError(describeLoadError('還原本班適用折扣', failureFromException(error)));
          setLoading(false);
        }
        /* 選項載入失敗時，不猜有效性，也不刪掉原條件。 */
        return null;
      }
    },
    [runId, restored]
  );

  useEffect(() => () => {
    seqRef.current++;
    abortRef.current?.abort();
    optionsSeqRef.current++;
    optionsAbortRef.current?.abort();
    if (qTimer.current) clearTimeout(qTimer.current);
  }, []);

  const resetPaging = () => {
    setCursor(null);
    setHistoryCursors([]);
  };

  /** 點學生總表表頭排序：兩態（升冪↔降冪），點另一欄從升冪開始；清 cursor 從第一頁重查（D65 Ruling 5）。 */
  const toggleSort = useCallback(
    (field: string) => {
      const current = parseSortWire(sortRef.current);
      const next = current?.field === field && current.dir === 'asc' ? `-${field}` : field;
      sortRef.current = next;
      setSort(next);
      resetPaging();
      void load(filtersRef.current, qRef.current, null);
    },
    [load]
  );

  /**
   * 套用學生條件：條件改變即清 cursor 從第一頁重查（03 §5.1）。本班適用折扣在不再恰選一班、或班級選取有任何改變時，
   * 在重取選項前先自動移除並提示（避免過期折扣條件下的跨班計數）。
   */
  const applyFilters = useCallback(
    (next: StudentFilters) => {
      const { filters: merged, removedApplicable } = reconcileStudentFilters(filtersRef.current, next);
      setApplicableRemoved(removedApplicable);
      setPrunedNotice([]);
      setInvalidNotice(false);
      filtersRef.current = merged;
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
      void ensureApplicableOptions(filtersRef.current);
    },
    [load, runId, ensureApplicableOptions]
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
    setApplicableRemoved(null);
    setPrunedNotice([]);
    setInvalidNotice(false);
    filtersRef.current = {};
    setFilters({});
    resetPaging();
    void load({}, '', null);
    void ensureApplicableOptions({});
  }, [load, runId, ensureApplicableOptions]);

  // 掛載：還原頁內保存的姓名搜尋與捲動位置；條件與頁籤來自網址（伺服器已還原）
  useEffect(() => {
    let active = true;
    const savedQ = readStorage(Q_KEY(runId));
    const nav = (performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined)?.type;
    const returning = Date.now() - lastPopAt < 3000 || nav === 'back_forward' || nav === 'reload';
    // 開發模式的 StrictMode 會重跑 effect：已讀到但尚未套用的位置不重讀（重讀會讀到被覆寫的值）
    if (returning && !pendingScroll.current) {
      try {
        const raw = readStorage(SCROLL_KEY(runId, restored.view));
        if (raw) pendingScroll.current = JSON.parse(raw);
      } catch {
        pendingScroll.current = null;
      }
    }
    if (savedQ) qRef.current = savedQ;
    if (savedQ || restored.needsLoad) {
      awaitingLoad.current = true;
      const startingFilters = filtersRef.current;
      queueMicrotask(async () => {
        if (!active) return;
        if (savedQ) {
          setSearchQuery(savedQ);
          setAppliedQ(savedQ);
        }
        const next = restored.deferredRate ? await ensureApplicableOptions(startingFilters, true) : startingFilters;
        if (!active) return;
        if (!restored.deferredRate) void ensureApplicableOptions(startingFilters);
        if (!next || JSON.stringify(filtersRef.current) !== JSON.stringify(next)) return;
        void load(next, qRef.current, null);
      });
    } else {
      void ensureApplicableOptions(filtersRef.current);
    }
    return () => { active = false; };
    // 只在掛載時執行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 頁籤與條件同步到網址（不含姓名搜尋）；用 replaceState，不堆疊瀏覽器歷史。
  // 預設狀態（學生總表、無條件）網址保持乾淨（不寫 view／runId）；網址原本帶了參數而現在回到預設（清除全部、run 變更後選值全被移除）才改寫回乾淨路徑
  // #264：hydration commit 與 passive effect flush 之間若 Forward／Back 已把 location 切到別的路由（Next 的 popstate 監聽尚未掛上），
  // 不得用 window.location.pathname 組 target 去 replaceState，否則會把別的路由那一格改寫成本頁參數；本元件只擁有自己路由的 entry。
  useEffect(() => {
    if (window.location.pathname !== renderPathname) return;
    const isDefault = resultTab === 'students' && !hasAnySelection(filters) && !hasAnySelection(deductionFilters) && !sort;
    if (isDefault && !window.location.search) return;
    const query = isDefault ? '' : buildResultsQuery({ view: resultTab, runId, sort, filters, deductionFilters });
    const target = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    if (target !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', target);
    }
  }, [resultTab, filters, deductionFilters, runId, sort, renderPathname]);

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

  // ── 表頭篩選：全 run 值宇宙、依其他已套用條件的計數 ─────────────────
  const singleClass = exactlyOneClass(filters);

  /** 選項清單＝server `columnOptions`（顯示文字；順序即 R5 的順序，UI 不重排）；`~blank` 顯示「(空白)」。 */
  const sectionFor = (key: StudentFilterKey): FilterSection => {
    let raw = options.columnOptions[key] ?? [];
    // 本班適用折扣選項只屬於取得它時選的那一班；班級已換（選項尚未重取）時不顯示，避免跨班數字
    if (key === 'applicableDiscount' && optionsClass !== singleClass) raw = [];
    return {
      key,
      options: raw.map((o) => ({ value: optionWire(o.value), label: o.value === BLANK ? '(空白)' : o.value, count: o.count })),
    };
  };

  const renderFilter = (column: StudentColumnKey) => {
    const key = COLUMN_FILTERS[column];
    return (
      <HeaderFilter
        column={findStudentField(key)!.column}
        hideUnselectedZero
        sections={[sectionFor(key)]}
        value={{ [key]: filters[key] }}
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
  const selectedRealClasses = (filters.enrollment ?? [])
    .filter((w) => w !== BLANK && w !== NONE && w !== UNPARSEABLE_CLASS_TEXT)
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
    <div className="results-page" data-hydrated={isHydrated ? 'true' : 'false'}>
      {/* 資料來源橫幅（09 §2：來源時間／檔名一行，核對基準日另外標明）。 */}
      <section
        className="data-banner data-banner-current"
        aria-label="目前使用的資料"
      >
        <div className="data-banner-main">
          <h1 className="data-banner-title">核對結果</h1>
          <p className="data-banner-line">
            <span className="data-banner-label">目前使用的資料</span>
            {source && <span className="data-banner-file">{source.fileName}</span>}
            {source && (
              <span className="data-banner-meta">
                {`資料更新於 ${formatDateTime(source.updatedAt)}`}
              </span>
            )}
            <span className="pill">{`核對基準日 ${asOfDate}`}</span>
          </p>
        </div>
        <div className="data-banner-actions">
          <Link href="/imports" className="btn-secondary">匯入新名單</Link>
        </div>
      </section>

      {/* 技術資訊摺疊區（版本識別、長 ID 與計算說明入口收納於此，不在日常介面顯示，09 §7）；預設收合 */}
      <details className="tech-info tech-info-block">
        <summary>技術資訊</summary>
        <div className="tech-pre">
          `Run ID：${runId}｜版本 rev ${revision}｜基準日 ${asOfDate}`
        </div>
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
                {applicableRemoved === 'class-changed'
                  ? '已移除「本班適用折扣」條件：班級選取已變更，請在新的班級下重新選擇。'
                  : '已移除「本班適用折扣」條件：它只在恰選一個班級時適用。'}
              </div>
            )}
            {error && <ErrorNotice message={error.message} detail={error.detail} />}

            {/* 人數一行（09 §5.1）：全部／本班／已選N班 · 符合篩選M人 · N位需確認 —— 範圍不同，不可互相冒充 */}
            {restoring ? (!error && <p role="status">載入符合還原條件的學生總表中…</p>) : <div className="results-summary">
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
                    onClick={() => applyFilters({ ...filtersRef.current, enrollment: [BLANK] })}
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
            </div>}

            {/* 待設定班級提示（09 §8.3）：依該 run 課表快照與班名對應動態判斷，不用寫死的班名清單 */}
            {unmappedSelected.length > 0 && (
              <div className="notice-warn" role="status">
                <span>
                  <strong>待設定班級提示：</strong>班級{unmappedSelected.map((c) => `「${c}」`).join('、')}還沒有對應的課表班級，扣天無法計算。
                </span>
                <a href="/settings?tab=sync" className="btn-secondary">前往班名同步</a>
              </div>
            )}

            <SummaryTable
              students={restoring ? [] : data?.items || []}
              loading={loading}
              singleClass={singleClass}
              classCategorySnapshots={classCategorySnapshots ?? null}
              renderFilter={renderFilter}
              sort={parseSortWire(sort)}
              onSortChange={toggleSort}
              onSelectStudent={(student) => {
                if (student.runId === runId) setDrawerSelection({ runId, student });
              }}
              onResetFilters={handleResetFilters}
            />
            {!restoring && <div className="results-pager">
              <span className="counts-item">顯示 {data?.items.length ?? 0} 筆 (共 {data?.totalStudents ?? 0} 人)</span>
              <button type="button" className="btn-secondary pager-btn" onClick={handlePrevPage} disabled={historyCursors.length === 0 || loading}>
                上一頁
              </button>
              <button type="button" className="btn-secondary pager-btn" onClick={handleNextPage} disabled={!data?.nextCursor || loading}>
                下一頁
              </button>
            </div>}
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
        onClose={() => setDrawerSelection({ runId, student: null })}
      />
    </div>
  );
}

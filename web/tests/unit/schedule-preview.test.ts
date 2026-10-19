import { describe, it, expect } from 'vitest';
import { buildSchedulePreview, toSaveEquivalentDraft } from '@/application/schedule-preview';
import { CARE_WINDOWS } from '@/domain/schedules/overlap-calculator';
import {
  SettingsDraft,
  CalculateDraft,
  ScheduleGridRow,
  SettingsDraftSchema,
  buildSeedGridRows,
  classesToGridRows,
  gridRowsToClasses,
  gridRowsToCalculateClasses,
  DEFAULT_CARE_CLASS_NAMES,
} from '@/contracts/settings';
import { buildSeedDraft, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { StudentSnapshot } from '@/domain/students';

/**
 * 09 §8.1／04 §8 UX05–UX07、UX24（API 部分）：唯讀計算 read model 的純計算核心。
 * expected 皆為獨立手算（不取自待測輸出）：
 * - 安親窗口 13:00–16:00＝780–960；課輔窗口 16:30–19:30＝990–1170（週一至五）。
 * - 週一 15:20–16:50＝920–1010：課長 90；安親重疊 min(1010,960)−max(920,780)＝40；課輔重疊 min(1010,1170)−max(920,990)＝20。
 * - 週三 15:30–17:00＝930–1020：安親 960−930＝30；課輔 1020−990＝30。
 * - 每分鐘扣天＝1÷180（domain 為負值，UI 以正量顯示）；D24 同班先加總再取整：小數部分 <0.3→0、[0.3,0.8)→0.5、≥0.8→1。
 */

const CARE = {
  anqin: { startMinutes: 780, endMinutes: 960 },
  tutoring: { startMinutes: 990, endMinutes: 1170 },
};

function draftOf(classes: SettingsDraft['classes']): SettingsDraft {
  return { classes, aliases: [], careWindows: CARE, effectiveFrom: null, effectiveTo: null };
}

const cls = (
  baseName: string,
  sessions: Array<[string, number, number]>,
  extra: Partial<SettingsDraft['classes'][number]> = {}
): SettingsDraft['classes'][number] => ({
  baseName,
  subject: '國小數學',
  teacher: '老師甲',
  active: true,
  sessions: sessions.map(([weekday, startMinutes, endMinutes]) => ({
    weekday,
    startMinutes,
    endMinutes,
    skipDeduction: false,
  })),
  ...extra,
});

describe('UX05：單堂——週一 15:20–16:50（v2 預設窗口）', () => {
  const result = buildSchedulePreview(draftOf([cls('數學甲', [['一', 920, 1010]])]), 'erp-tag-v2');
  const row = result.rows[0];

  it('課長 90、安親重疊 40 分＝40÷180、課輔重疊 20 分＝20÷180（domain 負值，未取整）', () => {
    expect(row.durationMinutes).toBe(90);
    expect(row.anqin.overlapMinutes).toBe(40);
    expect(row.anqin.rawDeduction).toBeCloseTo(-40 / 180, 12);
    expect(row.anqin.status).toBe('calculated');
    expect(row.tutoring.overlapMinutes).toBe(20);
    expect(row.tutoring.rawDeduction).toBeCloseTo(-20 / 180, 12);
    expect(row.tutoring.status).toBe('calculated');
  });

  it('單堂只給未取整值：班級層的取整才是實扣（單堂不會顯成已取整）', () => {
    // 40÷180＝0.222… <0.3 → 實扣 0；20÷180＝0.111… → 0
    const c = result.classes[0];
    expect(c.anqin.rounded).toBe(0);
    expect(c.tutoring.rounded).toBe(0);
    expect(c.anqin.raw).toBeCloseTo(-40 / 180, 12);
  });

  it('回應帶唯讀窗口＝ruleSet 常數（週一至五 13:00–16:00／16:30–19:30），與 draft 無關', () => {
    expect(result.windows).toEqual({
      anqin: { startMinutes: CARE_WINDOWS.anqin.start, endMinutes: CARE_WINDOWS.anqin.end, weekdays: ['一', '二', '三', '四', '五'] },
      tutoring: { startMinutes: CARE_WINDOWS.tutoring.start, endMinutes: CARE_WINDOWS.tutoring.end, weekdays: ['一', '二', '三', '四', '五'] },
    });
  });
});

describe('UX06：同班多堂先合計再取整（D24）', () => {
  const result = buildSchedulePreview(
    draftOf([
      cls('數學乙', [
        ['一', 920, 1010], // 15:20–16:50
        ['三', 930, 1020], // 15:30–17:00
        ['五', 920, 1010], // 15:20–16:50
      ]),
    ]),
    'erp-tag-v2'
  );
  const c = result.classes[0];

  it('安親 40+30+40＝110 分，110÷180≈0.611→實扣 0.5（負 0.5）', () => {
    expect(c.anqin.totalOverlapMinutes).toBe(110);
    expect(c.anqin.raw).toBeCloseTo(-110 / 180, 12);
    expect(c.anqin.rounded).toBe(-0.5);
    expect(c.anqin.status).toBe('calculated');
  });

  it('課輔 20+30+20＝70 分，70÷180≈0.389→實扣 0.5（負 0.5）', () => {
    expect(c.tutoring.totalOverlapMinutes).toBe(70);
    expect(c.tutoring.raw).toBeCloseTo(-70 / 180, 12);
    expect(c.tutoring.rounded).toBe(-0.5);
  });

  it('逐堂值不會被取整：各堂只回 40／30／40 分，班級層才有合計與實扣', () => {
    expect(result.rows.map((r) => r.anqin.overlapMinutes)).toEqual([40, 30, 40]);
    expect(c.rowIds).toEqual(result.rows.map((r) => r.rowId));
  });

  it('rowId 穩定：同 draft 重算得同一組 id；改動其他班不影響此班 id', () => {
    const again = buildSchedulePreview(
      draftOf([cls('別班', [['二', 800, 900]]), cls('數學乙', [['一', 920, 1010], ['三', 930, 1020], ['五', 920, 1010]])]),
      'erp-tag-v2'
    );
    const idsOf = (r: typeof result, key: string) => r.classes.find((k) => k.classKey === key)!.rowIds;
    expect(idsOf(again, '數學乙')).toEqual(idsOf(result, '數學乙'));
  });
});

describe('UX07：週六／未知星期／缺起迄／共用窗口／停用', () => {
  const draft = draftOf([
    cls('週六班', [['六', 780, 960]]), // 合法週六：與週一至五窗口無交集 → 0（D30）
    cls('未知星期班', [['未知', 780, 960]]),
    cls('缺時間班', []), // 缺起迄的列被轉換掉 → 無時段
    cls('國小輔導-一A', [], { subject: '國小輔導', teacher: '玟君' }), // seed 內的共用窗口班（care_window）
    cls('停用班', [['一', 780, 960]], { active: false }),
  ]);
  const result = buildSchedulePreview(draft, 'erp-tag-v2');
  const rowOf = (key: string) => result.rows.filter((r) => r.classKey === key);
  const classOf = (key: string) => result.classes.find((c) => c.classKey === key)!;

  it('合法週六：重疊 0、狀態 no_overlap（已驗證無衝堂），非警告', () => {
    const r = rowOf('週六班')[0];
    expect(r.anqin.overlapMinutes).toBe(0);
    expect(r.anqin.status).toBe('no_overlap');
    expect(r.tutoring.status).toBe('no_overlap');
    expect(result.issues.filter((i) => i.classKey === '週六班')).toEqual([]);
  });

  it('未知星期：fail-closed 為 0，但狀態 unknown_weekday（不是「無衝堂」）並列 UNKNOWN_WEEKDAY 告警', () => {
    const r = rowOf('未知星期班')[0];
    expect(r.anqin.overlapMinutes).toBe(0);
    expect(r.anqin.status).toBe('unknown_weekday');
    expect(r.tutoring.status).toBe('unknown_weekday');
    expect(classOf('未知星期班').anqin.status).toBe('unknown_weekday');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_WEEKDAY', classKey: '未知星期班', rowId: r.rowId }));
  });

  it('缺起迄（無時段）：仍回一列佔位，時間與計算欄為 null、狀態 missing_time，並列 SCHEDULE_EMPTY；班級不扣天', () => {
    const rows = rowOf('缺時間班');
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.startMinutes).toBeNull();
    expect(r.endMinutes).toBeNull();
    expect(r.durationMinutes).toBeNull();
    expect(r.anqin).toEqual({ overlapMinutes: null, rawDeduction: null, status: 'missing_time' });
    expect(r.tutoring).toEqual({ overlapMinutes: null, rawDeduction: null, status: 'missing_time' });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'SCHEDULE_EMPTY', classKey: '缺時間班' }));
    const c = classOf('缺時間班');
    expect([c.anqin.totalOverlapMinutes, c.anqin.raw, c.anqin.rounded]).toEqual([0, 0, 0]);
    expect(c.anqin.status).toBe('missing_time');
  });

  it('共用窗口班（seed 的 care_window）：不捏造 session、狀態 shared_window，且不算缺時間問題', () => {
    const r = rowOf('國小輔導-一A')[0];
    expect(r.anqin.status).toBe('shared_window');
    expect(r.anqin.overlapMinutes).toBeNull();
    expect(result.issues.filter((i) => i.classKey === '國小輔導-一A')).toEqual([]);
    expect(classOf('國小輔導-一A').anqin.status).toBe('shared_window');
  });

  it('specs/14 §3.7 & A5：任意自訂班名只要 classType === care，即給予 shared_window 專門狀態且不產生 SCHEDULE_EMPTY', () => {
    const customCare = calcDraftOf([
      calcCls('自訂安親班', [], { classType: 'care' }),
      calcCls('一般自訂班', [], { classType: 'non_care' }),
      calcCls('未指定類型自訂班', [], {}),
    ]);
    const r = buildSchedulePreview(customCare, 'erp-tag-v2');

    // 自訂安親班：專門狀態 shared_window，無 issue
    const careCls = r.classes.find((c) => c.classKey === '自訂安親班')!;
    expect(careCls.anqin.status).toBe('shared_window');
    expect(r.issues.filter((i) => i.classKey === '自訂安親班')).toEqual([]);

    // 一般自訂班（non_care，空 sessions）：missing_time，有 SCHEDULE_EMPTY
    const nonCareCls = r.classes.find((c) => c.classKey === '一般自訂班')!;
    expect(nonCareCls.anqin.status).toBe('missing_time');
    expect(r.issues.some((i) => i.classKey === '一般自訂班' && i.code === 'SCHEDULE_EMPTY')).toBe(true);

    // 未指定類型且非 seed care 班：預設為 non_care，missing_time，有 SCHEDULE_EMPTY
    const unspecCls = r.classes.find((c) => c.classKey === '未指定類型自訂班')!;
    expect(unspecCls.anqin.status).toBe('missing_time');
    expect(r.issues.some((i) => i.classKey === '未指定類型自訂班' && i.code === 'SCHEDULE_EMPTY')).toBe(true);
  });

  it('停用班：不計算（狀態 inactive，欄位 null），班級不扣天，不列缺時間問題', () => {
    const r = rowOf('停用班')[0];
    expect(r.anqin).toEqual({ overlapMinutes: null, rawDeduction: null, status: 'inactive' });
    const c = classOf('停用班');
    expect(c.anqin.rounded).toBe(0);
    expect(c.anqin.status).toBe('inactive');
    expect(result.issues.filter((i) => i.classKey === '停用班')).toEqual([]);
  });

  it('每個 draft 班級都有結果，不漏掉不能計算的班（5 班）', () => {
    expect(result.classes.map((c) => c.classKey)).toEqual(['週六班', '未知星期班', '缺時間班', '國小輔導-一A', '停用班']);
  });
});

describe('ruleSetVersion 語意（v2 同星期；v1 不比對星期）', () => {
  const draft = draftOf([cls('週六班', [['六', 780, 960]])]);

  it('v2：週六與週一至五窗口無交集 → 0', () => {
    const r = buildSchedulePreview(draft, 'erp-tag-v2');
    expect(r.rows[0].anqin.overlapMinutes).toBe(0);
  });

  it('v1（既有正式舊版）：純時刻比對，不看星期 → 週六 13:00–16:00 對安親窗口重疊 180', () => {
    const r = buildSchedulePreview(draft, 'erp-tag-v1');
    expect(r.rows[0].anqin.overlapMinutes).toBe(180);
    expect(r.ruleSetVersion).toBe('erp-tag-v1');
  });
});

describe('讀模型與學生 run 同源（seed 全部數學／美語班逐班對照）', () => {
  const mk = (baseName: string, grade: number): StudentSnapshot => ({
    personCode: `T-${baseName}-${grade}`,
    name: '合成',
    branch: '本校',
    gradeRaw: `小${grade}`,
    grade,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    enrollments: [
      {
        rawToken: `${baseName}[團]`,
        yearPrefix: null,
        baseName,
        groupFlag: '團',
        modifiers: [],
        withdrawalDate: null,
        erpBillingTierRaw: null,
        erpBillingTier: null,
        tierParseStatus: 'not_applicable',
        parseStatus: 'ok',
      },
    ],
    sourceRow: 1,
  });

  it('班級 read model 的實扣 ＝ 僅報名該班的學生 run 天數（R11：小一安親 max(3.5, 5＋實扣)；R12：小三課輔 max(3, 5＋實扣)）', () => {
    const draft = buildSeedDraft();
    const preview = buildSchedulePreview(draft, 'erp-tag-v2');
    const override = draftToScheduleOverride(draft);
    const subjectClasses = preview.classes.filter((c) => /國小數學|兒童美語/.test(c.classKey));
    expect(subjectClasses.length).toBeGreaterThan(30);

    for (const c of subjectClasses) {
      const g1 = calculateStudentBilling(mk(c.classKey, 1), { ruleSetVersion: 'erp-tag-v2', scheduleOverride: override });
      expect(g1.careDays.anqin.days, `${c.classKey} 小一安親`).toBe(Math.max(3.5, 5 + c.anqin.rounded));
      const g3 = calculateStudentBilling(mk(c.classKey, 3), { ruleSetVersion: 'erp-tag-v2', scheduleOverride: override });
      expect(g3.careDays.tutoring.days, `${c.classKey} 小三課輔`).toBe(Math.max(3, 5 + c.tutoring.rounded));
    }
  });
});

/**
 * R1b rework B1（09 §8.1／plan 10 §2「以既有 SettingsDraft／ScheduleGridRow 轉換，不漏掉不能計算的列」）：
 * calculate 的 session 可為不完整列（起／迄為 null，或迄 ≤ 起）並帶 client 的 rowId。
 * 不完整列回 null 值＋missing_time＋SCHEDULE_INCOMPLETE；班級層標 incomplete、扣天只統計完整列
 * （與存檔時經 gridRowsToClasses 丟棄不完整列後實際 run 的計算相同）；rowId 原樣回傳。
 * expected 為獨立手算：週一 15:20–16:50 課輔重疊 20 分；週五同；同班兩堂課輔 40 分＝40÷180＝0.222→實扣 0；
 * 若把週三 15:30–17:00 的 30 分算進去則 70÷180＝0.389→0.5，故實扣 0 證明不完整列沒被計入。
 */
type CalcSession = CalculateDraft['classes'][number]['sessions'][number];
const calcCls = (
  baseName: string,
  sessions: CalcSession[],
  extra: Partial<CalculateDraft['classes'][number]> = {}
): CalculateDraft['classes'][number] => ({
  baseName,
  subject: '國小數學',
  teacher: '老師甲',
  active: true,
  sessions,
  ...extra,
});
const calcDraftOf = (classes: CalculateDraft['classes']): CalculateDraft => ({
  classes,
  aliases: [],
  careWindows: CARE,
  effectiveFrom: null,
  effectiveTo: null,
});
const s = (rowId: string | undefined, weekday: string, startMinutes: number | null, endMinutes: number | null): CalcSession =>
  rowId === undefined
    ? { weekday, startMinutes, endMinutes, skipDeduction: false }
    : { rowId, weekday, startMinutes, endMinutes, skipDeduction: false };

describe('B1：不完整列（缺起／缺迄／迄≤起）——回 null＋missing_time＋SCHEDULE_INCOMPLETE，班級標 incomplete', () => {
  const draft = calcDraftOf([
    calcCls('數學甲', [s('r-mon', '一', 920, 1010), s('r-wed', '三', 930, null), s('r-fri', '五', 920, 1010)]),
  ]);
  const result = buildSchedulePreview(draft, 'erp-tag-v2');
  const byId = (id: string) => result.rows.find((r) => r.rowId === id)!;

  it('每個輸入列都有結果（不漏列）：3 列，順序同輸入', () => {
    expect(result.rows.map((r) => r.rowId)).toEqual(['r-mon', 'r-wed', 'r-fri']);
  });

  it('不完整列：重疊／扣天為 null、狀態 missing_time、時長 null，起迄如實回傳（缺迄＝null）', () => {
    const r = byId('r-wed');
    expect(r.startMinutes).toBe(930);
    expect(r.endMinutes).toBeNull();
    expect(r.durationMinutes).toBeNull();
    for (const g of [r.anqin, r.tutoring]) {
      expect(g.overlapMinutes).toBeNull();
      expect(g.rawDeduction).toBeNull();
      expect(g.status).toBe('missing_time');
    }
  });

  it('完整列不受影響：週一仍為安親 40／課輔 20、狀態 calculated', () => {
    const r = byId('r-mon');
    expect(r.anqin.overlapMinutes).toBe(40);
    expect(r.tutoring.overlapMinutes).toBe(20);
    expect(r.tutoring.status).toBe('calculated');
  });

  it('班級層：status 為 incomplete（不是 calculated），扣天只統計完整列（課輔 40 分→實扣 0，不是 70 分→0.5）', () => {
    const c = result.classes[0];
    expect(c.anqin.status).toBe('incomplete');
    expect(c.tutoring.status).toBe('incomplete');
    expect(c.tutoring.totalOverlapMinutes).toBe(40);
    expect(c.tutoring.raw).toBeCloseTo(-40 / 180, 12);
    expect(c.tutoring.rounded).toBe(0);
    expect(c.anqin.totalOverlapMinutes).toBe(80);
    expect(c.rowIds).toEqual(['r-mon', 'r-wed', 'r-fri']);
  });

  it('列出 SCHEDULE_INCOMPLETE 問題（帶 rowId 與班名），且不因此列出 SCHEDULE_EMPTY／UNKNOWN_WEEKDAY', () => {
    expect(result.issues.filter((i) => i.code === 'SCHEDULE_INCOMPLETE')).toEqual([
      expect.objectContaining({ code: 'SCHEDULE_INCOMPLETE', classKey: '數學甲', rowId: 'r-wed' }),
    ]);
    expect(result.issues.map((i) => i.code)).toEqual(['SCHEDULE_INCOMPLETE']);
  });

  it('缺起、起迄皆缺、迄＝起、迄＜起 都算不完整列；起迄值如實回傳', () => {
    const r = buildSchedulePreview(
      calcDraftOf([
        calcCls('數學乙', [s('a', '一', null, 1010), s('b', '一', null, null), s('c', '一', 930, 930), s('d', '一', 930, 900), s('ok', '一', 920, 1010)]),
      ]),
      'erp-tag-v2'
    );
    for (const id of ['a', 'b', 'c', 'd']) {
      const row = r.rows.find((x) => x.rowId === id)!;
      expect(row.anqin.status, id).toBe('missing_time');
      expect(row.anqin.overlapMinutes, id).toBeNull();
      expect(row.durationMinutes, id).toBeNull();
    }
    expect(r.rows.find((x) => x.rowId === 'd')!.startMinutes).toBe(930);
    expect(r.rows.find((x) => x.rowId === 'd')!.endMinutes).toBe(900);
    expect(r.rows.find((x) => x.rowId === 'a')!.startMinutes).toBeNull();
    expect(r.issues.filter((i) => i.code === 'SCHEDULE_INCOMPLETE').map((i) => i.rowId)).toEqual(['a', 'b', 'c', 'd']);
    // 唯一完整列的值不受影響（安親 40 分）
    expect(r.classes[0].anqin.totalOverlapMinutes).toBe(40);
    expect(r.classes[0].anqin.status).toBe('incomplete');
  });

  it('整班都是不完整列：班級 incomplete、不扣天（與存檔後 sessions 為空、run 不扣天且列問題一致）', () => {
    const r = buildSchedulePreview(calcDraftOf([calcCls('數學丙', [s('x', '一', null, null), s('y', '三', 930, null)])]), 'erp-tag-v2');
    const c = r.classes[0];
    expect(c.anqin.status).toBe('incomplete');
    expect(c.anqin.rounded).toBe(0);
    expect(c.anqin.totalOverlapMinutes).toBe(0);
    expect(r.rows.map((x) => x.rowId)).toEqual(['x', 'y']);
    expect(toSaveEquivalentDraft(calcDraftOf([calcCls('數學丙', [s('x', '一', null, null)])])).classes[0].sessions).toEqual([]);
  });

  it('停用班的不完整列：狀態 inactive、不列 SCHEDULE_INCOMPLETE；seed 共用窗口班的 null 時間列為 shared_window，不算缺時間', () => {
    const r = buildSchedulePreview(
      calcDraftOf([
        calcCls('停用班', [s('i1', '一', null, null)], { active: false }),
        calcCls('國小輔導-一A', [s('sw1', '一~五', null, null)], { subject: '國小輔導' }),
      ]),
      'erp-tag-v2'
    );
    expect(r.rows.find((x) => x.rowId === 'i1')!.anqin.status).toBe('inactive');
    expect(r.classes.find((c) => c.classKey === '停用班')!.anqin.status).toBe('inactive');
    expect(r.rows.find((x) => x.rowId === 'sw1')!.anqin.status).toBe('shared_window');
    expect(r.classes.find((c) => c.classKey === '國小輔導-一A')!.anqin.status).toBe('shared_window');
    expect(r.issues).toEqual([]);
  });

  it('不完整列的星期無法識別：以 missing_time 為準，不另列 UNKNOWN_WEEKDAY', () => {
    const r = buildSchedulePreview(calcDraftOf([calcCls('數學丁', [s('w', '？', 930, null)])]), 'erp-tag-v2');
    expect(r.issues.map((i) => i.code)).toEqual(['SCHEDULE_INCOMPLETE']);
  });
});

describe('B1：rowId 穩定——client 帶的原樣回傳，未帶才由 server 補（班名#序號）', () => {
  it('client rowId 原樣回傳；未帶者補 `班名#index`；改班名不影響 client 帶來的 rowId', () => {
    const a = buildSchedulePreview(calcDraftOf([calcCls('甲', [s('grid-1', '一', 920, 1010), s(undefined, '三', 930, 1020)])]), 'erp-tag-v2');
    expect(a.rows.map((r) => r.rowId)).toEqual(['grid-1', '甲#1']);
    const renamed = buildSchedulePreview(calcDraftOf([calcCls('乙', [s('grid-1', '一', 920, 1010), s('grid-2', '三', 930, 1020)])]), 'erp-tag-v2');
    expect(renamed.rows.map((r) => r.rowId)).toEqual(['grid-1', 'grid-2']);
    expect(renamed.classes[0].rowIds).toEqual(['grid-1', 'grid-2']);
  });

  it('刪掉中間一列：其餘列的 rowId 不位移（不是 index 重編）', () => {
    const full = buildSchedulePreview(calcDraftOf([calcCls('甲', [s('g1', '一', 920, 1010), s('g2', '二', 920, 1010), s('g3', '三', 920, 1010)])]), 'erp-tag-v2');
    const removed = buildSchedulePreview(calcDraftOf([calcCls('甲', [s('g1', '一', 920, 1010), s('g3', '三', 920, 1010)])]), 'erp-tag-v2');
    expect(full.rows.map((r) => r.rowId)).toEqual(['g1', 'g2', 'g3']);
    expect(removed.rows.map((r) => r.rowId)).toEqual(['g1', 'g3']);
    expect(removed.rows.find((r) => r.rowId === 'g3')).toEqual(full.rows.find((r) => r.rowId === 'g3'));
  });
});

describe('B1：存檔等價 draft——去掉不完整列與 rowId，結果與經 gridRowsToClasses 存檔的 draft 相同', () => {
  const editedGrid = (): ScheduleGridRow[] => {
    const rows = classesToGridRows(gridRowsToClasses(buildSeedGridRows()));
    // 挖掉一堂的迄時間、清空另一堂的起迄，再新增一列空白新列
    const target = rows.find((r) => r.className === '國小數學-三A')!;
    target.endTime = '';
    target.endMinutes = null;
    const other = rows.find((r) => r.className === '國小數學-一A')!;
    other.startTime = '';
    other.endTime = '';
    other.startMinutes = null;
    other.endMinutes = null;
    rows.push({ rowId: 'new-row-1', className: '新班', teacher: null, weekday: '一', startTime: '', endTime: '', startMinutes: null, endMinutes: null, active: true, skipDeduction: false });
    return rows;
  };

  it('gridRowsToCalculateClasses 保留非安親課輔班每一列（含不完整列）並帶 grid 的 rowId；安親課輔班 sessions 為空（specs/14 §3.6）', () => {
    const rows = editedGrid();
    const calc = gridRowsToCalculateClasses(rows);
    const total = calc.reduce((n, c) => n + c.sessions.length, 0);
    // specs/14 §3.6：安親課輔班 sessions 一律輸出為 []，非安親課輔班保留每一列
    const nonCareRows = rows.filter((r) => r.className.trim() !== '' && !DEFAULT_CARE_CLASS_NAMES.has(r.className.trim()));
    expect(total).toBe(nonCareRows.length);
    const ids = calc.flatMap((c) => c.sessions.map((x) => x.rowId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('new-row-1');
  });

  it('toSaveEquivalentDraft(calc classes) 深度等於 gridRowsToClasses(rows)（同一份 grid 存檔會得到的班級）', () => {
    const rows = editedGrid();
    const seed = calcDraftOf([]);
    const save = toSaveEquivalentDraft({ ...seed, classes: gridRowsToCalculateClasses(rows) });
    expect(save.classes).toEqual(gridRowsToClasses(rows));
    expect(SettingsDraftSchema.safeParse(save).success).toBe(true);
  });

  it('讀模型班級數字＝存檔等價 draft 的班級數字（不完整列不影響）', () => {
    const rows = editedGrid();
    const calcDraft = { ...calcDraftOf([]), classes: gridRowsToCalculateClasses(rows) };
    const viaCalc = buildSchedulePreview(calcDraft, 'erp-tag-v2');
    const viaSave = buildSchedulePreview(toSaveEquivalentDraft(calcDraft), 'erp-tag-v2');
    for (const c of viaCalc.classes) {
      const same = viaSave.classes.find((x) => x.classKey === c.classKey)!;
      expect(c.anqin.totalOverlapMinutes, c.classKey).toBe(same.anqin.totalOverlapMinutes);
      expect(c.anqin.rounded, c.classKey).toBe(same.anqin.rounded);
      expect(c.tutoring.rounded, c.classKey).toBe(same.tutoring.rounded);
    }
    // 被挖掉起／迄的兩個班：讀模型標 incomplete（存檔後則是少了那一堂／整班空）
    expect(viaCalc.classes.find((c) => c.classKey === '國小數學-三A')!.anqin.status).toBe('incomplete');
    expect(viaCalc.classes.find((c) => c.classKey === '新班')!.anqin.status).toBe('incomplete');
  });

  it('無不完整列時，calculate 的班級狀態與計算值與改動前相同（不引入 incomplete）', () => {
    // 只取有完整時段的 seed 班（沒有時段的班展平成佔位列，本來就是不完整列）
    const rows = classesToGridRows(buildSeedDraft().classes.filter((c) => c.sessions.length > 0));
    const viaCalc = buildSchedulePreview({ ...calcDraftOf([]), classes: gridRowsToCalculateClasses(rows) }, 'erp-tag-v2');
    expect(viaCalc.classes).toHaveLength(40);
    expect(viaCalc.classes.filter((c) => c.anqin.status === 'incomplete' || c.tutoring.status === 'incomplete')).toEqual([]);
    expect(viaCalc.issues).toEqual([]);
  });
});

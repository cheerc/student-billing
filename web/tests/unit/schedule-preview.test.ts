import { describe, it, expect } from 'vitest';
import { buildSchedulePreview } from '@/application/schedule-preview';
import { CARE_WINDOWS } from '@/domain/schedules/overlap-calculator';
import { SettingsDraft } from '@/contracts/settings';

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
  sessions: sessions.map(([weekday, startMinutes, endMinutes]) => ({ weekday, startMinutes, endMinutes })),
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

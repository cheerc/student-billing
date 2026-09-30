/**
 * D2b parity baseline：同一 import、同一設定快照、同一數值政策，
 * 以 v2 與 v3 各跑一次全量計算，逐人比對 S manifest §6.1 差異表的「比較的業務欄位」。
 *
 * 本批只「提供差異紀錄」，不收斂 parity gate（屬 D2c）。本檔不是 gate，是 baseline 記錄。
 * 只用合成 fixture（tests/fixtures/conforming-erp-fixture.xlsx），不讀 data/。
 */
import { calculateStudentBilling } from '../src/domain/billing/billing-calculator';
import { buildClassSettingMap } from '../src/application/calculate-run';
import { buildSeedDraft } from '../src/adapters/sqlite/settings-repository';
import type { StudentSnapshot } from '../src/domain/students';

const FIXTURE = 'tests/fixtures/conforming-erp-fixture.xlsx';

async function loadStudents(): Promise<StudentSnapshot[]> {
  const { generateImportPreview } = await import('../src/application/import-preview');
  const fs = await import('fs');
  const buf = fs.readFileSync(FIXTURE);
  const preview = await generateImportPreview(buf, 'fixture.xlsx');
  return preview.students;
}

function summarize(s: StudentSnapshot) {
  const common = { aliasMap, scheduleOverride, classSettings };
  const r = calculateStudentBilling(s, { ...common, ruleSetVersion: 'erp-tag-v2' });
  const v3 = calculateStudentBilling(s, { ...common, ruleSetVersion: 'erp-tag-v3' as any });
  return {
    personCode: s.personCode,
    v2: {
      anqinDays: r.careDays.anqin.days,
      tutoringDays: r.careDays.tutoring.days,
      subjectCount: r.subjectCount,
      baseDiscountBps: r.baseDiscountBps,
      applicableAnqinBps: r.applicableAnqinBps,
      applicableTutoringBps: r.applicableTutoringBps,
      applicableMathBps: r.applicableMathBps,
      applicableEnglishBps: r.applicableEnglishBps,
      tierMismatch: r.tierComparisons.some((c) => c.status === 'mismatch'),
      tierStatuses: r.tierComparisons.map((c) => c.status).sort().join(','),
      issueCodes: [...new Set((r.issues as Array<{ code: string }>).map((i) => i.code))].sort().join(','),
    },
    v3: {
      anqinDays: v3.careDays.anqin.days,
      tutoringDays: v3.careDays.tutoring.days,
      subjectCount: v3.subjectCount,
      baseDiscountBps: v3.baseDiscountBps,
      applicableAnqinBps: v3.applicableAnqinBps,
      applicableTutoringBps: v3.applicableTutoringBps,
      applicableMathBps: v3.applicableMathBps,
      applicableEnglishBps: v3.applicableEnglishBps,
      tierMismatch: v3.tierComparisons.some((c) => c.status === 'mismatch'),
      tierStatuses: v3.tierComparisons.map((c) => c.status).sort().join(','),
      issueCodes: [...new Set((v3.issues as Array<{ code: string }>).map((i) => i.code))].sort().join(','),
    },
  };
}

const FIELDS = [
  'anqinDays', 'tutoringDays', 'subjectCount', 'baseDiscountBps',
  'applicableAnqinBps', 'applicableTutoringBps', 'applicableMathBps', 'applicableEnglishBps',
  'tierMismatch', 'tierStatuses', 'issueCodes',
] as const;

// 同一份設定快照（seed 草稿）：兩側的 aliasMap／scheduleOverride／classSettings 完全相同，
// 唯一差異是規則版本（這是 parity 的定義：固定同一 import、同一設定快照、同一數值政策）。
const draft = buildSeedDraft();
const aliasMap = new Map<string, string>();
for (const a of draft.aliases) aliasMap.set(a.rawBaseName, a.targetBaseName);
const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>();
for (const c of draft.classes) {
  if (!c.active || c.sessions.length === 0) { scheduleOverride.set(c.baseName, []); continue; }
  scheduleOverride.set(c.baseName, c.sessions.map((x) => ({ start: x.startMinutes, end: x.endMinutes, weekday: x.weekday })));
}
const classSettings = buildClassSettingMap(draft);

const students = await loadStudents();
console.log(`fixture 學生總數 = ${students.length}（含無報名者）`);
console.log(`有報名的學生 = ${students.filter((s) => s.enrollments.length > 0).length}`);

const diffs = new Map<string, number>();
const examples = new Map<string, string[]>();
for (const s of students) {
  const a = summarize(s);
  for (const f of FIELDS) {
    if (a.v2[f] === a.v3[f]) continue;
    const key = f;
    diffs.set(key, (diffs.get(key) ?? 0) + 1);
    const list = examples.get(key) ?? [];
    if (list.length < 3) list.push(`${a.personCode} v2=${a.v2[f]} v3=${a.v3[f]}`);
    examples.set(key, list);
  }
}

console.log('\n=== v3 相對 v2 的逐欄差異（baseline，非 gate）===');
for (const f of FIELDS) {
  const n = diffs.get(f) ?? 0;
  console.log(`${f}: ${n} 人`);
  for (const e of examples.get(f) ?? []) console.log(`    ${e}`);
}
// 依 S manifest §6.1 差異表歸類：issue 集合的差異應只落在 D-05（新增 CLASS_NOT_MAPPED）
// 與 D-07（美語缺課表補 SCHEDULE_NOT_FOUND）。其餘任何差異即為表外差異，須停下回報（D2c 收斂）。
const newCodes = new Map<string, number>();
for (const s of students) {
  const a = summarize(s);
  const v2 = new Set(a.v2.issueCodes ? a.v2.issueCodes.split(',') : []);
  const v3 = new Set(a.v3.issueCodes ? a.v3.issueCodes.split(',') : []);
  for (const c of v3) if (!v2.has(c)) newCodes.set(c, (newCodes.get(c) ?? 0) + 1);
}
console.log('\n=== v3 新增的 issue code（D-05／D-07 為差異表所列）===');
for (const [c, n] of newCodes) console.log(`${c}: ${n} 人`);
const offTable = [...newCodes.keys()].filter((c) => c !== 'CLASS_NOT_MAPPED' && c !== 'SCHEDULE_NOT_FOUND');
console.log(offTable.length === 0 ? '差異表外的新增 code：無' : `差異表外的新增 code：${offTable.join(', ')}`);

console.log('\nDONE');

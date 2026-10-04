import type { StudentSnapshot } from '../src/domain/students/types.js';

/**
 * 477 人合成名冊 fixture（PR #73 reviewer N1：runner 與測試檔各自複製會靜默漂移，
 * 使 1000ms gate 量到與正確性斷言不同的資料集）。兩邊共用本模組。
 *
 * 全合成、保形匿名：不含真實個資，不讀 canonical data/。
 * 班名格式 D41：「班級名稱[團][optional]」。
 */

export const ROSTER_SEED_CLASSES = [
  '國小數學-一A', '國小數學-二A', '國小數學-二B', '國小數學-三A', '國小數學-四A', '國小數學-五A', '國小數學-六A',
  '兒童美語-KA', '兒童美語-KB', '兒童美語-EA', '兒童美語-Gino', '兒童美語-Ali', '兒童美語-Cody',
  '國小輔導-一A', '國小輔導-二A', '國小輔導-三年級', '國小輔導-四年級', '國小輔導-五年級', '國小輔導-六年級',
];

export const ROSTER_STUDENT_COUNT = 477;
export const ROSTER_NEW_STUDENT_COUNT = 10;

export function makeRosterStudent(i: number, extraClasses: string[] = [], dropLast = false): StudentSnapshot {
  const grade = (i % 6) + 1;
  const count = (i % 4) + 1;
  const names: string[] = [];
  for (let k = 0; k < count; k++) names.push(ROSTER_SEED_CLASSES[(i * 7 + k * 5) % ROSTER_SEED_CLASSES.length]);
  const unique = [...new Set(names)];
  if (dropLast && unique.length > 1) unique.pop();
  for (const e of extraClasses) if (!unique.includes(e)) unique.push(e);
  return {
    personCode: `P${String(i).padStart(4, '0')}`,
    name: `學生${i}`,
    branch: '本校',
    gradeRaw: `${grade}年級`,
    grade,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: i % 11 === 0 ? '有兄弟姊妹折扣' : i % 13 === 0 ? '園內生' : '',
    tags: i % 11 === 0 ? ['有兄弟姊妹折扣'] : i % 13 === 0 ? ['園內生'] : [],
    notesRaw: '',
    enrollments: unique.map((bn) => ({
      rawToken: `${bn}[團]`,
      yearPrefix: null,
      baseName: bn,
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    })),
    sourceRow: i + 2,
  };
}

export interface RosterPair { importId: string; students: StudentSnapshot[]; createdAt: string }

/** before 名冊 477 人（固定內容）；after 名冊含加課／退課／未出現／新增四類異動。 */
export function buildRosterPair(): { before: RosterPair; after: RosterPair } {
  const before: StudentSnapshot[] = [];
  const after: StudentSnapshot[] = [];
  for (let i = 0; i < ROSTER_STUDENT_COUNT; i++) {
    before.push(makeRosterStudent(i));
    if (i % 3 === 0) after.push(makeRosterStudent(i, ['國小數學-三A']));
    else if (i % 10 === 1) after.push(makeRosterStudent(i, [], true));
    else if (i % 47 === 5) continue;
    else after.push(makeRosterStudent(i));
  }
  for (let j = ROSTER_STUDENT_COUNT; j < ROSTER_STUDENT_COUNT + ROSTER_NEW_STUDENT_COUNT; j++) {
    after.push(makeRosterStudent(j));
  }
  return {
    before: { importId: 'imp_perf_base', students: before, createdAt: '2026-09-28T10:00:00.000Z' },
    after: { importId: 'imp_perf_next', students: after, createdAt: '2026-09-29T10:00:00.000Z' },
  };
}
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { readScheduleSeed } from '@/adapters/xlsx/schedule-seed-reader';

describe('排課 Seed 讀取器整合測試 (schedule-seed-reader)', () => {
  const filePath = '/Users/cheerc/Projects/student-billing/國小美語點名表自動輸出含折扣、扣衝堂(範例)-v260922.xlsx';
  const hasLocalFile = fs.existsSync(filePath);

  it.runIf(hasLocalFile)('從計算檔 S 表讀取 A:E 手動時段與兩組 care_windows 應完整且符合統計', async () => {
    const seed = await readScheduleSeed(filePath);

    // 49 班總量
    expect(seed.classes).toHaveLength(49);

    // 89 筆班名 session 列
    expect(seed.totalSessionRows).toBe(89);

    // 40 班有時段
    const withSchedule = seed.classes.filter((c) => c.source === 'schedule');
    expect(withSchedule).toHaveLength(40);

    // 8 班 care_window
    const careWindows = seed.classes.filter((c) => c.source === 'care_window');
    expect(careWindows).toHaveLength(8);

    // 1 班 empty (國小數學-一B[團])
    const emptyClass = seed.classes.filter((c) => c.source === 'empty');
    expect(emptyClass).toHaveLength(1);
    expect(emptyClass[0].rawName).toBe('國小數學-一B[團]');

    // 驗證兩組 care windows
    expect(seed.careWindows.anqin.startMinutes).toBe(780); // 13:00
    expect(seed.careWindows.anqin.endMinutes).toBe(960); // 16:00
    expect(seed.careWindows.tutoring.startMinutes).toBe(990); // 16:30
    expect(seed.careWindows.tutoring.endMinutes).toBe(1170); // 19:30
  });
});

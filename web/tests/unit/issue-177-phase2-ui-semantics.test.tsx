import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ExcelJS from 'exceljs';
import DetailDrawer from '@/components/detail-drawer';
import SettingsEditor from '@/components/settings-editor';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import {
  buildScheduleWorkbook,
  parseScheduleWorkbook,
  SCHEDULE_TABLE_HEADERS,
} from '@/adapters/xlsx/schedule-table-io';
import type { StudentCalculationItem } from '@/application/query-students';
import type { ScheduleGridRow } from '@/contracts/settings';

const mockStudentBase: StudentCalculationItem = {
  id: 'calc_test_p2',
  runId: 'run_test_p2',
  personCode: 'STU001',
  name: '王小明',
  branch: '資優生',
  grade: 3,
  gradeRaw: '小三',
  subjectCount: 2,
  baseDiscountBps: 8500,
  anqinDays: 5,
  anqinDisplay: '5',
  tutoringDays: 3,
  tutoringDisplay: '3',
  chineseDays: null,
  mathDays: null,
  englishDays: null,
  homeworkDays: null,
  intensiveEnglishDays: null,
  saturdayTutoringDays: null,
  applicableAnqinBps: 9000,
  applicableTutoringBps: 8500,
  applicableEnglishBps: 8500,
  applicableMathBps: 8500,
  tierMismatch: false,
  tierComparisons: [],
  issues: [],
  hasIssues: false,
  actionableIssues: [],
  actionableHasIssues: false,
  trace: { rawTags: '一般生' },
  createdAt: '2026-10-27T00:00:00.000Z',
  enrollments: [],
  sourceRow: 2,
  classText: null,
};

describe('Issue #177 Phase 2: UI 與課表契約收斂 (TDD RED -> GREEN)', () => {
  describe('1. DetailDrawer 抽屜精簡為 2 格天數卡', () => {
    it('僅顯示「安親天數」與「課輔天數」2 格，不渲染 6 欄舊點名表天數卡片', () => {
      const html = renderToStaticMarkup(
        React.createElement(DetailDrawer, {
          student: mockStudentBase,
          onClose: () => {},
          ruleSetVersion: 'erp-tag-v4',
        })
      );

      // 包含安親天數與課輔天數
      expect(html).toContain('安親天數');
      expect(html).toContain('課輔天數');

      // 6 欄舊點名表天數卡片必須徹底移除
      expect(html).not.toContain('美語天數');
      expect(html).not.toContain('數學天數');
      expect(html).not.toContain('中文天數');
      expect(html).not.toContain('寫功課');
      expect(html).not.toContain('加重美語');
      expect(html).not.toContain('週六課輔');
    });
  });

  describe('2. Excel 匯出單一 9 欄課表工作表，匯入忽略未知工作表', () => {
    it('buildScheduleWorkbook 僅產出單一「課表」工作表，不包含隱藏的 __class_semantics', async () => {
      const rows: ScheduleGridRow[] = [
        {
          rowId: 'row-1',
          className: '兒童美語-初級',
          teacher: 'Amy',
          weekday: '一',
          startTime: '14:00',
          endTime: '15:30',
          startMinutes: 840,
          endMinutes: 930,
          active: true,
          skipDeduction: false,
        },
      ];
      const classAttrs = [
        {
          className: '兒童美語-初級',
          classType: 'non_care' as const,
          category: 'english' as const,
          fixedFiveDays: false,
        },
      ];

      const buffer = await buildScheduleWorkbook(rows, classAttrs);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

      // 僅包含 1 個工作表，且名稱為「課表」
      expect(workbook.worksheets).toHaveLength(1);
      expect(workbook.worksheets[0].name).toBe('課表');
      expect(workbook.getWorksheet('__class_semantics')).toBeUndefined();

      // 表頭為 9 欄
      const headerRow = workbook.worksheets[0].getRow(1);
      const headers = SCHEDULE_TABLE_HEADERS.map((_, i) => headerRow.getCell(i + 1).text.trim());
      expect(headers).toEqual([...SCHEDULE_TABLE_HEADERS]);
    });

    it('parseScheduleWorkbook 忽略未知的 __class_semantics 工作表，正常解析課表內容', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('課表');
      sheet.addRow([...SCHEDULE_TABLE_HEADERS]);
      sheet.addRow(['國小數學-高階', '非安親課輔班', '數學班', '否', '否', '張老師', '二', '16:00', '17:30']);

      // 人為加入未知或歷史 __class_semantics 工作表
      const dummyMeta = workbook.addWorksheet('__class_semantics');
      dummyMeta.addRow(['schemaVersion', 999]);
      dummyMeta.addRow(['arbitrary', 'legacy-data']);

      const buffer = await workbook.xlsx.writeBuffer();
      const result = await parseScheduleWorkbook(Buffer.from(buffer));

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].className).toBe('國小數學-高階');
      expect(result.classAttrs).toHaveLength(1);
      expect(result.classAttrs[0].className).toBe('國小數學-高階');
      expect(result.classAttrs[0].category).toBe('math');
      // 不再回傳或依賴 classTypeDefinitions
      expect((result as unknown as Record<string, unknown>).classTypeDefinitions).toBeUndefined();
    });
  });

  describe('3. buildSeedDraft 純淨化與契約收斂', () => {
    it('buildSeedDraft 輸出乾淨 49 班草稿，無 classTypeDefinitions、無 summaryDayRoles 等語意欄位', () => {
      const seedDraft = buildSeedDraft();

      expect(seedDraft.classes).toHaveLength(49);
      // classTypeDefinitions 應為 undefined 或不存在
      expect((seedDraft as unknown as Record<string, unknown>).classTypeDefinitions).toBeUndefined();

      // 檢查班級屬性：不應存在 #148 語意殘留
      for (const cls of seedDraft.classes) {
        const clsRecord = cls as unknown as Record<string, unknown>;
        expect(clsRecord.summaryDayRoles).toBeUndefined();
        expect(clsRecord.summaryDayRolesStatus).toBeUndefined();
        expect(clsRecord.summaryDayRolesSource).toBeUndefined();
        expect(clsRecord.erpTierApplicability).toBeUndefined();
        expect(clsRecord.erpTierApplicabilitySource).toBeUndefined();
        expect(clsRecord.subjectSource).toBeUndefined();
        expect(clsRecord.classTypeId).toBeUndefined();
        expect(clsRecord.semanticOnly).toBeUndefined();
        expect(['care', 'non_care']).toContain(cls.classType);
      }
    });
  });

  describe('4. SettingsEditor UI 移除語意面板與遷移建議表，收斂名冊待加入區塊為 <details>', () => {
    it('不渲染 ClassSemanticsPanel 與 legacyMigrationPending 黃色建議表，待加入區塊為 <details>', () => {
      const seedDraft = buildSeedDraft();
      const html = renderToStaticMarkup(
        React.createElement(SettingsEditor, {
          importId: 'imp_test',
          currentRevision: 1,
          initialDraft: seedDraft,
          initialTab: 'schedule',
        })
      );

      // 1. 舊班遷移黃色建議表必須完全移除
      expect(html).not.toContain('data-legacy-semantic-migration');
      expect(html).not.toContain('舊規則語意遷移建議');

      // 2. ClassSemanticsPanel 語意設定面板必須完全移除
      expect(html).not.toContain('data-class-semantics-panel');
      expect(html).not.toContain('班級語意設定');

      // 3. 不計扣天欄位不可有「此類型未支援」文字（移除 supportedAttributeKeysByClass 後）
      expect(html).not.toContain('未支援折扣類別');
      expect(html).not.toContain('未支援不計扣天');

      // 4. 保存條樣式驗證：應還原乾淨樣式
      expect(html).toContain('savebar');
    });
  });
});

/**
 * `e2e-conventions.test.ts` 的例外清單（Issue #188 Phase 1）。
 *
 * 為什麼需要這份清單：Phase 1 只修 A 族（導覽／列定位），族 B（淘汰選取器）是 Phase 2、
 * 族 D（空白星期契約）是 Phase 4。守門測試在 Phase 1 合併時就必須是綠的（CI 跑 `npm test`），
 * 否則它會擋住自己的 PR；但把例外寫成「整個檔跳過」會讓 Phase 2 修完後沒人回來拿掉例外。
 *
 * 因此每一筆例外都綁定一個**具體字面**（`literals`）或「尚未改用 helper」（`rowHelper`），
 * 以及一個必須在 Phase 2／Phase 4 完成的收斂動作。守門測試另外驗證：
 * - 例外指向的檔案必須存在，
 * - 理由長度必須 > 10（不能留空話），
 * - 例外用到的字面若已從檔案消失，Phase 2 的 PR 必須同步刪掉這裡的條目
 *   （留著只會讓未來的同型回歸在該檔靜默通過）。
 */
export interface ConventionExemption {
  /** 為什麼這個檔案暫時不受該條規則約束；必須寫到「哪個 Phase 收斂」。 */
  reason: string;
  /** 暫時放行的淘汰字面（以 RegExp 比對 `OBSOLETE_LITERALS` 的 source）。 */
  literals?: RegExp[];
  /** 暫時放行「觸碰時段輸入框但未 import row helper」。 */
  rowHelper?: boolean;
}

const DATA_CATEGORY_SELECT = /data-category-select/;
const SCHEDULE_TABLE_NON_CARE = /schedule-table-non-care/;

export const VISIBILITY_EXEMPTIONS: Record<string, ConventionExemption> = {
  'd2b-class-category-empty-db.spec.ts': {
    reason:
      '族 B（Issue #188 Phase 2）：仍以 data-category-select 操作類別；Phase 2 改為 YesNoRadioGroup 後刪除本條。',
    literals: [DATA_CATEGORY_SELECT],
  },
  'round3-preview-category-deltas.spec.ts': {
    reason:
      '族 B（Issue #188 Phase 2）：類別變更路徑尚待裁決（Excel 匯出入）；Phase 2 落地後刪除本條。',
    literals: [DATA_CATEGORY_SELECT],
  },
  'schedule-excel-io.spec.ts': {
    reason:
      '族 B（Issue #188 Phase 2）：匯出前後仍以 data-category-select／non-care 總表計數；Phase 2 改為逐頁籤後刪除本條。',
    literals: [DATA_CATEGORY_SELECT, SCHEDULE_TABLE_NON_CARE],
  },
  'schedule-grid-workflow.spec.ts': {
    reason:
      '族 B（Issue #188 Phase 2）：仍斷言舊的「含時段」摘要並直接取第一個 input-time；Phase 2 改用 helper 與頁籤統計後刪除本條。',
    rowHelper: true,
  },
};

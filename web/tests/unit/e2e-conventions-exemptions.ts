/**
 * `e2e-conventions.test.ts` 的例外清單（Issue #188 Phase 1）。
 *
 * 為什麼需要這份清單：Issue #188 Phase 1 只修 A 族（導覽／列定位），族 B（淘汰選取器）
 * 與族 D（空白星期契約）在 Phase 1 合併時尚未收斂。守門測試在 Phase 1 就必須是綠的
 * （CI 跑 `npm test`），否則它會擋住自己的 PR；但把例外寫成「整個檔跳過」會讓後續 Phase
 * 修完後沒人回來拿掉例外。
 *
 * Phase 2 已移除族 B 的 4 筆（`d2b-class-category-empty-db`、`round3-preview-category-deltas`、
 * `schedule-excel-io`、`schedule-grid-workflow`）。剩下的唯一一筆是新班尚未進 seed 的情形，
 * 不屬族 B。
 *
 * 因此每一筆例外只放行**一種具體事實**（`literals`：特定淘汰字面；`managedInputWithoutHelper`：
 * 仍直接觸碰時段／星期輸入框而不用 row helper），以及一個收斂動作。
 *
 * 守門測試的雙向要求（缺一即紅）：
 * - 例外指向的檔案必須存在，理由長度 > 10（不能留空話）；
 * - `literals` 若已從檔案消失 → 例外失效，必須刪條目；
 * - `managedInputWithoutHelper` 必須同時成立「(a) 未 import 任何 row helper」與
 *   「(b) 仍觸碰 `input.input-time`／`input.input-weekday`」；少了任一半，例外就已無必要。
 */
export interface ConventionExemption {
  /** 為什麼這個檔案暫時不受該條規則約束；必須寫到「哪個 Phase 收斂」。 */
  reason: string;
  /** 暫時放行的淘汰字面（以 RegExp 比對 `OBSOLETE_LITERALS` 的 source）。 */
  literals?: RegExp[];
  /** 暫時放行「直接觸碰受管輸入框、未 import row helper」。 */
  managedInputWithoutHelper?: boolean;
}

export const VISIBILITY_EXEMPTIONS: Record<string, ConventionExemption> = {
  'schedule-add-placeholder-row.spec.ts': {
    reason:
      '新班在儲存前不存在於 seed／?class= 深連結，classRow 定位不到；本檔自建 rowOf 查該列。Phase 2 若 helper 支援「剛新增的列」再收斂。',
    managedInputWithoutHelper: true,
  },
};

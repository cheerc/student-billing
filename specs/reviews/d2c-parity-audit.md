# D2c Parity 與規格稽核

## 範圍、來源與證據邊界

- Execution：`t-20260930232311681331-75458-7`；D2 parent：`t-20260930113931636950-84237-110`。
- 來源：06 D37／D40、02 §9、03 §5.2–§5.4、04 UX48–UX70、09、11 §3；S manifest §5–§8 的差異表與獨立手算案例。Q1–Q14 以 D40 定稿為準，不重新採用 S 的未採選項。
- 比較固定同一 import、設定快照、alias、時段與數值政策，唯一變動為 v2／v3 規則版本。只用 repo 合成 fixture 與虛構學生，不讀 `data/`。
- 量測源 HEAD：`58c312b8748397a82ecefa6827f298d5b1211bd0`；最終 PR HEAD 的驗證 SHA、commands、exit 與 raw locator 由交付報告列出，不將舊 raw 冒充最終 evidence。
- 不比較：runId、建立時間、ruleSetVersion、trace 規則識別與 issue 訊息文字。`careDays.tutoring.isEnrolled` 依 D40 Q3／S D-04 **不納一般 parity 比較，但另列差異**。
- `web/tests/unit/d2c-parity-gate.test.ts` 為手算 policy suite，不宣稱目前已具完整逐情境／逐欄表外差異閘門。其鑑別力不足已依 decision `d-20261001030238623979-12` 交 D2d `t-20261001030245156576-75458-17` 收斂。

## Fixture 分母與完整實測

`web/scripts/parity-d2b.mts` 已獨立重跑；同一匿名 fixture 為 **477 總列數／384 有報名**。一般業務欄位差異以 477 列為分母，不把無報名的 93 人移出後仍稱全量。

|欄位|v3 相對 v2 的差異人數|差異表歸屬與判定|
|---|---:|---|
|安親、課輔 days|各 0|相同|
|subjectCount、baseDiscountBps|各 0|fixture 無 D-02 情境|
|applicableRates.anqin／tutoring／math／english|各 0|已讀真實 nested 欄位重新驗證|
|tierMismatch、tier status 集合|各 0|相同|
|computedTier／status／needsReview 組合|0|獨立補充量測相同|
|issue code 集合|42|只新增 CLASS_NOT_MAPPED，D-05 允許；沒有表外新增 code|
|careDays.tutoring.isEnrolled（另列）|19|D-04：true→false；不改天數、固定 5 天適用率|

**D2b 四率證據更正**：原 baseline 腳本讀 `result.applicable*Bps`，實值在 `result.applicableRates.*`。四個 nonexistent 欄位的 undefined＝undefined 比較，不能證明零差異；D2b 交付的四率「0 人差異」當時並無效力。D2c 已修正 repo 腳本，以真實兩科案例手算四率＝9500 bps 建立 RED（undefined 而失敗）→GREEN，再獨立重跑取得真正的各 0 人。這是證據工具修正，未調整任何產品規則。

## D-02 的 19／11／8 口徑

|集合|定義|人數|
|---|---|---:|
|H|至少一班名含「寫功課」|19|
|H∩C|H 中另報 care／math／english 任一折扣類（寫功課不當 care）|11|
|H−C|H 中沒有這三種折扣類；可以另有交通車等不列入班|8|
|H∩一般輔導|有一般 care 且有寫功課（真正 D-02 情境）|0|

實測拆分：3 人另報數學＋美語、8 人另報美語、8 人無數學／美語；19 人皆無一般輔導。故 **19＝11＋8**，不是兩份 fixture，也不是漏算 8 人。兩種口徑的 D-02 人數均為 0；必須以合成案例補足 D-02 的實際差異。

D-04 年級分布獨立重測為四年級 5、五年級 11、六年級 3，合計 19，與 S manifest 相同。這裡的「五年級 11」與「有其他折扣類 11」是不同集合，不能因數字相同混用。

## D-01／D-02 手算 vs 實測

窗口：安親 780–960、課輔 990–1170，每日 180 分。D24 同班先加總再取整：小數 <0.3→0、[0.3,0.8)→0.5、≥0.8→1；課輔重疊≥120 且 1110<下課<1170 的特例扣 1。手算 expected 源自 S §6.2，不由新程式輸出回填。

|情境／欄位|獨立手算 v2→v3|實測 v2→v3|條目／判定|
|---|---|---|---|
|D-01a，四年級：甲週一990–1080、乙週二990–1140；課輔 days|甲扣0.5、乙特例扣1；max(3,5−0.5)=4.5→max(3,5−1)=4|4.5→4|D-01，允許|
|D-01a computedTier（兩 token）|4.5→4|各4.5→4|D-01 天數衍生，允許；status 仍 not_applicable|
|D-01c，二年級：X1020–1080、Y810–870；安親 days|X安親扣0、Y60/180取0.5；5→4.5|5→4.5|D-01，允許|
|D-01a／c 科數、基本率、四種適用率|1、10000、各10000，兩版相同|相同|非允許差異欄位仍驗相同|
|D-02：一般輔導＋寫功課＋數學；subjectCount|v2 care+math−寫功課=1；v3 {care,math}=2|1→2|D-02，允許|
|D-02 baseDiscountBps|1科10000→2科9500|10000→9500|D-02，允許|
|D-02 math／english 適用率|基本率10000→9500|各10000→9500|D-02 衍生，允許|
|D-02 care days 與兩側適用率|寫功課固定5天；5、10000→不變|5、10000→不變|固定旗標不被科數差異改變|
|D-02 加兄弟姊妹；基本率、math／english|effectiveCount 1+1=2→2+1=3；9500→9000|各9500→9000|D-02，允許|
|D-02b 一般輔導＋寫功課＋兄弟姊妹；科數／基本率|v2 1−1=0、0+1→10000；v3 1、1+1→9500|0→1、10000→9500|D-02，允許|
|以上虛構未對應班的 issue codes|v3 可新增 CLASS_NOT_MAPPED；既有重複報名提示保留|只新增 CLASS_NOT_MAPPED|D-05，允許；不是 D-01／D-02 全生免驗|

上述數值欄位與 issues 的實測差異皆能對應差異表；**本次量測的表外差異清單為空**。不把這項量測結論提升為目前測試閘門已完整覆蓋所有可能情境。

## 不變式與已執行測試

- D24／D30、標籤來源、v2／compat 不變式由既有 D2a／D1 suite 與本次 policy suite 共同驗證；同一 input 的 v2／v3 結果一致不單獨當作算法正確性證明。
- `d1-invariance-golden.json` SHA256 維持 `d5198edf381434ab1df0da8f0f13dfe3e0ffb2ee6ab0f4bd3627523f8c06bc56`。
- 真實快照鏈：`d2a-run-class-categories-persistence.test.ts`、`d2c-snapshot-write-point.test.ts`；execute 產出、save 唯一寫入新 run，歷史 run 不就地補寫。
- 恢復自動：`d2c-restore-auto.spec.ts` 驗類別、固定 5 天、改名後恢復的存檔與 reload；`d2c-restore-auto-persistence.test.ts` 驗缺 manual 欄位的新設定與舊設定不可變。
- 本次稽核的 UX60 舊 v3 類別快照後續改設定專項、完整 upgrade UI 旅程及 selection 鑑別力仍待 D2d；不把既有 generic persistence tests 當它們的完整代替。

## 規格一致性稽核與已知缺口

D2c 純文件修正：03 §5.2.3 區分 sparse 設定快照與完整 run 類別快照；§5.3.4 更正 execute→save 寫入責任；09 §8.1／§8.2.1 的無 active 預設改為 D2 的 v3；04 將部分覆蓋與待補如實列出。Sparse settings 與 S 的「設定四欄完整」建議有差別，依當前 §5.4.1 與 Lead decision d-20261001030238623979-12 收斂；不回寫舊 JSON，不改 hash。

以下產品／覆蓋缺口依同一 decision 歸 D2d（`t-20261001030245156576-75458-17`），**不在 D2c 偷修，也不以文件改寫消除要求**：

|項目|分類、source evidence 與驗證方式|對應契約|
|---|---|---|
|A 升級 before 版本|已確認 source 缺口：`settings-preview.ts:181,207–217` before／after 都用 target；D2d 以同草稿、v2→v3 且有D-01/D-02差異的RED重現|S §2.3、11 D2、UX61|
|B 共用選中班|已確認 source 缺口：`calculate-run.ts:218–230` 及 `roster-changes.ts:159–165,185–186` 仍首班鏡像；D2d 用首班與選中班不同、seed場次不同的案例驗摘要／異動明細／trace|D40 Q10-A、S §4.2／§7.5|
|C 併入既有班|source 明確豁免：`class-attributes.ts:169–182`，target 已在 baseline 時 skip；D2d 以 X→既有Y、不同有效屬性的RED確認，不宣稱本次已runtime驗完|D40 Q9、UX50／56|
|空課表候選警告|runtime確認：數學首班空、次班可算→4天、僅重複提示、兩tier needsReview=false；美語全部空→5天、issues=[]、needsReview=false。`billing-calculator.ts:218–225,291–298` 只對 not_found 加問題；D2d 收斂 empty 警告|02 §9 可計算性／保留問題、S §7.5|
|Policy gate 鑑別力|確認覆蓋不足：`d2c-parity-gate.test.ts:368–399` none 班的白名單可能空集合通過，「逐欄」只驗部分欄位；同標籤／備註及只同星期跨版相同比較也不證明來源／D30正確。D2d 補完整檢查器與衝突值、週六手算|11 parity gate、D24／D30|
|UX54／55／60／61|helper integration、generic snapshot 不代替完整UI儲存/reload、舊v3分類專項及升級旅程；04已標部分／待補|04對應列|
|UX67–69|主要測試實為unit；平手同天數無法區分token，非法「八」不涵蓋空白／全缺／全空；04已修測試層與待補狀態|04對應列、Q5／Q6|

影響預覽 union 去重不是本次缺口：`settings-preview.ts:279–283` 使用 personCode Set，已有重疊／科數折扣變化測試；A 是版本選擇錯誤，不是聯集算法相加。

## 原有 12 行 probe 刪除說明

`web/tests/e2e/d2b-class-category.spec.ts` 相對 `5bc0422` 刪除原 287–298 行：287 為 D2C_PROBE guard；288 計數器；289 calculate request listener；290 固定8輪loop；291 console.log開頭；292 時間與disabled字串；293 isDisabled讀值；294 request數字串；295 log結尾；296 固定waitForTimeout(500)；297 loop結尾；298 guard結尾。這12行全為暫時diagnostic／固定等待，**沒有任何 expect／授權斷言被刪除或搬走**；前後 dirty、Q13 notice與可儲存斷言保留。清理不以此probe作通過條件。

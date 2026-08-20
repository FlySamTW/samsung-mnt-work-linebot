# LINE Bot 修正防復發台帳

這是商化 LINE Bot 的不可回退規則。自 2026-07-21 起，`Main.js`、`MerchAlert.gs`、`Reminder.js`、`Sales.js` 或 `appsscript.json` 有任何修正時，必須同一批更新本檔；`node verify_merch_alert_gateway.mjs` 會檢查工作樹與最後一次台帳更新後的 Git 變更。

## LB-RG-001 — 一般聊天不得觸發商化摘要

- 日期：2026-07-21
- 症狀：若群組任何發話都回覆，四人同時聊天會造成洗版與無謂處理。
- 根因：把一般訊息與明確查詢指令混在同一路由。
- 永久規則：只有指定商化群組輸入精確 `/商化` 才回覆摘要，不需 @；一般聊天一律忽略。
- 自動守門：`verify_merch_alert_gateway.mjs` 的狀態快照、指定群組與 `/商化` 回覆測試。
- 首次納入：LINE Bot `@50`，並持續保留於 `@51`。

## LB-RG-002 — 主動推播只保留事故生命週期

- 日期：2026-07-21
- 症狀：四人群的進度、照片問題與公告 Push 會快速消耗月額。
- 根因：一般狀態與真正服務事故共用 Push 入口。
- 永久規則：只允許 `system_down`、`system_recovered` 與人工 `integration_test`；其他類別只同步快照或回覆查詢。每月預設硬上限 40 收件人次，群組人數不明時保守按 10 人估算。
- 自動守門：`verify_merch_alert_gateway.mjs` 的類別封鎖、四人群成本與 proactive cap 測試。
- 首次納入：LINE Bot `@51`。

## LB-RG-003 — Push 成功後不得因附帶紀錄失敗而重送

- 日期：2026-07-21
- 症狀：LINE 已收到通知，但 ALL 工作表寫入失敗時，重跑可能重複通知。
- 根因：沒有把「LINE 已送達」與「附帶紀錄成功」拆成兩個結果。
- 永久規則：事件 ID 與 retry key 必須穩定；Push 成功即視為已送達，ALL 寫入失敗只記錯誤，不得再次 Push 同一事件。
- 自動守門：`verify_merch_alert_gateway.mjs` 的 duplicate、retry-key 與 ALL 寫入失敗測試。
- 首次納入：LINE Bot `@51`。

## LB-RG-004 — 既有 LINE 下班不得擅自改用到點差額

- 日期：2026-08-20
- 症狀：`@52` 將下班總台數強制與到點初始台數相減，造成現場正常輸入「到點 14／下班 12／Samsung 2」與「到點 1／下班 2／Samsung 2」被誤擋。
- 根因：把新報表／Excel 設計的差額口徑擅自套用到仍在營運的既有 LINE 輸入，但正式歷史紀錄明確顯示到點值與下班值不是可強制單調遞增的累計對。
- 永久規則：既有 LINE 流程仍只檢查當日同人同店有到點紀錄；占比固定為 `Samsung 台數 ÷ 下班總台數`；只有 Samsung 台數大於下班總台數才阻擋。新網頁、Excel 或其他分析口徑不得反向改動正在使用的 LINE 契約。
- 自動守門：`node verify_sales_shift.mjs` 直接驗證上述兩組正式現場數字、到點存在、零銷量、Samsung 超過下班總台數、整數格式與固定 9 欄寫入。
- 首次納入：LINE Bot 固定 deployment `@52` 曾錯誤套用差額；修復仍沿用原 webhook deployment ID，不更換網址。

## LB-RG-005 — 新舊銷售勤務必須受控雙寫且可安全切換

- 日期：2026-08-21
- 症狀：新銷售網頁與新 Sheet 已建立，但 LINE 到點／下班仍只寫既有 `銷售群組`，造成新制 Excel 缺少勤務與總台數來源。
- 根因：原規劃只讓新版 Excel 另讀既有 LINE 工作簿，未依實際營運要求把 LINE 勤務同步保存到新制工作簿。
- 永久規則：`SALES_DUTY_WRITE_MODE=DUAL` 時，同一 LINE `訊息ID` 必須冪等寫入既有 `銷售群組` 與新制 `LINE勤務`；新表暫時失敗不得阻斷舊表及現場回覆，切換前必須執行完整補寫並確認缺漏為 0。只有管理者明確切換成 `NEW_ONLY` 後，才停止寫舊表；到點重複檢查及下班到點檢查亦須同步改讀新表。
- 自動守門：`node verify_sales_shift.mjs` 驗證雙寫、訊息 ID 去重、新表故障不影響舊表、`NEW_ONLY` 只寫／只讀新表、切換前同步守門、Apps Script 編輯器用的無參數雙寫管理入口，以及依唯一訊息 ID 寫入、讀回、精準清理的正式煙霧測試。
- 首次納入：LINE Bot 下一正式版本，沿用原 webhook deployment ID，不更換網址。

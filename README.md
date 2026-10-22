# MNT 商化 LINEBOT

本專案保留既有 LINE webhook 回覆功能，並提供 MNT 商化系統使用的主動通知入口。主動通知只接受簽章正確的 GAS 請求，固定推送至商化管理群組，不開放呼叫端指定收件人。

目前正式固定 deployment 為 `@60`（2026-10-22，活動支援）。管理群組自行輸入 `/商化`（不需 @ 機器人）時，只回覆適合手機閱讀的進度摘要，不附管理頁與前線頁連結；一般聊天不會觸發商化回覆。

## 主動通知設定

在 Apps Script 的「專案設定／指令碼屬性」設定：

- `TOKEN`：既有 LINE Messaging API token。
- `MNT_ALERT_GROUP_ID`：商化管理群組 ID。
- `MNT_ALERT_SECRET`：至少 32 字元的共用密鑰，需與商化回報 GAS 相同。
- `MNT_ALERT_MONTHLY_LIMIT`：商化通知每月可用訊息數，現行設定為 `200`。
- `MNT_ALERT_RESERVED_QUOTA`：保留給服務中斷與恢復通知的 LINE 總額度，預設 `40`。
- `MNT_ALERT_PROACTIVE_MONTHLY_CAP`：商化系統每月最多可主動通知的「收件人次」，預設 `40`。4 人群組最多合計 10 次主動推播，且只供中斷、恢復與人工測試使用。

LINE 依實際收件人數計算訊息量；4 人群組推送一次會消耗 4 則。程式會先查詢官方用量與群組人數，再檢查商化系統自己的月額硬上限；若群組人數查詢失敗，會保守按 10 人估算，不會低估額度。

## 通知範圍

- 非部署短暫切換造成的前線服務中斷，以及服務恢復。
- 主管手動執行的連線測試。

進度、現場缺失、照片問題、改版公告與一般服務提醒全部改為「查詢時回覆」，不再主動推播。接收閘道也會再次封鎖這些類別，即使上游日後誤送也不會呼叫 LINE PUSH。

同一事件會以事件 ID 去重，LINE 重試鍵也使用同一事件 ID 產生，避免網路重送造成重複通知。

所有通知程式修正都必須同步 `REGRESSION_GUARDS.md`。台帳固定記錄症狀、根因、永久規則、對應測試與首次納入版本；`verify_merch_alert_gateway.mjs` 會檢查工作樹及最後一次台帳更新後的 Git 變更，避免日後修改又放回一般 Push、任意聊天回覆或重複通知。

LINE PUSH 成功後，主動通知會寫入既有的 `ALL` 工作表；若 PUSH 失敗，仍會記錄到 `LOG` 供追查。`ALL` 寫入失敗只記錄錯誤，不會因此重送 LINE PUSH。

商化回報系統每 5 分鐘以簽章快照同步進度、待處理數與服務狀態。快照只更新 LINEBOT 狀態，不會發送訊息，也不耗 PUSH 額度。管理群組輸入 `/商化` 時，LINEBOT 以免費回覆訊息顯示月份、服務狀態、回報進度、待回報店數、待處理分類與更新時間；回覆不附任何網址，快照超過 15 分鐘未更新會警示。此指令只接受 `MNT_ALERT_GROUP_ID` 指定的群組，指令與回覆仍會寫入 `ALL`。

## 驗證

執行 `node verify_merch_alert_gateway.mjs`。此測試不連線 LINE、不耗用額度，會檢查簽章、固定群組、去重、主動通知月額硬上限、一般類別封鎖、狀態快照、`/商化` 回覆、中斷／恢復放行，以及通知程式變更是否同步防復發台帳。

銷售群組的到點／下班數字規則另執行 `node verify_sales_shift.mjs`，會驗證既有 LINE 下班占比、到點存在、零銷量、Samsung 超過下班總台數、一般店固定 9 欄寫入，以及活動支援的人員資格、台北日期、跨活動隔離、全場累計快照與雙寫尾欄；同樣只在本機執行，不會寫入 Google Sheet 或發送 LINE 訊息。

## 銷售勤務新舊雙寫

- 新制工作簿：<https://docs.google.com/spreadsheets/d/1dNJxwn8HaY6dnGh7pogsoscg6Oo3nVfW8wxpLNGv2Q4/edit>
- 新制分頁：`LINE勤務`，固定沿用既有 `銷售群組` 的 A:I 九欄契約；活動支援另附 J:K，不移動或改寫原九欄。
- 未設定 `SALES_DUTY_WRITE_MODE` 時預設為 `DUAL`：舊表先寫入，新表以相同 LINE `訊息ID` 冪等寫入；新表暫時失敗只記錄錯誤，不中斷既有現場流程。
- 管理者明確要求正式切換後，在 Apps Script 編輯器執行 `enableSalesDutyNewOnly()`（CLI 亦可執行 `setSalesDutyWriteMode('NEW_ONLY')`）；程式會先補齊 2026/8/1 起資料並確認缺漏為 0，才停止寫入舊表。並行期要明確重設時執行 `enableSalesDutyDualWrite()`。
- 需要人工補寫或稽核時執行 `syncSalesDutyHistoryToNew()`，回傳 `sourceRows`、`insertedRows`、`missingAfter`。
- 正式部署後可執行 `smokeTestSalesDutyDualWrite()`；它會以 `codex-duty-smoke-*` 唯一訊息 ID 寫入新舊兩表、讀回，再依 ID 精準刪除並確認兩表皆無殘留，不會向 LINE 群組發訊息。

## 活動支援

LINE 沿用銷售群組的文字指令，固定店點名稱為「活動支援」。沒有另外建立 LINE 按鈕選單，也不將每場活動加入原店點白名單。當日只有一場啟用活動時，自動帶入該場活動：

```text
到點/活動支援/0
下班/活動支援/12/2
```

若同日有多場活動，機器人回覆各場可複製的完整格式，須選定其中一場後再回報；例如：

```text
到點/活動支援/TWTC_APPLIANCE_20261106/0
下班/活動支援/TWTC_APPLIANCE_20261106/12/2
```

人員各自上下班打卡；下班的「總台數／三星台數」填該活動當日截至回報時的**全場累計快照**，包含同場所有人員。若同時下班，填同一份現場總數；個人的來客、成交另在銷售網頁填報。到點初始台數仍保存為紀錄，不相減、不要求下班總台數大於到點數；三星台數不可大於下班總台數。原一般店點的既有規則不變。

### 設定與歸屬

- 活動來源是原 LINE 工作簿的「活動支援設定」，標題依序為 `activity_id,name,start_date,end_date,latitude,longitude,radius_m,active`。LINE 依訊息發生時的台北日期篩選啟用活動；活動結束或停用後不再接受該活動的新打卡，既有歷史紀錄保留。
- 未來活動只需新增設定資料，不必新增店點或修改指令程式。活動 ID 應唯一且保持不變；日期為 `YYYY-MM-DD`，`active` 明確設為 `TRUE` 才啟用。
- 活動支援限「群組&姓名對應」D 欄已綁定 LINE ID、H 欄銷售人員 ID 非空、I 欄明確啟用的正式人員；以 K 正式姓名（無值時 E）保存。測試／temporary 帳號不開放。程式不修改 D:M 的任何設定，也不替人員更改原店歸屬。
- 新活動勤務在舊「銷售群組」與新「LINE勤務」的 J:K 分別保存 `activity_id`、`activity_name_snapshot`。新舊雙寫、補齊與 `NEW_ONLY` 均保留活動欄位。A:I 舊九欄及一般店點列不變；如果 J:K 已有其他資料，拒絕覆寫。
- 到點重複檢查與下班配對以「台北日期＋本人＋活動 ID」判斷；他人的到點、別場活動或前一天的到點不能代替。設定名稱改變也不回寫歷史快照。

## 2026-10-22 活動支援發布紀錄

- 同一固定 webhook deployment 由 @58 更新至 @60；runtime commit c9e1538075afe48300ed75a1b831207c3f633e6e。Main、Reminder、MerchAlert 與 manifest 與 @58 完整比對相同，只有 Sales 新功能。
- @60 五個雲端檔案與固定 Git 候選雜湊讀回相同，部署列表已讀回 @60；LINE 舊勤務與通知防復發守門通過。本次沒有發送群組訊息。
- Apps Script execution API 未允許 CLI 執行 smoke；未把該呼叫列為通過，也沒有為此擴增權限。銷售 LINE 處理以本機真實 handler 測試與雲端來源/版本讀回驗證，實際人員訊息仍由現場正常使用。
- 證據：.codex-tmp/activity-support-20261022/deployment-proof.json、version60-proof.json。@59 是首次未上傳變更的舊來源快照，未部署；不可作為本次來源版本。

# 目前專案狀態

更新：2026-10-22（Asia/Taipei）。本檔為 LINE 獨立 repo 的唯一目前狀態快照。

## 本輪範圍

- Sam 明確要求修正銷售群組報到漏回，沿用原固定 webhook 發布。
- 實際群組已看：致昇 16:31、16:36 照片後接到點；16:36 複製原文為 `到點/台中良興/5台`，斜線 U+002F。
- 雄偉 `到點/高雄順發/3台`16:43:24，群組16:44回成功，ALL及新LINE勤務同訊息ID讀回。
- 致昇文字格式正確，當日兩筆未進 ALL／LOG／新勤務。原始略過 payload 未保留，不能逐筆確證同批事件是當時唯一原因。

## 目前正式

- 固定 webhook 已由 @60 更新 @61，runtime候選 `821c2de9395782b631a588b5d1b6e0b6b15223b9`；2026-10-22 17:22:20正式讀回完成。
- 新工作簿 LINE勤務 已連通。LINE Developers 實際 URL 直接指本 GAS 固定 deployment，不經 Zeabur。
- 五個雲端來源hash與固定候選一致；只有Main產品程式變更，Reminder／Sales／MerchAlert／manifest保持原來源。原URL、ANYONE_ANONYMOUS與USER_DEPLOYING均相同。

## 已上線修正

- Main 對整批事件逐筆處理：照片／非文字只略過該筆，後面的文字及其他人員繼續處理。
- 已保存的訊息依 ALL 訊息 ID 略過；首筆重複不再直接結束整批。未曾收過的重送可處理一次。
- 單筆例外不擋後面人員。原店點白名單、人員設定、活動支援、上下班配對與雙寫規則不變。
- 取消白名單逐列 LOG insert/flush，降低回覆前耗時。Cloud Logging 留最小批次事件資訊，不留 reply／quote／read token。
- `messageEdited` 仍不改寫勤務；本輪不自動回放舊訊息、不偽造致昇已遺失的 event/message ID，也不補造勤務。

## 驗證

- `node verify_webhook_batch.mjs`：照片/文字交錯兩人均寫入隔離新舊表並產生個別回覆；重送無新增；首筆重複／格式缺欄／單筆失敗均不擋後面文字。
- 同日同人另送新訊息 ID 仍受原重複到點判斷。普通聊天不回覆、簽章商化閘道仍走原入口。
- `node verify_sales_shift.mjs` 與 `node verify_merch_alert_gateway.mjs` 通過；無真 LINE 發送或正式勤務寫入。
- 新測試首次因隔離 Sheet 缺格式鏈方法失敗，補齊測試替身後通過；未因此修改產品寫入規則。

## 發布與接手

- 固定候選 freeze 後，只上傳五個既有 Apps Script 原檔；測試及 `.codex-tmp` 不得上傳。
- 發布前比對 @60 及雲端 HEAD 均等於原基線，防止蓋掉別人的雲端修改。
- 已讀回固定版號61／來源五檔hash／原URL與access；空events公開POST回HTTP200，HtmlService userHtml為OK，沒有業務寫入或LINE發送。
- 更新API回61後第一次GET短暫仍回60，守門停止；後續只做唯讀重查確認61，沒有重複上傳／建立版本／部署。第一次探測誤要求純文字OK，修正本機驗證器以讀取既有HtmlService包裝的userHtml後通過，產品未因此重改。
- 不主動向銷售群組發測試訊息。正式現場的新報到回覆尚待自然事件確認，不把空事件探測當真打卡驗收。
- 回復方式：同一固定 deployment 改回 @60；不換 webhook、不重設金鑰或工作簿。
- 證據 `.codex-tmp/webhook-batch-20261022/{candidate.json,created-version.json,deployment-proof.json,readback-observations.json,verify_*.log}`；先前調查位於商化repo `.codex-tmp/line-zhisheng-20261022/`。
- 程式修正與正式發布完成；現場自然新訊息尚無本輪送達收據。未重送／補造致昇16:31或16:36舊勤務，舊缺漏仍需可稽核的個別補正，不得假稱已回補。
- 本repo由codex-line-batch-fix-20261022單一寫入並於收尾釋放。商化repo另項Node security工作持鎖，本輪不覆蓋其產品／狀態檔；本檔為LINE最新正式狀態，商化repo先前「未修改正式」段落是修正前調查狀態。

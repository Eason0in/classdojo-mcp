# ClassDojo Roster MCP（繁體中文）

這是一個**非官方、local-first 的 ClassDojo 名單 MCP Server**。老師可讓 Claude Desktop、Codex、Cursor、VS Code 或其他支援 MCP stdio 的 AI Agent，檢查 Excel/XLSX 學生名單、預覽差異、匯入 ClassDojo，並於儲存後重新讀回檢核人數與姓名。

> 本專案與 ClassDojo 無隸屬、背書或合作關係。ClassDojo 尚未正式提供公開 API／MCP，因此目前版本使用教師自行登入的本機瀏覽器工作階段；ClassDojo 網頁改版可能需要更新 adapter。

## 主要安全設計

- 不要求交付 ClassDojo 密碼、Cookie 或 API Token。
- XLSX 與瀏覽器操作都在使用者電腦執行，不提供集中式雲端服務。
- 每次寫入都必須先取得 15 分鐘有效的 `previewId`，再明確傳入 `confirm: true`；第一次套用即失效。
- 儲存後會讀回 ClassDojo 名單，比對人數、姓名、缺少與多出的學生。
- V0.1.0 只開放學生名單寫入；點數、出缺勤、訊息、家庭邀請等功能不開放。
- 公開 issue、PR 或 snapshot 禁止放入真實學生姓名、活頁簿、Cookie 或瀏覽器設定檔。

## 工具

| 工具 | 寫入 | 功能 |
| --- | --- | --- |
| `classdojo_doctor` | 否 | 檢查本機瀏覽器連線、登入狀態與可見班級。 |
| `classdojo_list_classes` | 否 | 列出教師頁面可見的三位數班級。 |
| `classdojo_inspect_workbook` | 否 | 掃描整份活頁簿，找出班級、座號、姓名欄位候選區塊。 |
| `classdojo_get_roster` | 否 | 讀取單班目前名單。 |
| `classdojo_get_ui_state` | 否 | 偵測家庭邀請、歡迎訊息等阻擋視窗，不會自行關閉。 |
| `classdojo_preview_roster_import` | 否 | 產生匯入差異與短效 `previewId`。 |
| `classdojo_apply_roster_import` | 是 | 以 `confirm: true` 套用預覽，儲存並讀回驗證。 |
| `classdojo_verify_roster_against_workbook` | 否 | 將目前名單與 XLSX 再次精確比對。 |

## 為什麼座號需要明確選擇

ClassDojo 的整批貼上可能把開頭數字視為清單編號，而不是學生姓名的一部分。因此匯入時一定要選擇：

- `seat_number_dot_name`：逐位建立 `1.姓名`，保留座號。
- `name_only`：只放姓名，才使用較快的整批貼上；若同班有同名學生會拒絕匯入，必須改用座號格式。

## 使用流程

1. 以獨立 Chrome 設定檔啟動本機 CDP，並在該視窗自行登入 ClassDojo。
2. 在 MCP Client 安裝本 server。
3. 呼叫 `classdojo_doctor`。
4. 呼叫 `classdojo_inspect_workbook`，檢查所有工作表與候選欄位。
5. 呼叫 `classdojo_preview_roster_import`，明確指定至少一個工作表、班級對應與姓名格式；不可省略 `sheetNames`，避免把重複或無關工作表混在一起。
6. 人工確認班級、人數、缺號與新增名單。
7. 確認後才呼叫 `classdojo_apply_roster_import`，傳入相同 `previewId` 與 `confirm: true`。
8. 最後呼叫 `classdojo_verify_roster_against_workbook` 再次檢核。

若部分班級失敗，結果會分開列出已驗證班級與可安全重試班級；重試前必須重新產生預覽，避免把舊狀態重播到已變動的名單。

完整安裝指令、跨 Client 設定、範例 snapshot、除錯與發版資訊請見專案根目錄的 [README.md](../README.md)。

## 隱私提醒

學生姓名可能經過你選擇的 MCP Client／AI 服務商。使用真實名單前，請確認學校規範、最小權限、資料保留政策與相關兒少個資要求。更多資訊請見 [PRIVACY.md](PRIVACY.md) 與 [THREAT-MODEL.md](THREAT-MODEL.md)。

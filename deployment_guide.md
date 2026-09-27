# 🚀 AI 資訊查核助手：詳細部署指南

本指南針對 **LINE Developers** 與 **Google AI Studio** 的設定細節進行深入說明，確保您的機器人能順利運行於群組中。

---

## 1. LINE Developers 設定指南

### 🔹 建立 Messaging API Channel
1. 登入 [LINE Developers Console](https://developers.line.biz/)。
2. 建立一個 **Provider** (服務提供者)，名稱可自訂（如：MyTools）。
3. 點選 **Create a new channel**，選擇 **Messaging API**。
4. 填寫必要資訊：
   - **Channel name**：機器人名稱（如：AI 資訊查核助手）。
   - **Channel description**：機器人描述。
   - **Category**：隨選即可。

### 🔹 取得 Channel Access Token
1. 進入剛建立的 Channel。
2. 切換到 **Messaging API** 頁籤。
3. 捲動到最下方 **Channel access token** 區塊。
4. 點選 **Issue** 按鈕，複製產出的長字串。這就是 `LINE_ACCESS_TOKEN`。

### 🔹 重要功能設定 (必做！)
為了確保機器人在群組中運作正常且不干擾使用者，請務必檢查以下設定：

| 設定項目 | 位置 | 設定值 | 說明 |
| :--- | :--- | :--- | :--- |
| **Webhook URL** | Messaging API 頁籤 | 貼入 GAS Web App URL | 必須以 `https://` 開頭，貼上後點選 **Verify** 驗證。 |
| **Use webhook** | Messaging API 頁籤 | **開啟 (ON)** | 若未開啟，機器人將收不到任何訊息。 |
| **Allow bot to join groups** | Messaging API 頁籤 | **Enabled** | **非常重要**：若未開啟，機器人將無法被拉入群組。 |
| **Auto-response messages** | Messaging API 頁籤 > LINE Official Account features | **編輯 ➔ 停用** | **強烈建議**：關閉 LINE 預設的自動回覆，避免機器人對每則訊息都回覆「感謝您的訊息」。 |
| **Greeting messages** | Messaging API 頁籤 > LINE Official Account features | **編輯 ➔ 停用** | 關閉加入好友時的歡迎訊息。 |

---

## 2. Google AI Studio 設定指南

### 🔹 取得 Gemini API Key
1. 前往 [Google AI Studio (aistudio.google.com)](https://aistudio.google.com/)。
2. 點選左側選單的 **Get API key**。
3. 點選 **Create API key in new project**。
4. 複製產出的金鑰字串。這就是 `GEMINI_API_KEY`。

### 🔹 提升穩定性：信用卡綁定 (建議)
雖然 Gemini 提供 **Free Tier (免費版)**，但其每分鐘請求次數 (RPM) 較低且在高負載時容易出錯。
1. 在 AI Studio 中點選左下角的 **Settings** (齒輪)。
2. 找到 **Billing** 區塊並點選 **Set up billing**。
3. 綁定信用卡後，您會進入 **Pay-as-you-go** 模式。
4. **為什麼要綁定？**
   - **高優先權**：在高負載時，付費專案的穩定度遠高於免費版。
   - **聯網功能**：若您想開啟 `ENABLE_GROUNDING = true`，付費模式能提供更穩定的搜尋體驗。
   - **費用極低**：若僅用於個人/小群組，Gemini 的 Token 費用通常不到 $1 USD，甚至是免費的 (視特定模型額度而定)。

---

## 3. 回到 Google Apps Script (GAS) 設定屬性

完成上述設定後，請回到 GAS 編輯器：
1. 點選左側選單 **專案設定 (⚙️)** ➔ 捲動到下方 **指令碼屬性**。
2. 點選 **編輯指令碼屬性** ➔ 依據您選擇的版本填入以下設定：

| 屬性名稱 (Property) | 必填/選填 | 範例值 | 說明 |
| :--- | :---: | :--- | :--- |
| `LINE_ACCESS_TOKEN` | **必填** | `v9a8s7d6f5...` | LINE Messaging API 的長金鑰。 |
| `GEMINI_API_KEY` | **必填** | `AIzaSy...` | Google AI Studio 申請的 Gemini 金鑰。 |
| `ALLOWED_GROUP_IDS` | **強烈建議** | `C123456..., U98765...` | 授權白名單（群組 ID 或個人 User ID，多個請用半形逗號 `,` 分開）。 |
| `SPREADSHEET_ID` | *選填* | `1BxiMVs0XRA5nFM...` | 僅限 `Code_Interactions.gs` 且希望透過 Google Sheet 管理白名單時填入。 |

3. 若要取得群組 ID，請先將機器人**加入目標群組**並在群組發送 `/get_group_id`，再將回傳的 `C` 開頭字串回填至 `ALLOWED_GROUP_IDS`。

---

## 4. 程式碼版本選擇與部署步驟（二選一）

> ⚠️ **重要觀念**：Google Apps Script 的運作機制是專案內所有檔案共用全域命名空間。因為 `Code.gs` 與 `Code_Interactions.gs` 都包含 Webhook 入口 `function doPost(e)`，**請勿同時放在同一個 GAS 專案內**，必須**二選一**部署！

### 選擇方案 A：部署經典版 `Code.gs` (專職查核與防詐)
* **適合對象**：希望機器人專注於「事實查核、影片大綱整理、詐騙網址偵測」，在群組保持安靜，不被拿來聊天問天氣。
* **部署步驟**：
  1. 將本機 [`Code.gs`](./Code.gs) 的全部程式碼複製。
  2. 貼到 GAS 編輯器覆蓋現有內容。
  3. 點選右上角 **「部署」 ➔ 「管理部署」 ➔ 點選鉛筆「編輯」 ➔ 版本選「新版本」 ➔ 點選「部署」**。

---

### 選擇方案 B：部署進階旗艦版 `Code_Interactions.gs` (全功能生活 + 查核助理)
* **適合對象**：希望機器人具備查核能力外，成員只要 **@TAG 機器人** 就能自動聯網回答「今天天氣、即時時事、生活常識」，且支援一對一私訊問答。
* **部署步驟**：
  1. 將本機 [`Code_Interactions.gs`](./Code_Interactions.gs) 的全部程式碼複製。
  2. 貼到 GAS 編輯器中**覆蓋掉現有程式碼**（確保專案內只有一份主要程式碼）。
  3. 指令碼屬性中只要有設定 `LINE_ACCESS_TOKEN`、`GEMINI_API_KEY` 與 `ALLOWED_GROUP_IDS` 即可運作（`SPREADSHEET_ID` 留空即可，系統會自動退回純群組白名單模式）。
  4. 點選右上角 **「部署」 ➔ 「管理部署」 ➔ 點選鉛筆「編輯」 ➔ 版本選「新版本」 ➔ 點選「部署」**。

> 💡 **每次更新提醒**：無論部署哪一個版本，修改程式碼後請務必執行 **「管理部署 ➔ 編輯 ➔ 新版本」**，否則 LINE Webhook 執行的會是舊版快取程式碼。

---

## 5. 💡 必學技巧：修改程式碼如何「保持同一個網址更新」（免每次重改 LINE Webhook）

許多人在每次修改程式碼後，會順手去按 **「新增部署作業」**，這會導致每次都產生一串全新的網址，必須反覆複製到 LINE Developers Console 更新，非常耗時且容易出錯。

只要透過以下步驟，**網址將 100% 保持完全不變**：

### 🛠️ 保持同一個 URL 的更新 5 步驟：
1. **修改與儲存程式碼**：在 GAS 編輯器中修改程式碼後，按下儲存（`Ctrl + S`）。
2. **點選「管理部署作業」**：
   - 點擊右上角的 **「部署」**（Deploy）按鈕。
   - 選擇 **「管理部署作業」**（Manage deployments）。*(⚠️ 千萬不要選「新增部署作業」)*
3. **編輯目前正在線上的部署**：
   - 在彈出視窗的左側選單，點選正在使用的那個部署（通常為 `網頁應用程式` / `Web app`）。
   - 點擊右上角的 **✏️「編輯 (鉛筆圖示)」**。
4. **切換為新版本**：
   - 在「**版本 (Version)**」下拉選單中，點選 **「新版本」**（New version）。
   - *(選填)* 可以在「版本說明」寫下備註（例如：`修復 400 錯誤與增強搜尋`）。
5. **點擊「部署」確認**：
   - 點選右下角的 **「部署」** 按鈕。
   - 點擊「完成」關閉視窗。

🎉 **大功告成**：
- 線上執行的程式碼已立即更新至最新版本。
- **網頁應用程式網址 (Web App URL) 完全不變**。
- **LINE Developers 後台完全不用重新設定**，機器人即可直接響應最新功能！


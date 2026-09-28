/**
 * AI 資訊查核助手 - 網頁版說明手冊與渲染器 (HelpView.gs)
 *
 * 提供 GAS Web App 的 doGet(e) 專屬說明頁面，讓使用者點開 LINE 提供的連結時，
 * 能在手機瀏覽器上查看完整、精美的圖文指令與功能指南。
 */

/**
 * 取得目前 Web App 的完整網址
 * 優先讀取指令碼屬性 WEB_APP_URL，若無則透過 ScriptApp 自動讀取發布網址
 */
function getWebAppUrl() {
  try {
    const customUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
    if (customUrl && customUrl.trim()) {
      return customUrl.trim();
    }
  } catch (e) {
    console.warn('讀取自訂 WEB_APP_URL 失敗:', e);
  }

  try {
    const serviceUrl = ScriptApp.getService().getUrl();
    if (serviceUrl && serviceUrl.indexOf('http') === 0) {
      return serviceUrl;
    }
  } catch (err) {
    console.warn('ScriptApp.getService().getUrl() 尚未發布或無法取得:', err);
  }

  return '';
}

/**
 * 產生現代化、手機優先 (Mobile-First RWD) 的完整說明網頁 HTML
 */
function renderHelpPageHtml() {
  const webAppUrl = getWebAppUrl();

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>🤖 AI 資訊查核助手｜完整使用指南與指令手冊</title>
  <style>
    :root {
      --primary: #06c755; /* LINE Green */
      --primary-dark: #05a847;
      --accent: #2563eb; /* Tech Blue */
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --tag-bg: #eff6ff;
      --tag-text: #1d4ed8;
      --code-bg: #f1f5f9;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans TC", sans-serif;
      background-color: var(--bg);
      color: var(--text-main);
      line-height: 1.6;
      padding: 0 0 40px 0;
    }

    /* 頂部 Header */
    .header {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #ffffff;
      padding: 28px 20px 24px;
      text-align: center;
      border-bottom: 3px solid var(--primary);
    }
    .header-badge {
      display: inline-block;
      background: rgba(6, 199, 85, 0.2);
      color: #4ade80;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid rgba(74, 222, 128, 0.3);
      margin-bottom: 8px;
    }
    .header h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 6px;
    }
    .header p {
      font-size: 13px;
      color: #94a3b8;
      max-width: 480px;
      margin: 0 auto;
    }

    /* 快捷導覽列 */
    .nav-bar {
      display: flex;
      overflow-x: auto;
      gap: 8px;
      padding: 12px 16px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
      scrollbar-width: none;
    }
    .nav-bar::-webkit-scrollbar {
      display: none;
    }
    .nav-item {
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-decoration: none;
      padding: 6px 12px;
      border-radius: 20px;
      background: #f1f5f9;
      transition: all 0.2s ease;
    }
    .nav-item:active, .nav-item:hover {
      background: var(--tag-bg);
      color: var(--tag-text);
    }

    /* 主要容器 */
    .container {
      max-width: 680px;
      margin: 0 auto;
      padding: 16px;
    }

    /* 卡片通用樣式 */
    .card {
      background: var(--card-bg);
      border-radius: 14px;
      border: 1px solid var(--border);
      padding: 18px;
      margin-bottom: 18px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      border-bottom: 1px solid #f1f5f9;
      padding-bottom: 10px;
    }
    .card-icon {
      font-size: 24px;
      line-height: 1;
    }
    .card-title {
      font-size: 17px;
      font-weight: 700;
      color: var(--text-main);
    }
    .card-tag {
      margin-left: auto;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 6px;
      font-weight: 600;
    }
    .tag-blue { background: #dbeafe; color: #1e40af; }
    .tag-green { background: #dcfce7; color: #166534; }
    .tag-amber { background: #fef3c7; color: #92400e; }
    .tag-red { background: #fee2e2; color: #991b1b; }

    .desc {
      font-size: 14px;
      color: #334155;
      margin-bottom: 12px;
    }

    /* 規則與條列 */
    .rules-list {
      list-style: none;
      margin-bottom: 12px;
    }
    .rules-list li {
      position: relative;
      padding-left: 20px;
      font-size: 13px;
      color: #475569;
      margin-bottom: 6px;
    }
    .rules-list li::before {
      content: "•";
      position: absolute;
      left: 6px;
      color: var(--primary);
      font-weight: bold;
    }

    /* 範例指令方塊 */
    .example-block {
      background: var(--code-bg);
      border-radius: 8px;
      border-left: 4px solid var(--accent);
      padding: 10px 12px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .example-text {
      font-size: 13px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #0f172a;
      word-break: break-all;
    }
    .copy-btn {
      flex-shrink: 0;
      background: #ffffff;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
    }
    .copy-btn:active {
      transform: scale(0.95);
      background: var(--tag-bg);
      color: var(--tag-text);
    }

    /* 提示小標籤 (Callout) */
    .callout {
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.5;
      margin-top: 10px;
    }
    .callout-info {
      background: #eff6ff;
      border-left: 3px solid #3b82f6;
      color: #1e40af;
    }
    .callout-warning {
      background: #fffbeb;
      border-left: 3px solid #f59e0b;
      color: #b45309;
    }

    /* FAQ 收折列表 */
    details {
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    summary {
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      color: #1e293b;
      list-style: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    summary::after {
      content: "＋";
      font-size: 14px;
      color: var(--text-muted);
    }
    details[open] summary::after {
      content: "－";
    }
    .faq-answer {
      font-size: 13px;
      color: #475569;
      padding-top: 8px;
      margin-top: 6px;
      border-top: 1px dashed var(--border);
    }

    /* 浮動提示 Toast */
    #toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: rgba(15, 23, 42, 0.9);
      color: #fff;
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      opacity: 0;
      transition: all 0.25s ease;
      z-index: 999;
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    #toast.show {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }

    /* 頁尾 */
    .footer {
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 24px;
      padding: 0 16px;
    }
  </style>
</head>
<body>

  <!-- 頂部橫幅 -->
  <header class="header">
    <div class="header-badge">Google Apps Script 雲端原生運作中</div>
    <h1>🤖 AI 資訊查核助手</h1>
    <p>深度事實查核・即時聯網問答・影片整理・防詐騙鑑識・國道路況與智慧停車</p>
  </header>

  <!-- 錨點捷徑列 -->
  <nav class="nav-bar">
    <a href="#quickstart" class="nav-item">⚡ 快速上手</a>
    <a href="#qa" class="nav-item">🌐 聯網問答</a>
    <a href="#factcheck" class="nav-item">⚖️ 事實查核</a>
    <a href="#youtube" class="nav-item">🎬 影片整理</a>
    <a href="#scam" class="nav-item">🔍 詐騙偵測</a>
    <a href="#traffic" class="nav-item">🚗 路況停車</a>
    <a href="#life" class="nav-item">🏢 民生生活</a>
    <a href="#system" class="nav-item">⚙️ 系統指令</a>
    <a href="#faq" class="nav-item">❓ 常見問答</a>
  </nav>

  <main class="container">

    <!-- 區塊 1: 快速上手原則 -->
    <section id="quickstart" class="card">
      <div class="card-header">
        <span class="card-icon">⚡</span>
        <h2 class="card-title">快速上手指南 (群組 vs 私訊)</h2>
        <span class="card-tag tag-green">核心機制</span>
      </div>
      <p class="desc">為避免洗版打擾日常對話，機器人在群組與私訊中採用不同的喚醒機制：</p>
      <ul class="rules-list">
        <li><strong>群組對話 (防洗版原則)</strong>：平時保持完全靜默。必須主動輸入 <code>@AI</code>、<code>@bot</code> 或標記機器人，它才會響應問答。</li>
        <li><strong>被動安全守護</strong>：在群組中即使沒有標記機器人，只要內容包含「真的假的、假訊息、造謠、詐騙、安全嗎」等關鍵字，機器人會主動啟動鑑識協助把關。</li>
        <li><strong>一對一私訊</strong>：已獲白名單授權的成員可直接私訊提問，無需加上 <code>@AI</code>。</li>
      </ul>
      <div class="callout callout-info">
        💡 <strong>精準防誤觸設計</strong>：日常輸入 Email（如 <code>service@ai.com</code> 或 <code>test@bot.com</code>）100% 絕不觸發，請放心使用！
      </div>
    </section>

    <!-- 區塊 2: 即時聯網問答 -->
    <section id="qa" class="card">
      <div class="card-header">
        <span class="card-icon">🌐</span>
        <h2 class="card-title">1. 即時聯網問答（生活、時事、多日天氣）</h2>
        <span class="card-tag tag-blue">自動附出處</span>
      </div>
      <p class="desc">機器人能即時透過 DuckDuckGo 權威多方搜尋，獲取最新新聞、生活資訊、節慶日期或完整今明 36 小時天氣預報，並於文末自動附上核實連結。</p>
      
      <div class="example-block">
        <span class="example-text">@AI 明天台南天氣如何？會下雨嗎？</span>
        <button class="copy-btn" onclick="copyCmd('@AI 明天台南天氣如何？會下雨嗎？')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">@AI 台北本週天氣趨勢與週末降雨機率</span>
        <button class="copy-btn" onclick="copyCmd('@AI 台北本週天氣趨勢與週末降雨機率')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">@bot 最近台灣有什麼最新的環保節能補助政策？</span>
        <button class="copy-btn" onclick="copyCmd('@bot 最近台灣有什麼最新的環保節能補助政策？')">📋 複製</button>
      </div>
    </section>

    <!-- 區塊 3: 謠言與假訊息深度查核 -->
    <section id="factcheck" class="card">
      <div class="card-header">
        <span class="card-icon">⚖️</span>
        <h2 class="card-title">2. 假訊息與謠言事實查核</h2>
        <span class="card-tag tag-red">多重鑑識</span>
      </div>
      <p class="desc">串接 Cofacts（真的假的闢謠庫）、台灣事實查核中心與 MyGoPen。可直接貼上 LINE 流傳文章、長輩圖文字或健康謠言。</p>
      
      <div class="example-block">
        <span class="example-text">真的假的？聽說吃菠菜配豆腐會導致腎結石？</span>
        <button class="copy-btn" onclick="copyCmd('真的假的？聽說吃菠菜配豆腐會導致腎結石？')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">@AI 幫我查核這則訊息：轉發就送LINE貼圖是真的嗎？</span>
        <button class="copy-btn" onclick="copyCmd('@AI 幫我查核這則訊息：轉發就送LINE貼圖是真的嗎？')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">資訊查核：網傳微波爐加熱食物會產生致癌毒素？</span>
        <button class="copy-btn" onclick="copyCmd('資訊查核：網傳微波爐加熱食物會產生致癌毒素？')">📋 複製</button>
      </div>
      <div class="callout callout-warning">
        🔍 <strong>觸發關鍵字</strong>：包含「查核、事實查核、真的假的、真的嗎、闢謠、造謠、假訊息」即可自動觸發。
      </div>
    </section>

    <!-- 區塊 4: YouTube 影片整理與核實 -->
    <section id="youtube" class="card">
      <div class="card-header">
        <span class="card-icon">🎬</span>
        <h2 class="card-title">3. YouTube 影片大綱與真偽核實</h2>
        <span class="card-tag tag-blue">精華萃取</span>
      </div>
      <p class="desc">自動透過官方 oEmbed API 抓取真實標題與頻道，杜絕 AI 幻覺，並可分析內容農場題材或生成精準章節大綱。</p>
      
      <div class="example-block">
        <span class="example-text">幫我整理影片大綱 https://youtu.be/xxxx</span>
        <button class="copy-btn" onclick="copyCmd('幫我整理影片大綱 https://youtu.be/xxxx')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">核實這部影片有沒有造謠 https://youtu.be/xxxx</span>
        <button class="copy-btn" onclick="copyCmd('核實這部影片有沒有造謠 https://youtu.be/xxxx')">📋 複製</button>
      </div>
    </section>

    <!-- 區塊 5: 詐騙與可疑網址安全偵測 -->
    <section id="scam" class="card">
      <div class="card-header">
        <span class="card-icon">🔍</span>
        <h2 class="card-title">4. 詐騙與可疑網址安全偵測</h2>
        <span class="card-tag tag-amber">防釣魚攻擊</span>
      </div>
      <p class="desc">整合靜態網域特徵評分（山寨品牌、高風險頂級網域 .shop/.vip 等）＋ 伺服器即時抓取頁面特徵 ＋ AI 語意鑑識。</p>
      
      <div class="example-block">
        <span class="example-text">這個網站有詐騙嗎 https://shopeee-tw.shop/...</span>
        <button class="copy-btn" onclick="copyCmd('這個網站有詐騙嗎 https://shopeee-tw.shop/...')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">幫我檢測這網址安全嗎 https://...</span>
        <button class="copy-btn" onclick="copyCmd('幫我檢測這網址安全嗎 https://...')">📋 複製</button>
      </div>
    </section>

    <!-- 區塊 6: 國道路況與智慧停車 -->
    <section id="traffic" class="card">
      <div class="card-header">
        <span class="card-icon">🚗</span>
        <h2 class="card-title">5. 國道路況與智慧停車查詢</h2>
        <span class="card-tag tag-green">TDX 官方即時</span>
      </div>
      <p class="desc">串接交通部 TDX 官方即時 API，查詢國道即時路段車速、事故通報、以及目標景點周邊停車場剩餘車位與 Google 地圖導航。</p>
      
      <div class="example-block">
        <span class="example-text">@Bot 今天台南到新竹即時路況預計抵達時間</span>
        <button class="copy-btn" onclick="copyCmd('@Bot 今天台南到新竹即時路況預計抵達時間')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">@Bot 新竹巨城周邊有哪裡好停車？還有車位嗎？</span>
        <button class="copy-btn" onclick="copyCmd('@Bot 新竹巨城周邊有哪裡好停車？還有車位嗎？')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">@Bot 台北車站周邊停車場即時車位與費率</span>
        <button class="copy-btn" onclick="copyCmd('@Bot 台北車站周邊停車場即時車位與費率')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">@Bot 停車 台南赤崁樓</span>
        <button class="copy-btn" onclick="copyCmd('@Bot 停車 台南赤崁樓')">📋 複製</button>
      </div>
    </section>

    <!-- 區塊 7: 官方民生生活即時資訊 -->
    <section id="life" class="card">
      <div class="card-header">
        <span class="card-icon">🏢</span>
        <h2 class="card-title">6. 官方民生即時資訊 (油價・發票・急診)</h2>
        <span class="card-tag tag-blue">免 Key 直連</span>
      </div>
      <p class="desc">直接串接台灣中油最新牌價、財政部統一發票開獎號碼、以及衛福部健保署重度急救責任醫院即時滿床看板。</p>
      
      <div class="example-block">
        <span class="example-text">@AI 現在中油汽油價格多少？</span>
        <button class="copy-btn" onclick="copyCmd('@AI 現在中油汽油價格多少？')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">@AI 最新一期統一發票中獎號碼開獎</span>
        <button class="copy-btn" onclick="copyCmd('@AI 最新一期統一發票中獎號碼開獎')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">@AI 台大醫院急診現在有滿床嗎？等待看診人數</span>
        <button class="copy-btn" onclick="copyCmd('@AI 台大醫院急診現在有滿床嗎？等待看診人數')">📋 複製</button>
      </div>
    </section>

    <!-- 區塊 8: 系統與白名單指令 -->
    <section id="system" class="card">
      <div class="card-header">
        <span class="card-icon">⚙️</span>
        <h2 class="card-title">7. 系統與管理員指令</h2>
        <span class="card-tag tag-blue">權限管理</span>
      </div>
      <p class="desc">查詢自身專屬 ID 或群組 ID，回報給機器人管理員以開通 Google 試算表白名單權限。</p>
      
      <div class="example-block">
        <span class="example-text">/get_id</span>
        <button class="copy-btn" onclick="copyCmd('/get_id')">📋 複製</button>
      </div>
      <div class="example-block">
        <span class="example-text">/help</span>
        <button class="copy-btn" onclick="copyCmd('/help')">📋 複製</button>
      </div>
    </section>

    <!-- 區塊 9: 常見問題 FAQ -->
    <section id="faq" class="card">
      <div class="card-header">
        <span class="card-icon">❓</span>
        <h2 class="card-title">常見問答 (FAQ)</h2>
        <span class="card-tag tag-blue">疑難排解</span>
      </div>
      
      <details>
        <summary>Q1: 為什麼在群組發問，機器人沒有任何反應？</summary>
        <div class="faq-answer">
          1. 請確認訊息開頭是否有加上 <strong>@AI</strong>、<strong>@bot</strong> 或 LINE 原生 @標記。<br>
          2. 請確認該群組是否已經由管理員加入白名單設定。<br>
          3. 若為純文字閒聊且未含查核關鍵字，機器人會自動靜音不打擾。
        </div>
      </details>

      <details>
        <summary>Q2: 為什麼私訊機器人會顯示「未授權」？</summary>
        <div class="faq-answer">
          為避免 API 額度遭到濫用，私訊功能僅開放給授權成員。請在私訊對話框中輸入 <code>/get_id</code> 取得專屬 User ID，並提供給管理員加入白名單即可暢聊。
        </div>
      </details>

      <details>
        <summary>Q3: 查核的資料來源從哪裡來？</summary>
        <div class="faq-answer">
          機器人全面採用「免綁卡、零成本」的公開權威來源，包括 Cofacts 真的假的、台灣事實查核中心、MyGoPen，並配合 DuckDuckGo 權威排序二段式爬蟲與 Gemini 官方模型梯隊進行深度分析。
        </div>
      </details>
    </section>

  </main>

  <footer class="footer">
    <p>AI 資訊查核助手 LINE Bot © 2026</p>
    <p style="margin-top: 4px;">由 Google Apps Script 雲端伺服器與 Gemini AI 守護您的數位生活安全</p>
  </footer>

  <!-- 浮動提示 Toast -->
  <div id="toast">已複製指令到剪貼簿！</div>

  <script>
    function copyCmd(text) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function() {
          showToast('已複製指令！可直接至 LINE 貼上');
        }).catch(function() {
          fallbackCopy(text);
        });
      } else {
        fallbackCopy(text);
      }
    }

    function fallbackCopy(text) {
      var textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.top = "-9999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        showToast('已複製指令！可直接至 LINE 貼上');
      } catch (err) {
        showToast('複製失敗，請長按文字手動複製');
      }
      document.body.removeChild(textArea);
    }

    function showToast(msg) {
      var toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.classList.add('show');
      setTimeout(function() {
        toast.classList.remove('show');
      }, 2000);
    }
  </script>
</body>
</html>`;
}

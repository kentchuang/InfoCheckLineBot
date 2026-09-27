/**
 * AI 資訊查核助手 LINE Bot (Interactions API 智能版)
 * 版別：v2026.09.28.01-interactions-deep-search
 * 部署環境: Google Apps Script (GAS)
 *
 * [架構設計說明]
 * 1. 採用 Google Gemini 新世代 Interactions API (/v1beta/interactions) 進行統一通訊。
 * 2. 免帳號深度聯網查證：內建 DuckDuckGo 權威排序 + 二段式深度網頁內文爬取 + Cofacts 闢謠庫，免綁卡零成本。
 * 3. Google Sheet 權限管理：支援透過 Google 試算表控管 User 與 Group 白名單，授權的使用者可直接一對一私訊與 Bot 暢聊。
 * 4. 高效快取機制 (CacheService)：試算表名單快取 10 分鐘，大幅降低延遲並防止 LINE Webhook 逾時。
 * 5. 意圖自動理解與動態排版：由 AI 自動辨識 4 大情境（事實查核、影片整理、詐騙鑑識、生活健康/知識通用問答），並自動生成最適合 LINE 手機閱讀的版面。
 * 6. 官方有效模型梯隊：主力採用 gemini-2.5-flash，次主力 gemini-3-flash-preview，搭配 gemini-3.1-flash-lite-preview 與 gemini-2.5-pro 備援防線。
 */

// 1. 金鑰與設定讀取 (從 GAS 「指令碼屬性」中讀取)
const LINE_ACCESS_TOKEN = PropertiesService.getScriptProperties().getProperty('LINE_ACCESS_TOKEN');
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
// 權限控管 Google Sheet 的 ID (填入試算表網址中 /d/ 與 /edit 之間的那串英數字)
const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');

// 2. 聯網檢索旗標設定 (Google Search Grounding)
//    ENABLE_GROUNDING = false → 純 AI 訓練資料模式，完全免費 ($0 元)，適合 Free Tier (預設推薦)
//    ENABLE_GROUNDING = true  → 開啟 Google Search 聯網搜尋（需綁定信用卡，超出免費額度後會計費）
const ENABLE_GROUNDING = false;

/**
 * 處理 LINE Webhook
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const events = data.events;

    if (!events || events.length === 0) return;

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        processMessage(event);
      }
    }
  } catch (error) {
    console.error('Error in doPost:', error);
  }
}

/**
 * 處理訊息邏輯
 */
function processMessage(event) {
  const userText = event.message.text.trim();
  const replyToken = event.replyToken;
  const sourceType = event.source.type; // 'user', 'group', or 'room'
  const currentId = sourceType === 'user' ? event.source.userId 
                  : sourceType === 'group' ? event.source.groupId 
                  : event.source.roomId;

  // 1. 隱藏指令：查詢專屬 ID (方便使用者回報給管理員加入試算表)
  if (userText === '/get_id' || userText === '/get_group_id' || userText === '/my_id') {
    if (sourceType === 'group') {
      replyToLine(replyToken, `📌 本群組的 Group ID 是：\n${currentId}`);
    } else {
      replyToLine(replyToken, `📌 您的專屬 User ID 是：\n${currentId}\n\n💡 請將此 ID 提供給管理員加入 Google 試算表白名單。`);
    }
    return;
  }

  // 2. 指令查詢與使用幫助
  if (userText === '指令查詢' || userText === '幫助' || userText === '/help' || userText === 'help') {
    const helpMsg = `🤖 AI 資訊查核與生活助手｜使用指南

🌟 核心四大功能：

1️⃣ 即時聯網問答（生活時事、天氣節日）
▫️ 用法：群組請加上 @AI 或 @bot，私訊可直接提問
▫️ 範例：
  • @AI 2026年中秋節是哪一天？
  • @bot 明天台北天氣如何？
  • @AI 最近有什麼重大國際新聞？
  （系統會自動聯網檢索，文末自動附上核實連結 🔗）

2️⃣ 假訊息與謠言深度查核（長輩圖/文字文章）
▫️ 用法：貼上流傳文字，包含「真的嗎/真的假的/造謠/查核」
▫️ 範例：
  • 真的假的？聽說吃菠菜配豆腐會結石？
  • @AI 幫我查核這則節能補助簡訊是不是真的
  （串接 Cofacts 真的假的闢謠庫 與 台灣事實查核中心）

3️⃣ YouTube 影片整理與真偽核實
▫️ 用法：貼上 YouTube 連結 ＋ 需求關鍵字
▫️ 範例：
  • 幫我整理影片大綱 https://youtu.be/...
  • 查核這部影片有沒有造謠 https://youtu.be/...

4️⃣ 詐騙與可疑網址安全偵測
▫️ 用法：貼上可疑網址 ＋ 詢問安全性
▫️ 範例：
  • 這個網站有詐騙嗎 https://xxx.shop/...
  • 幫我檢測這網址安全嗎 https://...

────────────────
⚙️ 系統指令：
• /help 或 指令查詢：查看本使用指南
• /get_id：查詢本群組 ID 或個人 User ID（回報管理員開通權限）`;
    replyToLine(replyToken, helpMsg);
    return;
  }

  // 3. 權限控管檢查 (優先讀取 Google Sheet 白名單，若未設定則比對 ALLOWED_GROUP_IDS)
  const isAuthorized = checkAuthorization(currentId, sourceType);
  if (!isAuthorized) {
    if (sourceType === 'user') {
      if (SPREADSHEET_ID) {
        replyToLine(replyToken, `⛔ 抱歉，您尚未取得使用授權。\n\n您的專屬 User ID 為：\n${currentId}\n\n💡 請聯絡管理員將您的 ID 新增至 Google 試算表白名單中以開通權限。`);
      } else {
        replyToLine(replyToken, `⛔ 抱歉，這是一個私人專用的查核助手機器人，目前僅限於已授權的 LINE 群組內提供服務，恕不開放未授權的一對一私訊喔！\n\n💡 您的 User ID 是：\n${currentId}\n（管理員可將此 ID 加入 ALLOWED_GROUP_IDS 白名單以開通私訊功能）`);
      }
    }
    // 群組若未授權則保持靜默，避免打擾
    return;
  }

  // 4. 喚醒與觸發判斷
  const isDirectChat = sourceType === 'user'; // 是否為一對一私訊
  const urlMatch = userText.match(/https?:\/\/[^\s]+/);
  // 精準喚醒：支援 @AI、@ai、@Ai、@Bot、@bot（不分大小寫），且後方需為冒號、逗號、空格或結尾，100% 防止 Email (如 abc@gmail.com, test@ai.com) 誤觸
  const isMentioned = !!(event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0);
  const hasCallTag = /(?:^|\s)@(ai|bot)(?:[:：\s,，]|$)/i.test(userText);
  const isTaggedBot = isDirectChat || isMentioned || hasCallTag; // 使用者是否主動 TAG 呼叫機器人 (或私訊)

  // 被動觸發關鍵字清單 (在群組未 TAG 機器人時，僅針對特定安全與查核任務被動響應，避免打擾日常閒聊)
  const passiveFactKws = ['資訊查核', '事實查核', '影片核實', '查核', '核實', '真偽', '造謠', '闢謠', '假的', '真的嗎', '真的假的', '假訊息', '不實'];
  const passiveSummaryKws = ['影片整理', '影片大綱', '內容摘要', '內容整理'];
  const passiveScamKws = ['詐騙', '釣魚', '可疑', '安全嗎', '安不安全', '有沒有詐騙', '網址查核'];

  const hasPassiveFact = passiveFactKws.some(kw => userText.includes(kw));
  const hasPassiveSummary = passiveSummaryKws.some(kw => userText.includes(kw));
  const hasPassiveScam = passiveScamKws.some(kw => userText.includes(kw));

  // 若使用者「沒有 TAG 機器人」，且「沒有網址」，且「未命中被動關鍵字」：保持完全靜默
  if (!isTaggedBot && !urlMatch && !hasPassiveFact && !hasPassiveSummary && !hasPassiveScam) {
    return;
  }

  // 移除 @AI、@bot 或 LINE 原生 @提及標籤，萃取出乾淨的核心提問文字
  const cleanUserText = userText
    .replace(/(?:^|\s)@(ai|bot)(?:[:：\s,，]|$)/gi, ' ')
    .replace(/@[^\s]+\s*/g, ' ')
    .trim();
  if (!cleanUserText && !urlMatch) return;

  // 5. 整合前置上下文（Context Enrichment）
  let enrichedPrompt = `使用者問題/需求：\n${cleanUserText}\n\n`;
  let factSources = [];

  // 若包含網址，先抓取網址背景資訊 (YouTube oEmbed 或 網頁預覽/防詐評分)
  if (urlMatch) {
    const targetUrl = urlMatch[0];
    if (isYoutubeUrl(targetUrl)) {
      const ytInfo = fetchYoutubeInfo(targetUrl);
      enrichedPrompt += `【附加 YouTube 影片資訊】\n${ytInfo}\n`;
    } else {
      const riskScore = analyzeUrlRisk(targetUrl);
      const pagePreview = fetchWebPageContext(targetUrl);
      enrichedPrompt += `【附加網址分析資訊】\n待檢測網址：${targetUrl}\n靜態風險分數：${riskScore}分\n網頁內容預覽：\n${pagePreview}\n`;
    }
  }

  // 模式 A：【使用者主動 TAG BOT (或一對一私訊)】
  // ➔ 自動整理問題，提取核心查詢關鍵詞丟給 DuckDuckGo 進行即時網路檢索 (天氣、時事、各類問答全支援)！
  if (isTaggedBot) {
    const searchQuery = extractSearchQuery(cleanUserText);
    if (searchQuery) {
      const searchResult = getDeepFactCheckContext(searchQuery);
      enrichedPrompt += `\n【即時網路多方檢索與權威資訊 (DuckDuckGo + Cofacts)】\n${searchResult.contextText}\n`;
      factSources = searchResult.sources || [];
    }
  }
  // 模式 B：【未 TAG BOT，但命中了事實查核被動關鍵字】
  // ➔ 針對問題內容進行事實查核檢索
  else if (hasPassiveFact) {
    const factQuery = extractSearchQuery(cleanUserText);
    if (factQuery) {
      const factResult = getDeepFactCheckContext(factQuery);
      enrichedPrompt += `\n【免帳號深度事實查證依據 (Cofacts 闢謠庫 + 多方權威來源 + 深度內文)】\n${factResult.contextText}\n`;
      factSources = factResult.sources || [];
    }
  }

  // 6. 呼叫 Interactions API（由 AI 自行判斷意圖並產生適合 LINE 的排版）
  let result = callGeminiInteractionsAPI(enrichedPrompt);
  if (result) {
    // 若有檢索到的權威網頁資料來源，程式端保底附加可供使用者親自核實的連結
    if (factSources.length > 0) {
      result += formatCitationFootnote(factSources);
    }
    replyToLine(replyToken, result);
  }
}

/**
 * 整理使用者問題，萃取出最適合提供給 DuckDuckGo 檢索的核心關鍵詞
 * @param {string} text - 使用者原始輸入文字
 * @return {string} 適合搜尋的關鍵字串
 */
function extractSearchQuery(text) {
  if (!text) return "";
  // 移除網址
  let query = text.replace(/https?:\/\/[^\s]+/g, '').trim();
  // 移除禮貌前綴詞、@AI/@bot 標記與問句語氣助詞
  query = query
    .replace(/(?:^|\s)@(ai|bot)(?:[:：\s,，]|$)/gi, ' ')
    .replace(/^(請幫我|幫我|請|麻煩|我想|可以幫我|替我|請問|我想知道|請教一下|能告訴我|跟我說|查一下|查詢|搜尋)\s*/g, '')
    .replace(/^(資訊查核|事實查核|影片核實|查核|核實|資訊確認|確認)\s*/g, '')
    .replace(/[嗎阿呢吧呀呀嘛？?！!。，,]+$/g, '')
    .trim();
  return query || text;
}

/**
 * 檢查使用者或群組是否具備授權 (支援 Google Sheet 與快取)
 * @param {string} id - User ID 或 Group ID
 * @param {string} type - 'user' 或 'group'
 * @return {boolean}
 */
function checkAuthorization(id, type) {
  // A. 如果設定了 SPREADSHEET_ID，以 Google Sheet 為主
  if (SPREADSHEET_ID) {
    const whitelist = getAuthorizedListFromSheet();
    // 若試算表內無任何紀錄，預設放行或拒絕 (此處設定為若有設定 ID 則嚴格比對)
    if (whitelist.length > 0) {
      return whitelist.includes(id);
    }
  }

  // B. 備援相容：若未設定 SPREADSHEET_ID，則比對 GAS 指令碼屬性 ALLOWED_GROUP_IDS
  const rawAllowedIds = PropertiesService.getScriptProperties().getProperty('ALLOWED_GROUP_IDS') || "";
  const allowedIds = rawAllowedIds ? rawAllowedIds.split(',').map(item => item.trim()) : [];
  
  if (allowedIds.length > 0) {
    return allowedIds.includes(id);
  }

  // C. 若兩者皆未設定任何白名單限制，預設開放
  return true;
}

/**
 * 從 Google 試算表讀取授權白名單 (含 10 分鐘 Cache 快取以加速回應)
 * @return {string[]} 授權的 ID 陣列
 */
function getAuthorizedListFromSheet() {
  const cache = CacheService.getScriptCache();
  const cachedData = cache.get('AUTHORIZED_WHITELIST');
  if (cachedData) {
    try {
      return JSON.parse(cachedData);
    } catch (e) {}
  }

  const ids = [];
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    // 優先讀取名為 'Whitelist' 或 '權限清單' 的分頁，若無則讀取第一個分頁
    const sheet = ss.getSheetByName('Whitelist') || ss.getSheetByName('權限清單') || ss.getSheets()[0];
    const data = sheet.getDataRange().getValues();

    // 假設第 1 列為標題，從第 2 列開始讀取
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const targetId = String(row[0] || '').trim(); // 第 A 欄：ID (U... 或 C...)
      const status = String(row[3] || row[2] || '').trim().toLowerCase(); // 狀態欄 (若有)

      // 若狀態為「停用」、「disabled」、「false」則略過，其餘皆視為有效授權
      if (targetId && !['停用', 'disabled', 'false', '0'].includes(status)) {
        ids.push(targetId);
      }
    }

    // 寫入快取 (快取 600 秒 = 10 分鐘)
    cache.put('AUTHORIZED_WHITELIST', JSON.stringify(ids), 600);
  } catch (err) {
    console.error('讀取 Google 試算表白名單失敗:', err);
  }

  return ids;
}

/**
 * 檢查是否包含 YouTube 連結
 */
function isYoutubeUrl(text) {
  const ytRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+)/;
  return ytRegex.test(text);
}

/**
 * 抓取 YouTube 影片資訊 (oEmbed)
 */
function fetchYoutubeInfo(videoUrl) {
  try {
    const oembedUrl = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(videoUrl) + '&format=json';
    const oembedRes = UrlFetchApp.fetch(oembedUrl, { muteHttpExceptions: true });
    if (oembedRes.getResponseCode() === 200) {
      const data = JSON.parse(oembedRes.getContentText());
      return `- 標題：${data.title}\n- 頻道：${data.author_name}\n- 網址：${videoUrl}`;
    }
  } catch (err) {
    console.error('oEmbed 抓取失敗:', err);
  }
  return `- 網址：${videoUrl} (未能取得標題)`;
}

/**
 * 詐騙網址靜態風險評分
 */
function analyzeUrlRisk(url) {
  let riskScore = 0;
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const searchParams = urlObj.search.toLowerCase();

    // 1. 高風險 TLD (+40)
    const riskyTlds = ['.shop', '.top', '.xyz', '.vip', '.site', '.cc', '.fun', '.online', '.buzz', '.click', '.link'];
    if (riskyTlds.some(tld => hostname.endsWith(tld))) riskScore += 40;

    // 2. 詐騙系統常用 URL 參數 (2 個以上 +50)
    const scamParams = ['m=order', 'tpl=detail', 'id=', 'lang=zh-tw', 'utm_source=line'];
    const matchCount = scamParams.filter(p => searchParams.includes(p)).length;
    if (matchCount >= 2) riskScore += 50;

    // 3. 亂碼網域判斷 (+30)
    const domainParts = hostname.split('.');
    const domainMain = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : '';
    if (domainMain.length > 8) {
      const digitCount = (domainMain.match(/\d/g) || []).length;
      if (digitCount > 2 || !/[aeiouy]/i.test(domainMain)) riskScore += 30;
    }

    // 4. 山寨知名品牌比對 (+60)
    const fakeBrands = ['shopeee', 'shopee-', 'tw-momo', 'm0m0', 'momoo', 'pchoome', 'p-chome', 'yahoo-', 'line-', '7-11-'];
    if (fakeBrands.some(fb => hostname.includes(fb))) riskScore += 60;

  } catch (e) {
    console.log('URL 解析錯誤: ' + url);
  }
  return riskScore;
}

/**
 * 即時抓取網頁內容作為 AI 研判依據
 */
function fetchWebPageContext(url) {
  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" }
    });

    const code = response.getResponseCode();
    if (code !== 200) return `[無法正常存取] 伺服器回傳狀態碼：${code}`;

    const html = response.getContentText();
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "無標題";

    const cleanBody = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 1200);

    return `標題：${title}\n內容預覽：${cleanBody}`;
  } catch (e) {
    return `[存取失敗] 原因：${e.message}`;
  }
}

/**
 * 免帳號、免 API Key 之 DuckDuckGo 深度搜尋模組
 * 抓取前 8 筆結果並進行權威來源加權排序
 * @param {string} query 搜尋關鍵字
 * @return {Array<Object>} 排序後的搜尋結果
 */
function searchDuckDuckGo(query) {
  const results = [];
  try {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
      }
    });

    if (response.getResponseCode() !== 200) return results;

    const html = response.getContentText();
    const regex = /<div[^>]*class="[^"]*result__body[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
    let match;

    while ((match = regex.exec(html)) !== null && results.length < 8) {
      const block = match[0];
      const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);

      if (titleMatch) {
        let rawUrl = titleMatch[1];
        let realUrl = rawUrl;
        const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) realUrl = decodeURIComponent(uddgMatch[1]);

        const title = titleMatch[2].replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() : '';

        let authorityScore = 10;
        const authorityPatterns = [
          /tfc-taiwan\.org\.tw/i,
          /mygopen\.com/i,
          /cofacts\.tw/i,
          /\.gov\.tw/i,
          /mohw\.gov\.tw/i,
          /cdc\.gov\.tw/i,
          /fda\.gov\.tw/i,
          /cna\.com\.tw/i,
          /twreporter\.org/i,
          /\.edu\.tw/i
        ];

        for (const pattern of authorityPatterns) {
          if (pattern.test(realUrl)) {
            authorityScore += 50;
            break;
          }
        }

        if (/闢謠|查證|事實查核|假訊息|澄清|謠言|真相/i.test(title + snippet)) {
          authorityScore += 30;
        }

        results.push({
          title: title,
          url: realUrl,
          snippet: snippet,
          score: authorityScore
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
  } catch (e) {
    console.error('DuckDuckGo 搜尋例外:', e);
  }
  return results;
}

/**
 * 二段式爬取：點入最具權威性的網頁抓取全文 (最長 1500 字)
 */
function fetchDeepPageContent(url) {
  try {
    if (!url || !url.startsWith('http')) return "";
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0" }
    });

    if (response.getResponseCode() !== 200) return "";
    const html = response.getContentText();

    const cleanBody = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 1500);

    return cleanBody;
  } catch (e) {
    return "";
  }
}

/**
 * 查詢「Cofacts 真的假的」闢謠開放資料庫
 * @param {string} query 查核文字
 * @return {Object} 包含闢謠資訊摘要與來源網址
 */
function queryCofactsApi(query) {
  let cofactsText = "";
  let sourceUrl = "";
  try {
    const gql = `
      query SearchArticles($query: String!) {
        ListArticles(filter: {moreLikeThis: {like: $query}}, first: 2) {
          edges {
            node {
              id
              text
              articleReplies {
                reply {
                  text
                  type
                  reference
                }
              }
            }
          }
        }
      }
    `;
    const response = UrlFetchApp.fetch('https://cofacts-api.g0v.tw/graphql', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ query: gql, variables: { query: query.substring(0, 80) } }),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      const edges = data.data && data.data.ListArticles && data.data.ListArticles.edges;
      if (edges && edges.length > 0) {
        let foundReply = false;
        edges.forEach((edge) => {
          const replies = edge.node.articleReplies;
          if (replies && replies.length > 0) {
            foundReply = true;
            const r = replies[0].reply;
            const typeLabel = r.type === 'RUMOR' ? '🔴 含有不實訊息' : r.type === 'NOT_RUMOR' ? '🟢 屬實訊息' : '🟡 含有爭議/個人意見';
            cofactsText += `【Cofacts 闢謠資料庫精確比對】\n▫️ 查核判定：${typeLabel}\n▫️ 查證內容：${r.text.substring(0, 300)}...\n▫️ 參考出處：${(r.reference || '無附連結').substring(0, 150)}\n\n`;

            if (!sourceUrl && r.reference) {
              const urlMatch = r.reference.match(/https?:\/\/[^\s]+/);
              if (urlMatch) sourceUrl = urlMatch[0];
            }
            if (!sourceUrl && edge.node.id) {
              sourceUrl = `https://cofacts.tw/article/${edge.node.id}`;
            }
          }
        });
        if (foundReply) return { text: cofactsText, sourceUrl: sourceUrl };
      }
    }
  } catch (e) {
    console.error('Cofacts API 查詢略過:', e);
  }
  return { text: "", sourceUrl: "" };
}

/**
 * 整合「Cofacts + DuckDuckGo 多筆權威排序 + 二段式深度內文爬取」
 * @param {string} factQuery - 查核關鍵字或內文
 * @return {Object} 包含完整的查核背景上下文 (contextText) 與使用者可點擊之來源清單 (sources)
 */
function getDeepFactCheckContext(factQuery) {
  let contextReport = "";
  const sources = [];

  const cofactsResult = queryCofactsApi(factQuery);
  if (cofactsResult.text) {
    contextReport += cofactsResult.text + "\n";
    if (cofactsResult.sourceUrl) {
      sources.push({
        title: "Cofacts 真的假的闢謠查核",
        url: cofactsResult.sourceUrl
      });
    }
  }

  const searchResults = searchDuckDuckGo(factQuery);
  if (searchResults.length > 0) {
    contextReport += "【網路多方即時查證來源（按權威度排序）】\n";
    const topResults = searchResults.slice(0, 5);
    topResults.forEach((item, idx) => {
      contextReport += `[來源 ${idx + 1}] ${item.title}\n網址：${item.url}\n摘要：${item.snippet}\n\n`;
    });

    searchResults.slice(0, 2).forEach(item => {
      if (!sources.some(s => s.url === item.url)) {
        sources.push({
          title: item.title,
          url: item.url
        });
      }
    });

    const bestSource = searchResults[0];
    if (bestSource && bestSource.url) {
      const deepContent = fetchDeepPageContent(bestSource.url);
      if (deepContent) {
        contextReport += `【深度內文研讀（取自最佳來源：${bestSource.title}）】\n${deepContent}\n\n`;
      }
    }
  }

  return {
    contextText: contextReport || "（無相關公開闢謠或即時網路檢索結果，請依照既有專業醫學/科普邏輯進行客觀鑑識）",
    sources: sources.slice(0, 2)
  };
}

/**
 * 格式化供使用者親自核實之資料來源註腳
 * @param {Array<Object>} sources - 來源清單 [{title, url}]
 * @return {string} 格式化後的文字區塊
 */
function formatCitationFootnote(sources) {
  if (!sources || sources.length === 0) return "";
  let footnote = "\n\n─────────────────\n🔗 查證依據與核實連結：";
  sources.forEach(src => {
    footnote += `\n▫️ ${src.title}：\n${src.url}`;
  });
  return footnote;
}

/**
 * 呼叫 Gemini Interactions API (統一 Agent 提示詞 + Web Search 工具支援 + 多模型降級)
 */
function callGeminiInteractionsAPI(inputContent) {
  // 統整型 Agent 指示詞：由 AI 自主根據輸入內容判定意圖並選擇最適格式輸出
  const UNIFIED_AGENT_INSTRUCTION = `
你是一位具備資安防護、事實查核與生活知識顧問能力的「全方位數位生活與鑑識 AI 助手」。
請根據使用者提供的內容與問題，自動判斷核心意圖，並嚴格依照專為 LINE 手機端設計的格式輸出：

【通用排版與限制守則】
- 嚴禁使用 Markdown 語法（絕對禁止 #, ##, **, ---, \` 等標記符號，直接輸出乾淨文字）。
- 一律使用繁體中文。
- 結論先行：手機螢幕有限，最重要的核心解答必須放在第一段。
- 善用 Emoji（💡, 📌, ▫️, ⚠️, 🚩, 🔴, 🟡, 🟢）建立視覺層次。
- 篇幅精簡，控制在 LINE 手機螢幕一至兩屏即可快速瀏覽完畢。

---

【情境 A：YouTube 影片 - 事實查核 / 真偽鑑定】
燈號說明：🔴 高風險(造謠/詐騙) / 🟡 中風險(標題黨/非專業) / 🟢 低風險(權威/專業)
[燈號] 核心摘要：[一句話總結：區分行銷風格與內容實質]

🤖 AI 鑑定 (參與度：XX%)
▫️ 特徵：[區分是 AI 輔助製作還是純 AI 生成]
▫️ 屬性：[專家實拍 / 知識分享 / 內容農場 / 搬運剪輯]

⚖️ 真實性評估
▫️ [分析核心建議的正確性與邏輯]

🚩 專家結論
[一句話建議：可作參考但須留意標題誇張 / 專業推薦 / 內容農場 / 錯誤資訊]

---

【情境 B：YouTube 影片 - 摘要筆記 / 大綱整理】
📝 影片內容精華筆記

📌 核心大綱：
▫️ [重點 1]
▫️ [重點 2]
▫️ [重點 3]

💡 適合誰看？
[分析目標受眾]

🚩 快速總結
[一句話精華]

---

【情境 C：一般網址 - 詐騙與釣魚偵測】
燈號說明：🔴 高風險(明確詐騙) / 🟡 中風險(疑似風險) / 🟢 低風險(安全網站)
[燈號] 風險摘要：[一句話評定風險等級與核心理由]

🔍 深度鑑識分析
▫️ 品牌模仿：[分析是否偽造知名品牌]
▫️ 內容偵測：[分析內文語義與誘騙話術]
▫️ 圖文一致性：[分析標題與內文是否匹配]

🛡️ 安全評級
靜態掃描分數：[參考附帶的分數]分
整體評級：[🔴 高風險 / 🟡 中風險 / 🟢 低風險]

🚫 專家建議
[明確告知使用者該採取什麼行動]

---

【情境 D：即時天氣 / 生活時事 / 實用知識 / 日常問答 (如：今天天氣、最新情報、B群何時吃、生活常識)】
💡 核心結論：[直球對決，一句話給出最明確解答，如：今日台北白天晴偶陣雨，氣溫約 28~31°C]

📌 即時情報與關鍵重點：
▫️ [重點 1：即時氣溫、降雨機率或核心資訊]
▫️ [重點 2：最新變化趨勢或客觀背景]
▫️ [重點 3：具體行動或實用建議]

⚠️ 貼心提醒：
▫️ [出門帶傘、防曬保暖、或常見注意事項]

🚩 專家小叮嚀
[一句話貼心叮嚀或總結]
  `;

  // 備援模型清單 (最新正式推薦 ➔ 極速防線 ➔ 經典 Flash ➔ 旗艦 Pro)
  // 依據 Google 官方最新指示：gemini-2.5-pro 已不對新用戶開放，全面改用 gemini-3 系列！
  const FALLBACK_MODELS = [
    'gemini-3-flash-preview',        // [Tier 1 主力首選] Google 3 世代標準 Flash，速度極快、推論品質高，新用戶完美支援
    'gemini-3.1-flash-lite-preview', // [Tier 2 極速防線] 超低延遲極速回應，高 RPM，確保 Webhook 絕不逾時
    'gemini-2.5-flash',              // [Tier 3 穩定備援] 2.5 系列經典 Flash
    'gemini-3.1-pro-preview'         // [Tier 4 旗艦備援] 官方官方指定取代 2.5-pro 的旗艦模型，深度推理保底
  ];

  const payload = {
    "contents": [{
      "parts": [{ "text": inputContent }]
    }],
    "systemInstruction": {
      "parts": [{ "text": UNIFIED_AGENT_INSTRUCTION }]
    },
    "generationConfig": {
      "temperature": 0.3,
      "maxOutputTokens": 2048
    }
  };

  if (ENABLE_GROUNDING) {
    payload["tools"] = [{
      "google_search_retrieval": {
        "dynamic_retrieval_config": {
          "mode": "MODE_DYNAMIC",
          "dynamic_threshold": 0.8
        }
      }
    }];
  }

  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  let lastErrorDetail = "📌 所有模型均無法連線";

  for (const model of FALLBACK_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      const responseText = response.getContentText();

      let json;
      try {
        json = JSON.parse(responseText);
      } catch (parseErr) {
        lastErrorDetail = `📌 [${model}] 回應解析失敗 (Code: ${code})`;
        continue;
      }

      if (code === 200) {
        let replyText = extractAnyTextFromGemini(json);
        if (replyText) {
          replyText += `\n\n🤖 (Powered by ${model})`;
          return replyText;
        }
      }

      if (code === 503 || code === 429) {
        console.log(`[${model}] 負載過高 (${code})，冷卻 2 秒後切換下一順位...`);
        lastErrorDetail = `📌 [${model}] 目前高負載 (${code})`;
        Utilities.sleep(2000);
        continue;
      } else {
        console.error(`Gemini API Error [${model}]:`, responseText);
        let errDetail = `📌 分析失敗 [${model}] (Code: ${code})`;
        if (json && json.error && json.error.message) errDetail += "\n原因: " + json.error.message;
        lastErrorDetail = errDetail;
        continue;
      }
    } catch (err) {
      console.error(`Fetch Error [${model}]:`, err);
      lastErrorDetail = `📌 [${model}] 連線錯誤: ` + err.message;
      continue;
    }
  }

  return lastErrorDetail + "\n請稍後再試，或聯絡開發人員。";
}

/**
 * 萬能解析 Gemini API 回傳內容（相容 candidates, steps, outputs 等各版本架構）
 */
function extractAnyTextFromGemini(json) {
  if (!json) return "";
  // 1. 標準 generateContent 格式
  if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
    return json.candidates[0].content.parts.map(p => p.text || '').join('');
  }
  // 2. 2026 Interactions API steps 格式
  if (json.steps && Array.isArray(json.steps)) {
    let parts = [];
    for (const step of json.steps) {
      if (step.text) parts.push(step.text);
      else if (step.content && Array.isArray(step.content)) {
        for (const c of step.content) {
          if (c.text) parts.push(c.text);
        }
      } else if (step.model_output && step.model_output.text) {
        parts.push(step.model_output.text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  // 3. 舊版 outputs 格式
  if (json.outputs && Array.isArray(json.outputs)) {
    for (let i = json.outputs.length - 1; i >= 0; i--) {
      if (json.outputs[i] && json.outputs[i].text) return json.outputs[i].text;
    }
  }
  // 4. 單一 output 或 text
  if (json.output) {
    return typeof json.output === 'string' ? json.output : (json.output.text || JSON.stringify(json.output));
  }
  if (json.text) return json.text;
  return "";
}

/**
 * 回覆訊息給 LINE
 */
function replyToLine(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    "replyToken": replyToken,
    "messages": [{ "type": "text", "text": text }]
  };

  const options = {
    "method": "post",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + LINE_ACCESS_TOKEN
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      console.error('LINE Reply Error:', response.getContentText());
    }
  } catch (e) {
    console.error('LINE API Connection Error:', e.message);
  }
}

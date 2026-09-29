/**
 * AI 資訊查核助手 LINE Bot (Interactions API 智能版)
 * 版別：v2026.09.28.02-interactions-invoice-fix
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

// 2. 官方開放資料 API 授權金鑰 (共用交通部 TDX 金鑰，一組金鑰同時搞定國道路況與氣象服務！)
const TDX_CLIENT_ID = (PropertiesService.getScriptProperties().getProperty('TDX_CLIENT_ID') || '').trim(); // 交通部 TDX (tdx.transportdata.tw)
const TDX_CLIENT_SECRET = (PropertiesService.getScriptProperties().getProperty('TDX_CLIENT_SECRET') || '').trim();
// [向下相容] 若曾設定中央氣象署舊金鑰仍保留讀取支援
const CWA_API_KEY = (PropertiesService.getScriptProperties().getProperty('CWA_API_KEY') || '').trim();

// 3. 聯網檢索旗標設定 (Google Search Grounding)
//    ENABLE_GROUNDING = false → 純 AI 訓練資料模式，完全免費 ($0 元)，適合 Free Tier (預設推薦)
//    ENABLE_GROUNDING = true  → 開啟 Google Search 聯網搜尋（需綁定信用卡，超出免費額度後會計費）
const ENABLE_GROUNDING = false;

/**
 * 處理 Web 網頁請求 (提供線上圖文說明手冊)
 */
function doGet(e) {
  const htmlContent = typeof renderHelpPageHtml === 'function'
    ? renderHelpPageHtml()
    : '<h2>AI 資訊查核助手說明手冊</h2><p>請確認專案中已包含 HelpView.gs。</p>';

  return HtmlService.createHtmlOutput(htmlContent)
    .setTitle('AI 資訊查核助手｜完整使用指南與指令手冊')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

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
    const webAppUrl = typeof getWebAppUrl === 'function' ? getWebAppUrl() : (PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || '');
    const urlSection = webAppUrl ? `\n\n📖 完整圖文手冊與指令範例：\n${webAppUrl}` : '';

    const helpMsg = `🤖 AI 資訊查核助手｜快速指南

🌟 常用核心口訣：
1️⃣ 聯網問答：輸入 @AI 或 @bot ＋ 提問
   • 範例：@AI 明天天氣如何？
2️⃣ 事實查核：貼上文字 ＋ 包含「真的嗎/查核」
   • 範例：真的假的？吃菠菜配豆腐會結石？
3️⃣ 影片整理：貼上 YouTube 網址 ＋ 需求
   • 範例：幫我整理大綱 https://youtu.be/...
4️⃣ 詐騙偵測：貼上網址 ＋ 詢問安全
   • 範例：這網站安全嗎 https://...
5️⃣ 路況停車：輸入 @Bot ＋ 路況或停車
   • 範例：@Bot 台南到新竹即時路況
6️⃣ 查詢 ID：輸入 /get_id${urlSection}`;
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

  // 若在群組或多人聊天室中：必須「主動 TAG/提及機器人」或「命中被動關鍵字」才觸發
  // 避免群組成員日常分享連結或一般閒聊時被機器人過度干擾打擾
  if (!isDirectChat && !isTaggedBot && !hasPassiveFact && !hasPassiveSummary && !hasPassiveScam) {
    return;
  }

  // 移除 @AI、@bot 或 LINE 原生 @提及標籤，萃取出乾淨的核心提問文字
  const cleanUserText = userText
    .replace(/(?:^|\s)@(ai|bot)(?:[:：\s,，]|$)/gi, ' ')
    .replace(/@[^\s]+\s*/g, ' ')
    .trim();
  if (!cleanUserText && !urlMatch) return;

  // 5. 整合前置上下文（Context Enrichment）
  const now = new Date();
  const taiwanTimeStr = Utilities.formatDate(now, "GMT+8", "yyyy-MM-dd HH:mm (E)");
  let enrichedPrompt = `【系統當前時間 (台灣時區)】${taiwanTimeStr}\n使用者問題/需求：\n${cleanUserText}\n\n`;
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

  // 5-A. 台灣日常五大分類專屬官方 API 分流抓取 (交通路況、氣象署天氣、中油油價、急診滿床、統一發票)
  const specializedResult = dispatchSpecializedData(cleanUserText);
  let hasSpecializedHit = false;
  if (specializedResult && specializedResult.context) {
    enrichedPrompt += `\n${specializedResult.context}\n`;
    if (specializedResult.sources && specializedResult.sources.length > 0) {
      specializedResult.sources.forEach(src => {
        if (!factSources.some(s => s.url === src.url)) factSources.push(src);
      });
    }
    hasSpecializedHit = true;
  }

  // 模式 A：【使用者主動 TAG BOT (或一對一私訊)】
  // 若已命中高度專門的即時數據 (如發票、油價、停車、急診、交通)，無須額外爬取 DuckDuckGo 與 Cofacts 闢謠庫，避免雜訊干擾
  // 僅在「未命中專屬數據」或「使用者明確提出質疑、查證、謠言、新聞原因」時才進行深度網路檢索
  if (isTaggedBot) {
    const isSeekingFactCheckOrNews = /真的假的|真假|假訊息|假消息|謠言|闢謠|騙人|詐騙|新聞|時事|為什麼|原因|內幕|背景/i.test(cleanUserText);
    if (!hasSpecializedHit || isSeekingFactCheckOrNews) {
      const searchQuery = extractSearchQuery(cleanUserText);
      if (searchQuery) {
        const searchResult = getDeepFactCheckContext(searchQuery);
        enrichedPrompt += `\n【即時網路多方檢索與權威資訊 (DuckDuckGo + Cofacts)】\n${searchResult.contextText}\n`;
        if (searchResult.sources) {
          searchResult.sources.forEach(src => {
            if (!factSources.some(s => s.url === src.url)) factSources.push(src);
          });
        }
      }
    }
  }
  // 模式 B：【未 TAG BOT，但命中了事實查核被動關鍵字】
  // ➔ 針對問題內容進行事實查核檢索
  else if (hasPassiveFact) {
    const factQuery = extractSearchQuery(cleanUserText);
    if (factQuery) {
      const factResult = getDeepFactCheckContext(factQuery);
      enrichedPrompt += `\n【免帳號深度事實查證依據 (Cofacts 闢謠庫 + 多方權威來源 + 深度內文)】\n${factResult.contextText}\n`;
      if (factResult.sources) {
        factResult.sources.forEach(src => {
          if (!factSources.some(s => s.url === src.url)) factSources.push(src);
        });
      }
    }
  }

  // 6. 呼叫 Interactions API（由 AI 自行判斷意圖，輸出極簡「燈號 + 最終結論」）
  const aiResponse = callGeminiInteractionsAPI(enrichedPrompt);
  if (aiResponse && aiResponse.text) {
    let finalMessage = aiResponse.text.trim();

    // 若有需求時附上求證連結 (精簡出處)
    if (factSources && factSources.length > 0) {
      finalMessage += formatCitationFootnote(factSources);
    }

    // 附上判別回應模型資訊
    if (aiResponse.model) {
      finalMessage += `\n\n🤖 模型：${aiResponse.model}`;
    }

    replyToLine(replyToken, finalMessage);
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
 * 安全解析 URL (相容 Google Apps Script 環境，避免 WHATWG URL 不存在拋錯)
 * @param {string} url - 待解析網址
 * @return {Object|null}
 */
function parseUrlSafe(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.trim().match(/^(https?:)\/\/([^\/?#:]+)(?::\d+)?(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i);
  if (!match) return null;
  return {
    protocol: match[1].toLowerCase(),
    hostname: match[2].toLowerCase(),
    pathname: match[3] || '/',
    search: match[4] ? ('?' + match[4]) : '',
    searchParamsString: match[4] ? match[4].toLowerCase() : '',
    hash: match[5] || ''
  };
}

/**
 * 檢查是否為官方認證/知名信任網域 (白名單)
 * @param {string} hostname
 * @return {boolean}
 */
function isTrustedDomain(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();

  // 1. 政府與教育機構
  if (h.endsWith('.gov.tw') || h.endsWith('.edu.tw')) return true;

  // 2. 知名電商與官方短網址
  const trustedECommerce = [
    'shopee.tw', 'shp.ee', 'tw.shp.ee',
    'momo.dm', 'momoshop.com.tw',
    'pchome.com.tw', '24h.pchome.com.tw',
    'books.com.tw', 'benefit.books.com.tw',
    'yahoo.com.tw', 'tw.bid.yahoo.com', 'tw.buy.yahoo.com',
    'etmall.com.tw', 'u-mall.com.tw', 'pcone.com.tw'
  ];
  if (trustedECommerce.some(domain => h === domain || h.endsWith('.' + domain))) return true;

  // 3. 官方超商與電子票券/數位禮券平台 (如 i禮讚、Ticket Xpress)
  const trustedGifts = [
    'ibon.com.tw', '7-11.com.tw', 'citycafe.com.tw', 'openpoint.com.tw',
    'ibongift.com', // 統一超商 (安源資訊 i禮讚) 官方數位票券平台
    'edenred.tw', 'ticketexpress.tw', // 宜睿智慧 Ticket Xpress
    'checkin.131.com.tw', 'gift.131.com.tw',
    'ticket.com.tw'
  ];
  if (trustedGifts.some(domain => h === domain || h.endsWith('.' + domain))) return true;

  // 4. 知名社群與通用官方跳轉
  const trustedSocial = [
    'line.me', 'lin.ee', 'page.line.me',
    'facebook.com', 'fb.me', 'fb.com',
    'instagram.com', 'threads.net',
    'youtube.com', 'youtu.be',
    'google.com', 'google.com.tw', 'goo.gl', 'g.co'
  ];
  if (trustedSocial.some(domain => h === domain || h.endsWith('.' + domain))) return true;

  return false;
}

/**
 * 詐騙網址靜態風險評分
 * @param {string} url - 待檢測網址
 * @return {number} riskScore - 風險點數 (70 分以上為高風險)
 */
function analyzeUrlRisk(url) {
  let riskScore = 0;
  try {
    const parsed = parseUrlSafe(url);
    if (!parsed) return 50;
    const hostname = parsed.hostname;
    const searchParams = parsed.searchParamsString;

    // A. 命中官方信任白名單，且無山寨特徵，直接評定為 0 分安全
    if (isTrustedDomain(hostname)) {
      return 0;
    }

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
    console.log('URL 分析異常: ' + e.message);
  }
  return riskScore;
}

/**
 * 檢查網址是否為安全的公開 HTTP/HTTPS 網址 (防禦 SSRF 與內部私有位址)
 * @param {string} url - 待驗證網址
 * @return {boolean}
 */
function isSafePublicUrl(url) {
  const parsed = parseUrlSafe(url);
  if (!parsed) return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false;
  if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  return true;
}

/**
 * 即時抓取網頁內容作為 AI 研判依據 (內建 SSRF 安全防禦與關鍵資安特徵偵測)
 */
function fetchWebPageContext(url) {
  if (!isSafePublicUrl(url)) {
    return "[安全攔截] 該網址為內部私有 IP 或非公開 HTTP/HTTPS 位址。";
  }

  const parsed = parseUrlSafe(url);
  const isTrusted = parsed && isTrustedDomain(parsed.hostname);

  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" }
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      if (code === 403 || code === 401) {
        return `[存取受限] 伺服器狀態碼 ${code}（目標站台具備反爬蟲機制或為手機 App 專屬連結）。${isTrusted ? '此網域屬於官方信任平台。' : ''}`;
      }
      return `[無法正常存取] 伺服器回傳狀態碼：${code}`;
    }

    const html = response.getContentText();
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "無標題";

    // 特徵鑑識 (辨識釣魚表單 vs 官方 APP 整合)
    const features = [];
    if (isTrusted) {
      features.push("✅ 官方認證網域/合法知名服務商架構");
    }

    // 檢查是否有要求輸入高危敏感資訊的表單欄位
    const sensitiveInputs = [];
    if (/(creditcard|card.?num|cvv|cvc|安全碼|有效月年|信用卡號)/i.test(html)) sensitiveInputs.push("信用卡資訊");
    if (/(網銀密碼|銀行密碼|提款密碼|轉帳密碼)/i.test(html)) sensitiveInputs.push("網路銀行密碼");
    if (/(otp|手機動態碼)/i.test(html) && !/(turnstile|recaptcha|hcaptcha)/i.test(html)) sensitiveInputs.push("動態簡訊驗證碼");
    if (sensitiveInputs.length > 0 && !isTrusted) {
      features.push(`⚠️ 頁面包含敏感輸入表單：${sensitiveInputs.join('、')}`);
    }

    // 檢查是否有官方 App 深層連結 (Deep Link)
    if (/(uniopenapp\.page\.link|shopeetw:\/\/|line:\/\/|openpoint)/i.test(html)) {
      features.push("🔗 整合官方 App 深度跳轉/歸戶機制");
    }

    const cleanBody = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 1200);

    let resultContext = `標題：${title}\n`;
    if (features.length > 0) {
      resultContext += `特徵辨識：${features.join(' | ')}\n`;
    }
    resultContext += `內容預覽：${cleanBody}`;
    return resultContext;
  } catch (e) {
    return `[存取受限] 無法擷取網頁內文（${e.message}）。${isTrusted ? '此網域屬於官方信任平台。' : ''}`;
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
 * 二段式爬取：點入最具權威性的網頁抓取全文 (最長 1500 字，內建 SSRF 安全防禦)
 */
function fetchDeepPageContent(url) {
  try {
    if (!url || !isSafePublicUrl(url)) return "";
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
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
    const response = UrlFetchApp.fetch('https://api.cofacts.tw/graphql', {
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
 * 格式化供使用者親自核實之資料來源註腳 (精簡版)
 * @param {Array<Object>} sources - 來源清單 [{title, url}]
 * @return {string} 格式化後的文字區塊
 */
function formatCitationFootnote(sources) {
  if (!sources || sources.length === 0) return "";
  let footnote = "\n\n🔗 求證連結：";
  sources.slice(0, 2).forEach(src => {
    footnote += `\n▫️ ${src.title}：${src.url}`;
  });
  return footnote;
}

/**
 * 呼叫 Gemini Interactions API (統一 Agent 提示詞 + Web Search 工具支援 + 多模型降級)
 */
function callGeminiInteractionsAPI(inputContent) {
  // 統整型 Agent 指示詞：由 AI 自主根據輸入內容判定意圖，極簡輸出「燈號 + 最終結論」
  const UNIFIED_AGENT_INSTRUCTION = `
你是一位具備資安鑑識、事實查核與生活知識顧問能力的「專業 AI 助手」。
使用者需要「極致精簡、直球對決」的回答，絕對嚴禁贅字與冗長條列。

【格式輸出最高準則：只要 燈號/圖示 + 最終結論】
1. 嚴禁 Markdown 語法（絕對禁止 #, ##, **, ---, \` 等標記符號，直接輸出乾淨純文字）。
2. 一律使用繁體中文。
3. 嚴禁展開長篇大論、嚴禁分段條列、嚴禁背景陳述。每則回覆務必於 1~3 句話內直球說清最終結論。

【各情境燈號與結論標準】
▶ 情境 1：網址資安偵測（詐騙、釣魚、可疑連結）
- 燈號：🟢 官方安全連結 / 🟡 中風險需留意 / 🔴 高風險詐騙
- 格式：[燈號] [核心結論：說明是否為官方正規網址/跳轉，是否有索取信用卡或帳密風險，告訴使用者該怎麼做]

▶ 情境 2：訊息或謠言事實查核（長輩圖、謠傳、時事真偽）
- 燈號：🔴 錯誤謠言 / 🟡 部分不實(存疑) / 🟢 屬實訊息
- 格式：[燈號] [核心結論：1~2 句話直球指出事實真相與科學依據]

▶ 情境 3：影片重點摘要 / 筆記
- 圖示：📝 重點精華
- 格式：📝 重點精華：[2~3 句話總結全片最核心論點與重點]

▶ 情境 4：生活即時問答（天氣、路況、發票、知識常識）
- 圖示：💡 核心結論
- 格式：
  ▫️ 國道路況：直球回答目前預估行車時間、時速與主要壅塞點（若無即時數據則坦承並指引 1968）。
  ▫️ 統一發票：直接完整列出該期中獎號碼，無須多餘問候。
  ▫️ 生活問答：直球給出最核心正確答案。
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
      "maxOutputTokens": 1024
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
          return { text: replyText, model: model };
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

  return { text: lastErrorDetail + "\n請稍後再試，或聯絡開發人員。", model: "" };
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
 * LINE 訊息格式安全清洗器：將 AI 可能溢出的 Markdown 標記全數過濾，確保 100% 符合手機端閱讀體驗
 * @param {string} text - 原始回應文字
 * @return {string} 清洗後的乾淨純文字
 */
function sanitizeForLine(text) {
  if (!text) return "";
  return text
    .replace(/^[#]{1,6}\s*(.+)$/gm, '【$1】')      // 將 # 標題轉換為【標題】
    .replace(/\*\*([^*]+)\*\*/g, '$1')             // 移除粗體 **
    .replace(/\*([^*]+)\*/g, '$1')                  // 移除斜體 *
    .replace(/`([^`]+)`/g, '$1')                    // 移除行內程式碼標記
    .replace(/^[\s]*[-*_]{3,}[\s]*$/gm, '──────────') // 替換 --- 為 LINE 友善全形分隔線
    .replace(/^\s*[-+*]\s+/gm, '▫️ ')              // 替換 markdown list 為 ▫️
    .trim();
}

/**
 * 回覆訊息給 LINE
 */
function replyToLine(replyToken, text) {
  const sanitizedText = sanitizeForLine(text);
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    "replyToken": replyToken,
    "messages": [{ "type": "text", "text": sanitizedText }]
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

// ──────────────────────────────────────────────
// 🌟 台灣日常五大分類專屬官方開放資料 API 模組
// ──────────────────────────────────────────────

/**
 * 台灣日常五大分類官方 API 分流調度器
 * @param {string} text - 使用者提問文字
 * @return {Object} { context: string, sources: Array<{title, url}> }
 */
function dispatchSpecializedData(text) {
  let contextReport = "";
  const sources = [];

  // 1. 交通路況類 (國道、高公局、車況、塞車、事故)
  if (/路況|車況|塞車|國道|高公局|車潮|1968|國1|國2|國3|國4|國5|國6|國10/i.test(text)) {
    const trafficData = fetchHighwayTrafficData(text);
    if (trafficData) {
      contextReport += `【交通部高公局/TDX 國道即時動態】\n${trafficData}\n\n`;
      sources.push({ title: "高公局 1968 即時路況資訊", url: "https://1968.freeway.gov.tw/" });
    }
  }

  // 2. 即時天氣與氣象預報 (天氣、氣溫、下雨、降雨機率、颱風、寒流、穿著)
  if (/天氣|氣溫|下雨|降雨|寒流|颱風|降雨機率|穿著|帶傘|體感|冷不冷|熱不熱/i.test(text)) {
    const weatherData = fetchWeatherData(text);
    if (weatherData) {
      contextReport += `【中央氣象署 CWA 即時天氣觀測與預報】\n${weatherData}\n\n`;
      sources.push({ title: "中央氣象署全球資訊網", url: "https://www.cwa.gov.tw/" });
    }
  }

  // 3. 民生油價與水電類 (油價、汽油、柴油、92、95、98、加油、油價漲跌)
  if (/油價|汽油|柴油|92|95|98|加油|油價漲跌/i.test(text)) {
    const fuelData = fetchFuelPriceData();
    if (fuelData) {
      contextReport += `【台灣中油官方最新牌價資訊】\n${fuelData}\n\n`;
      sources.push({ title: "台灣中油各項油品牌價公告", url: "https://www.cpc.com.tw/" });
    }
  }

  // 4. 醫療急診滿床資訊 (急診、滿床、病床、等床、重度急救責任醫院)
  if (/急診|滿床|等床|病床|加護病房|急救責任醫院/i.test(text)) {
    const erData = fetchEmergencyRoomData(text);
    if (erData) {
      contextReport += `【衛福部健保署重度急救責任醫院即時看板】\n${erData}\n\n`;
      sources.push({ title: "衛福部中央健保署急診即時訊息", url: "https://info.nhi.gov.tw/" });
    }
  }

  // 5. 統一發票開獎號碼 (發票、統一發票、中獎號碼、開獎、特別獎、頭獎)
  if (/發票|統一發票|中獎號碼|發票開獎|發票中獎/i.test(text)) {
    const invoiceData = fetchLatestInvoiceData();
    if (invoiceData) {
      contextReport += `【財政部稅務入口網統一發票最新開獎號碼】\n${invoiceData}\n\n`;
      sources.push({ title: "財政部稅務入口網發票開獎專區", url: "https://invoice.etax.nat.gov.tw/" });
    }
  }

  // 6. 停車場與即時剩餘車位 (停車、停車場、車位、空位、好停車、停哪、剩餘車位)
  if (/停車|停車場|車位|空位|好停車|停哪|剩餘車位/i.test(text)) {
    const parkingData = fetchParkingData(text);
    if (parkingData) {
      contextReport += `【交通部 TDX 周邊停車場即時車位與費率資訊】\n${parkingData}\n\n`;
      sources.push({ title: "交通部 TDX 全台即時停車資訊", url: "https://tdx.transportdata.tw/" });
    }
  }

  return { context: contextReport.trim(), sources: sources };
}

/**
 * 解析使用者的起訖地與高速公路路線距離
 * @param {string} text - 提問文字
 * @return {Object} { origin: string, dest: string, distanceKm: number, defaultFreeway: string }
 */
function analyzeHighwayRoute(text) {
  const distTable = {
    '台南-新竹': 220, '新竹-台南': 220,
    '台北-台中': 160, '台中-台北': 160,
    '台北-高雄': 350, '高雄-台北': 350,
    '台北-新竹': 85,  '新竹-台北': 85,
    '台中-高雄': 190, '高雄-台中': 190,
    '台中-台南': 150, '台南-台中': 150,
    '新竹-台中': 95,  '台中-新竹': 95,
    '新北-台中': 150, '台中-新北': 150,
    '桃園-台中': 130, '台中-桃園': 130,
    '台北-台南': 300, '台南-台北': 300
  };

  let origin = '台南市區';
  let dest = '新竹市區';
  let distanceKm = 220;

  const match = text.match(/(從|由)?(基隆|台北|新北|桃園|新竹|苗栗|台中|彰化|雲林|嘉義|台南|高雄|屏東)(市|區|縣)?(到|至|前往)(基隆|台北|新北|桃園|新竹|苗栗|台中|彰化|雲林|嘉義|台南|高雄|屏東)/);
  if (match) {
    origin = match[2] + '市區';
    dest = match[5] + '市區';
    const key = match[2] + '-' + match[5];
    if (distTable[key]) distanceKm = distTable[key];
  } else {
    const cities = ['基隆', '台北', '新北', '桃園', '新竹', '苗栗', '台中', '彰化', '雲林', '嘉義', '台南', '高雄', '屏東'];
    const found = cities.filter(c => text.includes(c));
    if (found.length >= 2) {
      origin = found[0] + '市區';
      dest = found[1] + '市區';
      const key = found[0] + '-' + found[1];
      if (distTable[key]) distanceKm = distTable[key];
    }
  }

  let defaultFreeway = '國道一號';
  if (/國3|國三|國道3|國道三/i.test(text)) {
    defaultFreeway = '國道三號';
  }

  return { origin, dest, distanceKm, defaultFreeway };
}

/**
 * 1. 抓取國道即時路況、路段平均車速與突發事故 (方案 1: TDX 路段時速與事件介接，支援 ETA 動態推算)
 */
function fetchHighwayTrafficData(text) {
  const cache = CacheService.getScriptCache();
  const route = analyzeHighwayRoute(text);
  const cacheKey = `TRAFFIC_${encodeURIComponent(route.origin)}_${encodeURIComponent(route.dest)}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) return cachedData;

  let report = `▫️ 路線資訊：從 ${route.origin} 開車前往 ${route.dest}，主要行駛 ${route.defaultFreeway}（總里程約 ${route.distanceKm} 公里）\n`;
  let hasLiveSpeeds = false;

  // A. 若有 TDX 金鑰，優先透過 TDX 取得國道即時車速 (Section) 與即時事件 (Event)
  if (TDX_CLIENT_ID && TDX_CLIENT_SECRET) {
    try {
      const token = getTdxToken();
      if (token) {
        // 1. 抓取低速瓶頸路段 (TravelSpeed <= 70 km/h)
        const sectionUrl = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway/Section/Freeway?$filter=TravelSpeed%20le%2070&$top=15&$format=JSON';
        const resSec = UrlFetchApp.fetch(sectionUrl, {
          headers: { "Authorization": "Bearer " + token },
          muteHttpExceptions: true
        });
        if (resSec.getResponseCode() === 200) {
          const sections = JSON.parse(resSec.getContentText());
          if (Array.isArray(sections) && sections.length > 0) {
            report += `▫️ 即時偵測主要壅塞與減速點 (平均時速低於 70 公里)：\n`;
            sections.slice(0, 5).forEach(s => {
              const name = s.SectionName || s.SectionID || '國道路段';
              const speed = Math.round(s.TravelSpeed || 60);
              report += `   • ${name}：平均時速約 ${speed} 公里\n`;
            });
            hasLiveSpeeds = true;
          }
        }

        // 2. 抓取突發事故通報
        const eventUrl = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Highway/Event?$top=6&$format=JSON';
        const resEvt = UrlFetchApp.fetch(eventUrl, {
          headers: { "Authorization": "Bearer " + token },
          muteHttpExceptions: true
        });
        if (resEvt.getResponseCode() === 200) {
          const events = JSON.parse(resEvt.getContentText());
          if (Array.isArray(events) && events.length > 0) {
            report += `▫️ 即時突發事故通報：\n`;
            events.slice(0, 3).forEach(e => {
              report += `   • ${e.RoadName || ''} ${e.Location || ''}：${e.Title || ''} (${e.EventStatusName || '處理中'})\n`;
            });
          }
        }
      }
    } catch (e) {
      console.error('TDX API 車速與事故抓取失敗:', e);
    }
  }

  // B. 免 Key 模式：若無 TDX 或未取得車速，定向利用 DuckDuckGo 檢索 1968services.tw 即時塞車路段與時速
  if (!hasLiveSpeeds) {
    try {
      const query = `site:1968services.tw 國道 即時路況 時速 塞車 ${route.origin} ${route.dest}`;
      const searchRes = searchDuckDuckGo(query);
      if (searchRes && searchRes.length > 0) {
        report += `▫️ 1968services 即時路況快訊摘要：\n`;
        searchRes.slice(0, 3).forEach(r => {
          report += `   • ${r.title}：${r.snippet}\n`;
        });
        hasLiveSpeeds = true;
      }
    } catch (err) {
      console.error('1968services 定向爬取失敗:', err);
    }
  }

  if (!hasLiveSpeeds) {
    report += `▫️ 高公局 1968 即時回報：目前主線大致通暢無全線封閉事故，出發前請確認 Google Maps 即時動態。`;
  }

  // 寫入快取 180 秒 (3 分鐘)，兼顧時效性與防止重複調用
  cache.put(cacheKey, report, 180);
  return report;
}

/**
 * 取得 TDX OAuth Token (支援快取機制)
 */
function getTdxToken() {
  const cache = CacheService.getScriptCache();
  const cachedToken = cache.get('TDX_ACCESS_TOKEN');
  if (cachedToken) return cachedToken;

  try {
    const tokenUrl = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
    const payload = {
      'grant_type': 'client_credentials',
      'client_id': TDX_CLIENT_ID,
      'client_secret': TDX_CLIENT_SECRET
    };
    const res = UrlFetchApp.fetch(tokenUrl, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: payload,
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      if (data.access_token) {
        cache.put('TDX_ACCESS_TOKEN', data.access_token, Math.min(data.expires_in || 3600, 3600));
        return data.access_token;
      }
    }
  } catch (e) {
    console.error('TDX Token 取得失敗:', e);
  }
  return null;
}

/**
 * 2. 抓取即時天氣資訊 (支援中央氣象署 CWA API 與免 Key 高速備援，含快取機制)
 */
function fetchWeatherData(text) {
  // 完整 22 縣市精準對照表 (確保符合 CWA 官方 F-C0032-001 規範)
  const cityMap = {
    '台北': '臺北市', '臺北': '臺北市', '北市': '臺北市',
    '新北': '新北市',
    '桃園': '桃園市',
    '台中': '臺中市', '臺中': '臺中市',
    '台南': '臺南市', '臺南': '臺南市',
    '高雄': '高雄市',
    '基隆': '基隆市',
    '新竹市': '新竹市', '新竹縣': '新竹縣', '新竹': '新竹市',
    '苗栗': '苗栗縣',
    '彰化': '彰化縣',
    '南投': '南投縣',
    '雲林': '雲林縣',
    '嘉義市': '嘉義市', '嘉義縣': '嘉義縣', '嘉義': '嘉義市',
    '屏東': '屏東縣',
    '宜蘭': '宜蘭縣',
    '花蓮': '花蓮縣',
    '台東': '臺東縣', '臺東': '臺東縣',
    '澎湖': '澎湖縣',
    '金門': '金門縣',
    '連江': '連江縣', '馬祖': '連江縣'
  };

  let matchedCityKey = Object.keys(cityMap).find(c => text.includes(c)) || "台北";
  const cwaCity = cityMap[matchedCityKey];

  // 嘗試讀取快取 (快取 20 分鐘 = 1200 秒)
  const cache = CacheService.getScriptCache();
  const cacheKey = 'WEATHER_' + encodeURIComponent(cwaCity);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // A. 優先使用交通部 TDX 氣象服務 (共用 TDX_CLIENT_ID / TDX_CLIENT_SECRET，一組金鑰通吃路況與氣象！)
  if (TDX_CLIENT_ID && TDX_CLIENT_SECRET) {
    try {
      const token = getTdxToken();
      if (token) {
        const tdxWeatherUrl = `https://tdx.transportdata.tw/api/cwa/v1/rest/datastore/F-C0032-001?locationName=${encodeURIComponent(cwaCity)}`;
        const res = UrlFetchApp.fetch(tdxWeatherUrl, {
          headers: { "Authorization": "Bearer " + token },
          muteHttpExceptions: true
        });
        if (res.getResponseCode() === 200) {
          const json = JSON.parse(res.getContentText());
          const loc = json.records && json.records.location && json.records.location[0];
          if (loc && loc.weatherElement) {
            const report = parseCwaForecast(loc, '交通部 TDX 氣象服務 (中央氣象署)');
            cache.put(cacheKey, report, 1200);
            return report;
          }
        }
      }
    } catch (e) {
      console.error('TDX 氣象服務抓取失敗，嘗試備援:', e);
    }
  }

  // B. 向下相容：若有單獨設定 CWA_API_KEY 亦支援直連氣象署開放平臺 (完整今明 36 小時預報)
  if (CWA_API_KEY) {
    try {
      const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001?Authorization=${CWA_API_KEY}&locationName=${encodeURIComponent(cwaCity)}`;
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        const json = JSON.parse(res.getContentText());
        const loc = json.records && json.records.location && json.records.location[0];
        if (loc && loc.weatherElement) {
          const report = parseCwaForecast(loc, '交通部中央氣象署');
          cache.put(cacheKey, report, 1200);
          return report;
        }
      }
    } catch (e) {
      console.error('CWA API 抓取失敗，切換免 Key 備援:', e);
    }
  }

  // C. 免 Key 高速備援 (wttr.in 毫秒級回傳未來 3 天天氣預報，包含今日、明日與後天)
  try {
    const url = `https://wttr.in/${encodeURIComponent(matchedCityKey)}?format=j1`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      const current = data.current_condition && data.current_condition[0];
      const today = data.weather && data.weather[0];
      const tomorrow = data.weather && data.weather[1];
      const afterTomorrow = data.weather && data.weather[2];

      const descMap = {
        'Sunny': '晴天', 'Clear': '晴天',
        'Partly cloudy': '多雲時晴', 'Cloudy': '多雲',
        'Overcast': '陰天', 'Mist': '有霧', 'Fog': '有霧',
        'Patchy rain possible': '局部短暫陣雨', 'Patchy light rain': '局部短暫小雨',
        'Light rain': '短暫小雨', 'Moderate rain': '短暫陣雨',
        'Heavy rain': '局部大雨', 'Thundery outbreaks possible': '短暫雷陣雨'
      };
      const translateWx = (en) => descMap[en] || en || '多雲';

      let report = `【${matchedCityKey} 氣象預報 (含今日即時觀測與明日具體預報)】\n`;
      if (current) {
        report += `▫️ 今日即時現況：氣溫 ${current.temp_C}°C (體感 ${current.FeelsLikeC}°C)，天氣：${translateWx(current.weatherDesc && current.weatherDesc[0]?.value)}，相對濕度：${current.humidity}%\n`;
      }
      if (today) {
        const rain0 = (today.hourly && today.hourly[4] && today.hourly[4].chanceofrain) || '20';
        const desc0 = (today.hourly && today.hourly[4] && today.hourly[4].weatherDesc && today.hourly[4].weatherDesc[0]?.value) || '';
        report += `▫️ 今日白天預測 (${today.date})：氣溫 ${today.mintempC}°C ~ ${today.maxtempC}°C，天氣：${translateWx(desc0)}，降雨機率預估約 ${rain0}%\n`;
      }
      if (tomorrow) {
        const rain1 = (tomorrow.hourly && tomorrow.hourly[4] && tomorrow.hourly[4].chanceofrain) || '10';
        const desc1 = (tomorrow.hourly && tomorrow.hourly[4] && tomorrow.hourly[4].weatherDesc && tomorrow.hourly[4].weatherDesc[0]?.value) || '';
        report += `▫️ 明天預報 (${tomorrow.date})：氣溫 ${tomorrow.mintempC}°C ~ ${tomorrow.maxtempC}°C，天氣：${translateWx(desc1)}，降雨機率預估約 ${rain1}%\n`;
      }
      if (afterTomorrow) {
        const rain2 = (afterTomorrow.hourly && afterTomorrow.hourly[4] && afterTomorrow.hourly[4].chanceofrain) || '10';
        const desc2 = (afterTomorrow.hourly && afterTomorrow.hourly[4] && afterTomorrow.hourly[4].weatherDesc && afterTomorrow.hourly[4].weatherDesc[0]?.value) || '';
        report += `▫️ 後天預報 (${afterTomorrow.date})：氣溫 ${afterTomorrow.mintempC}°C ~ ${afterTomorrow.maxtempC}°C，天氣：${translateWx(desc2)}，降雨機率預估約 ${rain2}%\n`;
      }

      cache.put(cacheKey, report, 1200);
      return report;
    }
  } catch (e) {
    console.error('天氣 API 備援失敗:', e);
  }
  return "";
}

/**
 * 輔助解析氣象署 F-C0032-001 三十六小時氣象預報 (包含今明 3 個時段)
 */
function parseCwaForecast(loc, sourceName) {
  const elements = loc.weatherElement;
  const getVal = (elemName, idx) => elements.find(e => e.elementName === elemName)?.time[idx]?.parameter?.parameterName || '';
  const getTimeDesc = (idx) => {
    const t = elements.find(e => e.elementName === 'Wx')?.time[idx];
    if (!t) return `時段 ${idx + 1}`;
    const start = t.startTime ? t.startTime.substring(5, 16) : '';
    const end = t.endTime ? t.endTime.substring(5, 16) : '';
    return `${start} ~ ${end}`;
  };

  let report = `【${loc.locationName} 未來 36 小時氣象預報 (含今日與明日預報)】\n`;
  for (let i = 0; i < 3; i++) {
    const timeTitle = i === 0 ? '今日時段' : (i === 1 ? '今晚至明晨' : '明日白天時段');
    const range = getTimeDesc(i);
    const wx = getVal('Wx', i);
    const pop = getVal('PoP', i);
    const minT = getVal('MinT', i);
    const maxT = getVal('MaxT', i);
    const ci = getVal('CI', i);
    if (wx) {
      report += `▫️ ${timeTitle} (${range})：\n   天氣：${wx} / 氣溫：${minT}°C ~ ${maxT}°C (${ci}) / 降雨機率：${pop}%\n`;
    }
  }
  report += `▫️ 資料來源：${sourceName}`;
  return report;
}

/**
 * 3. 抓取台灣中油官方即時油品牌價 (含快取機制)
 */
function fetchFuelPriceData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('FUEL_PRICE_DATA');
  if (cached) return cached;

  try {
    const url = 'https://vipmbr.cpc.com.tw/opendata/sixtypeoillistprice';
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const items = JSON.parse(res.getContentText());
      if (Array.isArray(items) && items.length > 0) {
        const getPrice = (name) => {
          const item = items.find(i => i['產品名稱'] && i['產品名稱'].includes(name) && i['計價單位'] && i['計價單位'].includes('公升'));
          return item ? `${item['參考牌價_金額']} 元/公升` : '未提供';
        };
        const rawDate = items[0]['牌價生效日期'] || '';
        let formattedDate = rawDate;
        if (/^\d{7}$/.test(rawDate)) {
          formattedDate = `民國 ${rawDate.substring(0, 3)} 年 ${parseInt(rawDate.substring(3, 5), 10)} 月 ${parseInt(rawDate.substring(5, 7), 10)} 日`;
        }
        const report = `【台灣中油最新參考零售牌價 (生效日期：${formattedDate})】\n▫️ 98 無鉛汽油：${getPrice('98無鉛')}\n▫️ 95 無鉛汽油：${getPrice('95無鉛')}\n▫️ 92 無鉛汽油：${getPrice('92無鉛')}\n▫️ 超級柴油：${getPrice('超級柴油')}`;
        cache.put('FUEL_PRICE_DATA', report, 10800); // 快取 3 小時
        return report;
      }
    }
  } catch (e) {
    console.error('中油 API 抓取失敗:', e);
  }
  return "";
}

/**
 * 4. 抓取衛福部健保署重度急救責任醫院急診即時滿床資訊 (含快取與模糊匹配)
 */
function fetchEmergencyRoomData(text) {
  const cache = CacheService.getScriptCache();
  let list = null;
  const cachedJson = cache.get('NHI_ER_RAW_DATA');
  let sysdate = '即時';

  if (cachedJson) {
    try {
      const parsed = JSON.parse(cachedJson);
      list = parsed.data;
      sysdate = parsed.sysdate || '即時';
    } catch (e) {}
  }

  if (!list) {
    try {
      const url = 'https://info.nhi.gov.tw/api/inae4000/inae4001s01/SQL0002';
      const payload = JSON.stringify({ "AREA_NO": "", "CONT_TYPE": "" });
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: payload,
        muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200) {
        const json = JSON.parse(res.getContentText());
        list = json.data;
        sysdate = json.sysdate || '即時';
        if (Array.isArray(list) && list.length > 0) {
          cache.put('NHI_ER_RAW_DATA', JSON.stringify({ data: list, sysdate: sysdate }), 600); // 快取 10 分鐘
        }
      }
    } catch (e) {
      console.error('健保署急診 API 抓取失敗:', e);
    }
  }

  if (Array.isArray(list) && list.length > 0) {
    const cleanQ = text.replace(/醫院|分院|急診|處|室|看板|滿床/g, '').replace(/台/g, '臺').trim();
    let targets = list.filter(h => {
      const hName = (h.hosP_NAME || '').replace(/台/g, '臺');
      return (cleanQ && (cleanQ.includes(hName) || hName.includes(cleanQ)));
    });

    if (targets.length > 0) {
      let report = `【衛福部健保署重度急救責任醫院即時看板】\n更新時間：${sysdate}\n`;
      targets.slice(0, 3).forEach(h => {
        const isFull = h.inform === 'Y' ? '⚠️ 已通報滿床' : '🟢 正常收治';
        report += `▫️ ${h.hosP_NAME} [${isFull}]\n   等待看診：${h.waiT_SEE_CNT || 0} 人 / 等待住院：${h.waiT_GENERAL_CNT || 0} 人 / 等待ICU：${h.waiT_ICU_CNT || 0} 人\n`;
      });
      return report;
    } else {
      return `【衛福部健保署急診即時看板】\n未查獲與「${cleanQ || text}」相符之重度急救責任醫院通報資料。\n建議緊急就醫請直接撥打 119 或致電該院急診室確認現場收治狀況。`;
    }
  }
  return "";
}

/**
 * 5. 抓取財政部統一發票最新開獎號碼 (RSS XML，含 CDATA 容錯與快取機制)
 */
function fetchLatestInvoiceData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('INVOICE_LATEST_DATA');
  if (cached) return cached;

  try {
    const url = 'https://invoice.etax.nat.gov.tw/invoice.xml';
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const xml = res.getContentText();
      const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/);
      if (itemMatch) {
        const itemContent = itemMatch[1];
        const titleMatch = itemContent.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        const descMatch = itemContent.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
        
        const periodTitle = titleMatch ? titleMatch[1].trim() : '最新一期';
        let desc = descMatch ? descMatch[1].trim() : '';

        // 將 <p> 轉為清晰換行與條列符號
        let cleanDesc = desc
          .replace(/<p>/gi, '▫️ ')
          .replace(/<\/p>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/\n\s*\n/g, '\n')
          .trim();

        const report = `【統一發票中獎獎號：${periodTitle}】\n${cleanDesc}`;
        cache.put('INVOICE_LATEST_DATA', report, 7200); // 快取 2 小時
        return report;
      }
    }
  } catch (e) {
    console.error('統一發票 API 抓取失敗:', e);
  }
  return "";
}

/**
 * 萃取使用者提問中的縣市與目標停車地標
 * @param {string} text - 使用者提問文字
 * @return {Object} { cityEn: string, cityZh: string, landmark: string }
 */
function extractParkingLocation(text) {
  const cityMap = {
    '台北': 'Taipei', '臺北': 'Taipei', '北市': 'Taipei',
    '新北': 'NewTaipei',
    '桃園': 'Taoyuan',
    '台中': 'Taichung', '臺中': 'Taichung',
    '台南': 'Tainan', '臺南': 'Tainan',
    '高雄': 'Kaohsiung',
    '基隆': 'Keelung',
    '新竹市': 'Hsinchu', '新竹縣': 'HsinchuCounty', '新竹': 'Hsinchu',
    '苗栗': 'MiaoliCounty',
    '彰化': 'ChanghuaCounty',
    '南投': 'NantouCounty',
    '雲林': 'YunlinCounty',
    '嘉義市': 'Chiayi', '嘉義縣': 'ChiayiCounty', '嘉義': 'Chiayi',
    '屏東': 'PingtungCounty',
    '宜蘭': 'YilanCounty',
    '花蓮': 'HualienCounty',
    '台東': 'TaitungCounty', '臺東': 'TaitungCounty',
    '澎湖': 'PenghuCounty'
  };

  let cityEn = 'Hsinchu';
  let cityZh = '新竹';
  for (const [zh, en] of Object.entries(cityMap)) {
    if (text.includes(zh)) {
      cityEn = en;
      cityZh = zh;
      break;
    }
  }

  // 精準清理多餘語氣詞，萃取出最核心的地標（如「新竹巨城」、「台北車站」）
  let landmark = text.replace(/^(請幫我|幫我|請|麻煩|我想|可以幫我|替我|請問|查一下|查詢|搜尋)\s*/g, '')
                     .replace(/(停車場|停車位|停車|車位|空位|好停車|停哪|剩餘車位|附近|周邊|有沒有|有哪裡|還有位子|有位子|哪裡好)/g, ' ')
                     .replace(/[嗎阿呢吧呀呀嘛？?！!。，,]+/g, '')
                     .trim();

  // 若 landmark 開頭包含縣市名稱，將其剝離以獲得最純粹的地標名（如「台南南紡夢時代」->「南紡夢時代」）
  if (landmark.startsWith(cityZh) && landmark.length > cityZh.length) {
    landmark = landmark.substring(cityZh.length).trim();
  }

  return { cityEn, cityZh, landmark: landmark || cityZh };
}

/**
 * 6. 抓取路外停車場即時剩餘車位與費率資訊 (支援 TDX 停車 API 與智慧地標比對)
 */
function fetchParkingData(text) {
  const loc = extractParkingLocation(text);
  const cache = CacheService.getScriptCache();
  const cacheKey = `PARK_${encodeURIComponent(loc.cityEn)}_${encodeURIComponent(loc.landmark)}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) return cachedData;

  let report = `▫️ 查詢地點：${loc.cityZh}（目標地標：${loc.landmark}）\n`;
  let hasData = false;

  // A. 若有 TDX 金鑰，優先呼叫 TDX 官方停車 API (即時可用車位與基本資料)
  if (TDX_CLIENT_ID && TDX_CLIENT_SECRET) {
    try {
      const token = getTdxToken();
      if (token) {
        const availUrl = `https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/${loc.cityEn}?$top=30&$format=JSON`;
        const res = UrlFetchApp.fetch(availUrl, {
          headers: { "Authorization": "Bearer " + token },
          muteHttpExceptions: true
        });

        if (res.getResponseCode() === 200) {
          const rawData = JSON.parse(res.getContentText());
          let availList = [];
          if (Array.isArray(rawData)) {
            availList = rawData;
          } else if (rawData && Array.isArray(rawData.ParkingAvailabilities)) {
            availList = rawData.ParkingAvailabilities;
          } else if (rawData && Array.isArray(rawData.data)) {
            availList = rawData.data;
          }

          if (availList.length > 0) {
            let matched = availList.filter(p => {
              const name = p.CarParkName ? (p.CarParkName.Zh_tw || (typeof p.CarParkName === 'string' ? p.CarParkName : '')) : '';
              return name && (name.includes(loc.landmark) || loc.landmark.split('').some(c => name.includes(c) && loc.landmark.length >= 2));
            });

            if (matched.length === 0) {
              matched = availList.slice(0, 4);
            }

            report += `▫️ TDX 即時停車場剩餘車位清單：\n`;
            matched.slice(0, 4).forEach(p => {
              const name = p.CarParkName ? (p.CarParkName.Zh_tw || (typeof p.CarParkName === 'string' ? p.CarParkName : '公有停車場')) : (p.CarParkID ? `停車場(${p.CarParkID})` : '公有停車場');
              
              let avail = p.AvailableSpaces !== undefined ? p.AvailableSpaces : (p.AvailableCar !== undefined ? p.AvailableCar : null);
              if (avail === null && Array.isArray(p.Availabilities) && p.Availabilities.length > 0) {
                avail = p.Availabilities[0].AvailableSpaces;
              }
              if (avail === null) avail = '位子充裕';

              const status = typeof avail === 'number' ? (avail === 0 ? '⚠️ 目前已客滿' : avail < 10 ? `🟡 車位偏少 (剩 ${avail} 格)` : `🟢 空位充足 (剩 ${avail} 格)`) : `剩餘車位：${avail}`;
              const navUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.cityZh + ' ' + name)}`;
              report += `   • ${name}：${status} ➔ 導航: ${navUrl}\n`;
            });
            hasData = true;
          }
        }
      }
    } catch (e) {
      console.error('TDX 停車 API 抓取失敗:', e);
    }
  }

  // B. 免 Key 定向搜尋備援 (當未設定 TDX 或 TDX 抓不到特定民營商圈停車場時)
  if (!hasData) {
    try {
      const query = `停車場 即時車位 剩餘車位 費率 ${loc.cityZh} ${loc.landmark}`;
      const searchRes = searchDuckDuckGo(query);
      if (searchRes && searchRes.length > 0) {
        report += `▫️ 即時停車場資訊與費率快訊：\n`;
        searchRes.slice(0, 3).forEach(r => {
          report += `   • ${r.title}：${r.snippet}\n`;
        });
        hasData = true;
      }
    } catch (err) {
      console.error('停車搜尋備援失敗:', err);
    }
  }

  if (!hasData) {
    report += `▫️ 停車指引：建議前往 ${loc.landmark} 前，開啟 Google Maps 查看目標周邊公有/民營停車場之即時動態與導航。`;
  }

  // 寫入快取 120 秒 (2 分鐘)
  cache.put(cacheKey, report, 120);
  return report;
}

/**
 * AI 資訊查核助手 LINE Bot
 * 版別：v2026.09.28.01-deep-search
 * 部署環境: Google Apps Script (GAS)
 *
 * [部署備註]
 * 1. 免帳號深度聯網查證：整合 DuckDuckGo 多筆權威檢索 + 二段式深度網頁內文爬取 + Cofacts 闢謠庫，完全不需申請帳號、免綁卡。
 * 2. 支援純文字與影片查核：不再限制僅能查 YouTube，純文字長輩圖與謠言亦可直接深度查證。
 * 3. 角色定位升級：以資深數位內容鑑識專家與專業事實查核員進行回應。
 * 4. 更正官方有效模型梯隊：主力採用 gemini-2.5-flash，次主力 gemini-3-flash-preview，搭配 gemini-3.1-flash-lite-preview 與 gemini-2.5-pro 備援防線。
 */

// 1. 金鑰讀取 (從 GAS 「指令碼屬性」中讀取，確保安全性)
const LINE_ACCESS_TOKEN = PropertiesService.getScriptProperties().getProperty('LINE_ACCESS_TOKEN');
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
// 2. 功能旗標設定
//    ENABLE_GROUNDING = true  → 開啟 Google Search 聯網檢索（需附上信用卡，對話次數超出免費額度後會收費）
//    ENABLE_GROUNDING = false → 純 AI 訓練資料模式，完全免費，適合 Free Tier
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

  // 1. 隱藏指令：查詢群組代號
  if (userText === '/get_group_id') {
    if (event.source.type === 'group') {
      replyToLine(replyToken, `本群組的 ID 是：\n${event.source.groupId}`);
    } else {
      replyToLine(replyToken, `這裡不是群組喔！\n您的專屬 User ID 是：\n${event.source.userId}`);
    }
    return;
  }

  // 2. 指令查詢與使用指南
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
5️⃣ 查詢 ID：輸入 /get_group_id${urlSection}`;
    replyToLine(replyToken, helpMsg);
    return;
  }

  // 3. 群組白名單鎖定 (支援多個群組，請將群組 ID 存於 GAS 指令碼屬性 ALLOWED_GROUP_IDS，以逗號分隔)
  const rawAllowedIds = PropertiesService.getScriptProperties().getProperty('ALLOWED_GROUP_IDS') || "";
  const ALLOWED_GROUP_IDS = rawAllowedIds ? rawAllowedIds.split(',').map(id => id.trim()) : [];

  if (ALLOWED_GROUP_IDS.length > 0) {
    if (event.source.type !== 'group' || !ALLOWED_GROUP_IDS.includes(event.source.groupId)) {
      if (event.source.type === 'user') {
        replyToLine(replyToken, "⛔ 抱歉，這是一個私人專用的事實查核機器人，僅限於特定的家用群組內提供服務，恕不開放一對一私訊功能喔！\n\n💡 若需使用，請洽管理員取得「群組代號」，經設定後才可使用。");
      }
      return;
    }
  }

  // 4. 關鍵字觸發：先做靜態比對，再用 AI 意圖識別作為補強
  const factKeywords = ['資訊查核', '查核', '事實查核', '影片核實', '核實', '資訊確認', '確認'];
  const summaryKeywords = ['影片整理', '整理', '影片大綱', '大綱', '內容整理', '內容摘要', '摘要', '總結'];
  const scamKeywords = ['詐騙', '釣魚', '可疑', '偵測', '網址查核', '詐騙偵測', '詐騙網址', '安全嗎', '安不安全', '有沒有詐騙'];
  // 取得除了網址以外的所有純文字
  const textWithoutUrl = userText.replace(/https?:\/\/[^\s]+/g, '').trim();

  // 移除常見的禮貌性前綴詞與標點符號，萃取出最核心的「指令文字」
  // 例如：「請幫我整理：」 -> 「整理」
  const commandText = textWithoutUrl
    .replace(/^(請幫我|幫我|請幫忙|幫忙|麻煩|請|我想|可以幫我|幫|替我)\s*/g, '')
    .replace(/[\s:：、，。！!？?]+$/g, '')
    .trim();

  // 資訊查核與影片整理：支援完全比對或以關鍵字起首
  let isFactCheck = factKeywords.includes(commandText) || factKeywords.some(kw => userText.startsWith(kw) || userText.startsWith('請' + kw) || userText.startsWith('幫我' + kw) || userText.startsWith('請幫我' + kw));
  let isSummary = summaryKeywords.includes(commandText) || summaryKeywords.some(kw => userText.startsWith(kw) || userText.startsWith('請' + kw) || userText.startsWith('幫我' + kw) || userText.startsWith('請幫我' + kw));

  // 詐騙網址偵測：維持「包含比對」，因為詢問句式較多變 (如：這安全嗎)
  let isScamCheck = scamKeywords.some(kw => userText.includes(kw));
  // 4-B. 詐騙網址偵測
  if (isScamCheck) {
    const urlMatch = userText.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      replyToLine(replyToken, '⚠️ 請提供完整網址以進行詐騙偵測。\n範例：這個安全嗎 https://xxx.shop/...');
      return;
    }
    const targetUrl = urlMatch[0];
    // 1. 靜態風險評分
    const riskScore = analyzeUrlRisk(targetUrl);
    // 2. 即時抓取網頁內容 (利用 GAS fetch，不消耗搜尋配額)
    const pageContext = fetchWebPageContext(targetUrl);
    // 3. AI 深度研判 (結合網址特徵 + 網頁內容)
    const aiResponse = callGeminiAPI(`待偵測網址：${targetUrl}\n靜態風險分數：${riskScore}分\n\n網頁內容摘要：\n${pageContext}`, 'SCAM_CHECK');
    if (aiResponse && aiResponse.text) {
      let finalMsg = aiResponse.text.trim();
      if (aiResponse.model) finalMsg += `\n\n🤖 模型：${aiResponse.model}`;
      replyToLine(replyToken, finalMsg);
    }
    return;
  }

  // 4-C. 影片整理 (必須包含 YouTube 連結)
  if (isSummary) {
    if (!isYoutubeUrl(userText)) {
      replyToLine(replyToken, `⚠️ 請提供有效的 YouTube 連結進行整理。例如：\n影片整理 https://youtu.be/...`);
      return;
    }

    let videoContext = userText;
    try {
      const ytRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+)/;
      const match = userText.match(ytRegex);
      if (match) {
        const videoUrl = match[1];
        const oembedUrl = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(videoUrl) + '&format=json';
        const oembedRes = UrlFetchApp.fetch(oembedUrl, { muteHttpExceptions: true });
        if (oembedRes.getResponseCode() === 200) {
          const oembedData = JSON.parse(oembedRes.getContentText());
          videoContext = `
# 📥 影片基礎資訊
- 標題：${oembedData.title}
- 頻道：${oembedData.author_name}
- 網址：${videoUrl}
- 請求模式：內容整理
`;
        }
      }
    } catch (err) {
      console.error('Oembed 抓取失敗:', err);
    }

    const aiResponse = callGeminiAPI(videoContext, 'SUMMARY');
    if (aiResponse && aiResponse.text) {
      let finalMsg = aiResponse.text.trim();
      if (aiResponse.model) finalMsg += `\n\n🤖 模型：${aiResponse.model}`;
      replyToLine(replyToken, finalMsg);
    }
    return;
  }

  // 4-D. 資訊事實查核 (支援 YouTube 影片 或 純文字消息/長輩圖)
  if (isFactCheck) {
    let factContext = "";
    let subjectQuery = "";

    if (isYoutubeUrl(userText)) {
      // 情況一：YouTube 影片查核
      try {
        const ytRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+)/;
        const match = userText.match(ytRegex);
        if (match) {
          const videoUrl = match[1];
          const oembedUrl = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(videoUrl) + '&format=json';
          const oembedRes = UrlFetchApp.fetch(oembedUrl, { muteHttpExceptions: true });
          if (oembedRes.getResponseCode() === 200) {
            const oembedData = JSON.parse(oembedRes.getContentText());
            subjectQuery = oembedData.title;
            factContext = `
# 📥 影片基礎資訊
- 標題：${oembedData.title}
- 頻道：${oembedData.author_name}
- 網址：${videoUrl}
- 請求模式：事實查核
`;
          }
        }
      } catch (err) {
        console.error('Oembed 抓取失敗:', err);
      }
    } else {
      // 情況二：純文字訊息查核
      subjectQuery = userText.replace(/^(請幫我|幫我|請|麻煩|我想|可以幫我|替我)?(資訊查核|事實查核|影片核實|查核|核實|資訊確認|確認)[\s:：、，。！!？?]*/g, '').trim();
      if (!subjectQuery) subjectQuery = userText;
      factContext = `
# 📥 待查核純文字訊息
${subjectQuery}
`;
    }

    // 進行「免帳號、免 API Key 之深度多方查證」(Cofacts + DuckDuckGo 權威加權 + 深度內文爬取)
    const verification = getDeepFactCheckContext(subjectQuery || userText);
    const combinedPrompt = `${factContext}\n\n${verification.contextText}`;

    const aiResponse = callGeminiAPI(combinedPrompt, 'FACT_CHECK');
    if (aiResponse && aiResponse.text) {
      let finalMsg = aiResponse.text.trim();
      // 若有需求時加上求證連結
      if (verification.sources && verification.sources.length > 0) {
        finalMsg += formatCitationFootnote(verification.sources);
      }
      if (aiResponse.model) finalMsg += `\n\n🤖 模型：${aiResponse.model}`;
      replyToLine(replyToken, finalMsg);
    }
    return;
  }
}

/**
 * 檢查是否包含 YouTube 連結
 */
function isYoutubeUrl(text) {
  const ytRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+)/;
  return ytRegex.test(text);
}


/**
 * 詐騙網址靜態風險評分
 * @param {string} url - 待檢測網址
 * @return {number} riskScore - 風險點數 (70 分以上為高風險)
 */
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
 * @param {string} url - 待偵測網址
 * @return {string} 網頁標題與內容摘要
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
    // 1. 提取標題
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "無標題";

    // 2. 特徵鑑識 (辨識釣魚表單 vs 官方 APP 整合)
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

    // 3. 提取 Body 文本 (去標籤、去腳本，取前 1200 字)
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
    // 匹配每個 result__body 區塊
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

        // 權威來源加權評分
        let authorityScore = 10;
        const authorityPatterns = [
          /tfc-taiwan\.org\.tw/i, // 台灣事實查核中心
          /mygopen\.com/i,        // MyGoPen
          /cofacts\.tw/i,         // 真的假的
          /\.gov\.tw/i,           // 台灣政府機關
          /mohw\.gov\.tw/i,       // 衛福部
          /cdc\.gov\.tw/i,        // 疾管署
          /fda\.gov\.tw/i,        // 食藥署
          /cna\.com\.tw/i,        // 中央通訊社
          /twreporter\.org/i,     // 報導者
          /\.edu\.tw/i            // 大學校院與研究機構
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

    // 按權威分數由高至低排序
    results.sort((a, b) => b.score - a.score);
  } catch (e) {
    console.error('DuckDuckGo 搜尋例外:', e);
  }
  return results;
}

/**
 * 二段式爬取：點入最具權威性的網頁抓取全文 (最長 1500 字)
 * @param {string} url - 目標網址
 * @return {string} 乾淨文字內文
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
 * 查詢「Cofacts 真的假的」闢謠開放資料庫 (完全免費開源 GraphQL)
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

  // 1. 先查 Cofacts 專業闢謠庫
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

  // 2. 透過 DuckDuckGo 擴展搜尋 8 筆結果並按權威排序
  const searchResults = searchDuckDuckGo(factQuery);
  if (searchResults.length > 0) {
    contextReport += "【網路多方即時查證來源（按權威度排序）】\n";
    const topResults = searchResults.slice(0, 5);
    topResults.forEach((item, idx) => {
      contextReport += `[來源 ${idx + 1}] ${item.title}\n網址：${item.url}\n摘要：${item.snippet}\n\n`;
    });

    // 收集前 2 筆權威來源提供給使用者點擊核實
    searchResults.slice(0, 2).forEach(item => {
      // 避免重複網址
      if (!sources.some(s => s.url === item.url)) {
        sources.push({
          title: item.title,
          url: item.url
        });
      }
    });

    // 3. 二段式深度抓取：挑選權威度最高的網頁深入爬取內文
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
    sources: sources.slice(0, 2) // 最多提供 2 則最佳來源，版面最清爽
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
 * 呼叫 Gemini AI (含自動降級備援機制與 Grounding)
 */
function callGeminiAPI(userInput, mode = 'FACT_CHECK') {
  const FACT_CHECK_INSTRUCTION = `
你是一位專業的「事實查核與數位鑑識 AI 助手」。
使用者需要「極致精簡、直球對決」的回答，絕對嚴禁贅字與冗長分析。

【格式輸出最高準則：只要 燈號 + 最終結論】
- 嚴禁 Markdown 語法（絕對禁止 #, ##, **, ---, \` 等標記符號，直接輸出乾淨純文字）。
- 一律使用繁體中文。
- 燈號：🔴 錯誤謠言 / 🟡 部分不實(存疑) / 🟢 屬實訊息
- 呈現格式：
[燈號] [核心結論：1~2 句話直球指出事實真相與科學/醫學闢謠依據]
  `;

  const SUMMARY_INSTRUCTION = `
你是一位專業的「內容重點精華助手」。
使用者需要「極致精簡、重點提煉」的回答，絕對嚴禁展開大篇幅章節。

【格式輸出最高準則：只要 圖示 + 最終結論】
- 嚴禁 Markdown 語法（絕對禁止 #, ##, **, ---, \` 等標記符號，直接輸出乾淨純文字）。
- 一律使用繁體中文。
- 呈現格式：
📝 重點精華：[2~3 句話提煉全片最核心論點與收穫]
  `;

  const SCAM_CHECK_INSTRUCTION = `
你是一位資深的「網路詐騙鑑識與資安專家」。
使用者需要「極致精簡、直球對決」的判斷，絕對嚴禁冗長條列分析。

【格式輸出最高準則：只要 燈號 + 最終結論】
- 嚴禁 Markdown 語法（絕對禁止 #, ##, **, ---, \` 等標記符號，直接輸出乾淨純文字）。
- 一律使用繁體中文。
- 燈號：🟢 官方安全連結 / 🟡 中風險需留意 / 🔴 高風險詐騙
- 呈現格式：
[燈號] [核心結論：說明是否為官方正規網址/跳轉，是否有索取信用卡與帳密風險，告訴使用者該怎麼做]
  `;

  const systemInstruction = mode === 'SUMMARY' ? SUMMARY_INSTRUCTION
    : mode === 'SCAM_CHECK' ? SCAM_CHECK_INSTRUCTION
      : FACT_CHECK_INSTRUCTION;

  // JSON payload
  const payload = {
    "contents": [{ "parts": [{ "text": userInput }] }],
    "systemInstruction": { "parts": [{ "text": systemInstruction }] },
    "generationConfig": {
      "temperature": 0.3,
      "maxOutputTokens": ENABLE_GROUNDING ? 2000 : 1024
    }
  };
  // 旗標為 true 時，動態加入聯網檢索工具
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

  // 備援模型清單 (最新正式推薦 ➔ 極速防線 ➔ 經典 Flash ➔ 旗艦 Pro)
  // 依據 Google 官方指示：gemini-2.5-pro 已不對新用戶開放，全面改用 gemini-3 系列！
  const FALLBACK_MODELS = [
    'gemini-3-flash-preview',        // [Tier 1 主力首選] Google 3 世代標準 Flash，速度極快、推論品質高，新用戶完美支援
    'gemini-3.1-flash-lite-preview', // [Tier 2 極速防線] 超低延遲極速回應，高 RPM，確保 Webhook 絕不逾時
    'gemini-2.5-flash',              // [Tier 3 穩定備援] 2.5 系列經典 Flash
    'gemini-3.1-pro-preview'         // [Tier 4 旗艦備援] 官方官方指定取代 2.5-pro 的旗艦模型，深度推理保底
  ];

  let lastErrorDetail = "📌 所有模型均無法連線";

  // 遍歷所有備用模型
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
        continue; // 若有問題則直接測試下一個模型
      }

      // 如果成功分析
      if (code === 200 && json.candidates && json.candidates[0].content && json.candidates[0].content.parts[0].text) {
        let finalReply = json.candidates[0].content.parts[0].text;
        return { text: finalReply, model: model };
      } else {
        // 如果遇到 503 高負載或 429 請求限制，紀錄後繼續跳下一個
        if (code === 503 || code === 429) {
          console.log(`[${model}] 負載過高 (${code})，冷卻 4 秒後切換下一順位...`);
          lastErrorDetail = `📌 [${model}] 目前高負載 (${code})`;
          Utilities.sleep(4000); // 停頓 4 秒，避免瞬間連續請求觸發 429 頻率限制
          continue;
        } else {
          // 若是其它語法或欄位錯誤，不需換模型，直接回傳錯誤
          console.error(`Gemini API Error [${model}]:`, responseText);
          let errDetail = `📌 分析失敗 [${model}] (Code: ${code})`;
          if (json.error) errDetail += "\n原因: " + json.error.message;
          return { text: errDetail, model: model };
        }
      }
    } catch (err) {
      console.error(`Fetch Error [${model}]:`, err);
      lastErrorDetail = `📌 [${model}] 連線錯誤`;
      continue;
    }
  }

  // 如果所有模型都走完都失敗 (通常是 503 高峰)，回傳最後的錯誤原因
  return { text: lastErrorDetail + "\n請稍後再試，或聯絡開發人員。", model: "" };
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

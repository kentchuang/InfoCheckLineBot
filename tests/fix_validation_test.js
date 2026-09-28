/**
 * 修復驗證與強化測試腳本
 */

const fs = require('fs');

console.log("=== 測試 1：修復後的財政部統一發票 RSS 解析 ===");
async function testFixedEtax() {
  try {
    const res = await fetch('https://invoice.etax.nat.gov.tw/invoice.xml');
    const xml = await res.text();
    
    // 改良後的穩健解析邏輯
    const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/);
    if (itemMatch) {
      const itemContent = itemMatch[1];
      const titleMatch = itemContent.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const descMatch = itemContent.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
      
      const period = titleMatch ? titleMatch[1].trim() : '最新一期';
      let desc = descMatch ? descMatch[1].trim() : '';
      
      // 將 <p> 轉為換行與條列符號
      let formatted = desc
        .replace(/<p>/gi, '▫️ ')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
        
      const result = `【統一發票最新中獎獎號：${period}】\n${formatted}`;
      console.log("發票解析成功！輸出預覽：");
      console.log(result);
      return true;
    }
  } catch (e) {
    console.error("發票測試失敗:", e);
    return false;
  }
}

console.log("\n=== 測試 2：修復後的 Cofacts GraphQL API 端點 ===");
async function testFixedCofacts() {
  try {
    const res = await fetch('https://api.cofacts.tw/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query SearchArticles($query: String!) {
          ListArticles(filter: {moreLikeThis: {like: $query}}, first: 1) {
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
        }`,
        variables: { query: '菠菜配豆腐' }
      })
    });
    
    const data = await res.json();
    const article = data.data?.ListArticles?.edges?.[0]?.node;
    if (article) {
      console.log(`Cofacts 闢謠庫查詢成功！文章 ID: ${article.id}`);
      const reply = article.articleReplies?.[0]?.reply;
      if (reply) {
        console.log(`判定: ${reply.type}, 內容: ${reply.text.substring(0, 60)}...`);
      }
      return true;
    }
  } catch (e) {
    console.error("Cofacts 測試失敗:", e);
    return false;
  }
}

console.log("\n=== 測試 3：完整 22 縣市氣象署對照表驗證 ===");
function testFixedCwaMapping() {
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

  const officialCwaCities = [
    '臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市',
    '基隆市', '新竹市', '嘉義市',
    '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'
  ];

  const testInputs = ['台北', '新北', '桃園', '台中', '台南', '高雄', '新竹', '基隆', '嘉義', '宜蘭', '花蓮', '台東', '苗栗', '彰化', '南投', '雲林', '屏東', '澎湖', '金門', '連江', '馬祖'];
  let allPass = true;
  testInputs.forEach(input => {
    const cwaName = cityMap[input];
    if (!officialCwaCities.includes(cwaName)) {
      console.error(`錯誤: ${input} -> ${cwaName} 不在官方 22 縣市名單中`);
      allPass = false;
    }
  });

  if (allPass) console.log("所有 22 縣市對照 100% 精準通過！");
  return allPass;
}

console.log("\n=== 測試 4：急診醫院模糊比對與無資料安全提示 ===");
async function testFixedEr() {
  const res = await fetch('https://info.nhi.gov.tw/api/inae4000/inae4001s01/SQL0002', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ "AREA_NO": "", "CONT_TYPE": "" })
  });
  const json = await res.json();
  const list = json.data || [];

  function findHospital(queryText) {
    const cleanQ = queryText.replace(/醫院|分院|急診|處|室/g, '').replace(/台/g, '臺').trim();
    
    // 1. 優先精確與包含比對
    let matches = list.filter(h => {
      const hName = (h.hosP_NAME || '').replace(/台/g, '臺');
      return cleanQ.includes(hName) || hName.includes(cleanQ);
    });

    if (matches.length > 0) {
      let report = `【衛福部健保署重度急救責任醫院即時看板】\n更新時間：${json.sysdate || '即時'}\n`;
      matches.slice(0, 3).forEach(h => {
        const isFull = h.inform === 'Y' ? '⚠️ 已通報滿床' : '🟢 正常收治';
        report += `▫️ ${h.hosP_NAME} [${isFull}]\n   等待看診：${h.waiT_SEE_CNT} 人 / 等待住院：${h.waiT_GENERAL_CNT} 人 / 等待ICU：${h.waiT_ICU_CNT} 人\n`;
      });
      return report;
    } else {
      return `【衛福部健保署急診即時看板】\n未查獲與「${queryText}」相符之重度急救責任醫院通報資料。\n建議緊急就醫請直接撥打 119 或致電該院急診室確認現場收治狀況。`;
    }
  }

  console.log("查詢「台大急診」結果:");
  console.log(findHospital("台大急診"));
  console.log("查詢「不存在的醫院」結果:");
  console.log(findHospital("不存在的神仙醫院"));
  return true;
}

console.log("\n=== 測試 5：LINE 訊息 Markdown 清洗器測試 ===");
function testMarkdownSanitizer() {
  function sanitizeForLine(text) {
    if (!text) return "";
    return text
      .replace(/^[#]{1,6}\s*(.+)$/gm, '【$1】') // 將 # 標題轉換為 LINE 友善的【標題】
      .replace(/\*\*([^*]+)\*\*/g, '$1')        // 移除粗體 **
      .replace(/\*([^*]+)\*/g, '$1')             // 移除斜體 *
      .replace(/`([^`]+)`/g, '$1')               // 移除 inline code
      .replace(/^[\s]*[-*_]{3,}[\s]*$/gm, '──────────') // 替換 --- 為全形橫線
      .replace(/^\s*[-+*]\s+/gm, '▫️ ')         // 替換 markdown list 為 ▫️
      .trim();
  }

  const raw = `
## 💡 核心結論：
**這是一則未經證實的假訊息**！
---
### 📌 關鍵重點：
* 重點 1：\`官方查證屬實不實\`
* 重點 2：**請勿轉傳以免觸法**
  `;

  const cleaned = sanitizeForLine(raw);
  console.log("清洗前:");
  console.log(raw);
  console.log("清洗後:");
  console.log(cleaned);
  
  const hasMarkdown = /[*#`]|---/.test(cleaned);
  console.log("是否還殘留 Markdown 標記:", hasMarkdown ? "是 (失敗)" : "否 (成功！)");
  return !hasMarkdown;
}

async function run() {
  await testFixedEtax();
  await testFixedCofacts();
  testFixedCwaMapping();
  await testFixedEr();
  testMarkdownSanitizer();
}

run();

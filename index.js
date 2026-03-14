require("dotenv").config({ override: true });
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ============================================================
// 1. 結構化日誌系統
// ============================================================
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO;

function log(level, category, message, extra = null) {
  if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}] [${category}]`;
  const line = extra ? `${prefix} ${message} | ${JSON.stringify(extra)}` : `${prefix} ${message}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

// ============================================================
// 2. 環境變數驗證
// ============================================================
const REQUIRED_ENV = ["DISCORD_BOT_TOKEN", "GEMINI_API_KEY"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    log("ERROR", "STARTUP", `缺少必要環境變數: ${key}，請檢查 .env 檔案`);
    process.exit(1);
  }
}
log("INFO", "STARTUP", "環境變數驗證通過");

// ============================================================
// 初始化 Discord Bot
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================
// 初始化 Gemini API
// ============================================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const DEFAULT_ROLE = "你是一個友善的 Discord 聊天機器人助手。請用繁體中文回覆，回答盡量簡潔有趣。";

const primaryModel = genAI.getGenerativeModel({ model: "gemma-3-27b-it" });
const fallbackModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  systemInstruction: DEFAULT_ROLE,
});

// ============================================================
// 資料儲存
// ============================================================
const userRoles = new Map();     // userId -> 角色描述
const cooldowns = new Map();     // userId -> 上次請求時間
const quizScores = new Map();    // userId -> 分數
const quizActive = new Map();    // userId -> { answer, timestamp }
const COOLDOWN_MS = 5000;
const TIMEOUT_MS = 30000;
const MAX_SESSIONS = 100;        // session 上限
const RETRY_DELAY_MS = 2000;     // 重試延遲

// ============================================================
// 4. 記憶體管理 — LRU Chat Sessions
// ============================================================
class LRUSessionMap {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map(); // userId -> { chat, model, lastUsed }
  }

  get(userId) {
    const session = this.map.get(userId);
    if (session) {
      session.lastUsed = Date.now();
    }
    return session;
  }

  has(userId) {
    return this.map.has(userId);
  }

  set(userId, session) {
    if (this.map.size >= this.maxSize && !this.map.has(userId)) {
      this._evict();
    }
    this.map.set(userId, { ...session, lastUsed: Date.now() });
  }

  delete(userId) {
    return this.map.delete(userId);
  }

  get size() {
    return this.map.size;
  }

  _evict() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, val] of this.map) {
      if (val.lastUsed < oldestTime) {
        oldestTime = val.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.map.delete(oldestKey);
      log("INFO", "MEMORY", `淘汰最久未使用的 session: ${oldestKey}`);
    }
  }
}

const chatSessions = new LRUSessionMap(MAX_SESSIONS);

// ============================================================
// 9. 配額計數持久化
// ============================================================
const QUOTA_FILE = path.join(__dirname, "quota.json");

function loadQuota() {
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8"));
      if (data.lastReset === new Date().toDateString()) {
        log("INFO", "QUOTA", "從檔案恢復配額計數", data);
        return data;
      }
    }
  } catch (err) {
    log("WARN", "QUOTA", "讀取配額檔案失敗，使用預設值", { error: err.message });
  }
  return {
    primary: { used: 0, limit: 14400 },
    fallback: { used: 0, limit: 20 },
    lastReset: new Date().toDateString(),
  };
}

function saveQuota() {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(quotaCounter, null, 2));
  } catch (err) {
    log("WARN", "QUOTA", "儲存配額檔案失敗", { error: err.message });
  }
}

const quotaCounter = loadQuota();

function checkAndResetQuota() {
  const today = new Date().toDateString();
  if (quotaCounter.lastReset !== today) {
    quotaCounter.primary.used = 0;
    quotaCounter.fallback.used = 0;
    quotaCounter.lastReset = today;
    saveQuota();
    log("INFO", "QUOTA", "每日配額已重置");
  }
}

function incrementQuota(model) {
  quotaCounter[model].used++;
  saveQuota();
}

// ============================================================
// 工具函式
// ============================================================

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), ms)
    ),
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUserRole(userId) {
  return userRoles.get(userId) || DEFAULT_ROLE;
}

function createPrimaryChat(userId) {
  const role = getUserRole(userId);
  return primaryModel.startChat({
    history: [
      { role: "user", parts: [{ text: `系統設定：${role}` }] },
      { role: "model", parts: [{ text: "了解！有什麼想聊的嗎？" }] },
    ],
  });
}

function createFallbackChat() {
  return fallbackModel.startChat();
}

// 8. Discord 回覆錯誤處理
async function sendReply(message, reply) {
  try {
    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      const chunks = splitMessage(reply, 2000);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
  } catch (err) {
    log("WARN", "DISCORD", "回覆訊息失敗", {
      error: err.message,
      channel: message.channel?.id,
      code: err.code,
    });
  }
}

function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return chunks;
}

function checkCooldown(userId) {
  const lastTime = cooldowns.get(userId);
  if (lastTime && Date.now() - lastTime < COOLDOWN_MS) {
    return Math.ceil((COOLDOWN_MS - (Date.now() - lastTime)) / 1000);
  }
  return 0;
}

async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const mimeType = response.headers.get("content-type") || "image/png";
  return { base64, mimeType };
}

// ============================================================
// 6. API 重試機制
// ============================================================
function isRetryableError(error) {
  if (error.message === "TIMEOUT") return false;
  if (error.message?.includes("429") || error.message?.includes("quota")) return false;
  if (error.message?.includes("API_KEY")) return false;
  // 網路錯誤、500 等臨時錯誤可重試
  if (error.message?.includes("500") || error.message?.includes("503")) return true;
  if (error.message?.includes("ECONNRESET") || error.message?.includes("ETIMEDOUT")) return true;
  if (error.message?.includes("fetch")) return true;
  return false;
}

async function callWithRetry(fn, retries = 1) {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0 && isRetryableError(error)) {
      log("WARN", "API", `臨時錯誤，${RETRY_DELAY_MS}ms 後重試`, { error: error.message });
      await delay(RETRY_DELAY_MS);
      return callWithRetry(fn, retries - 1);
    }
    throw error;
  }
}

// ============================================================
// AI 對話核心
// ============================================================
async function chatWithAI(userId, userMessage) {
  checkAndResetQuota();

  // 主力模型
  try {
    if (!chatSessions.has(userId)) {
      chatSessions.set(userId, { chat: createPrimaryChat(userId), model: "primary" });
    }
    const session = chatSessions.get(userId);
    const result = await callWithRetry(() =>
      withTimeout(session.chat.sendMessage(userMessage), TIMEOUT_MS)
    );
    incrementQuota("primary");
    log("INFO", "API", "主力模型回覆成功", { userId, model: "gemma-3-27b-it" });
    return result.response.text();
  } catch (primaryError) {
    if (primaryError.message === "TIMEOUT") throw primaryError;
    log("WARN", "API", "主力模型失敗，切換備用", { error: primaryError.message });

    // 備用模型
    try {
      const fallbackChat = createFallbackChat();
      const result = await callWithRetry(() =>
        withTimeout(fallbackChat.sendMessage(userMessage), TIMEOUT_MS)
      );
      chatSessions.set(userId, { chat: fallbackChat, model: "fallback" });
      incrementQuota("fallback");
      log("INFO", "API", "備用模型回覆成功", { userId, model: "gemini-2.5-flash" });
      return result.response.text();
    } catch (fallbackError) {
      throw fallbackError;
    }
  }
}

// ============================================================
// 5. 自動重連 & Discord 事件
// ============================================================
client.once("ready", () => {
  log("INFO", "BOT", `Bot 已上線！登入為 ${client.user.tag}`);
});

client.on("error", (error) => {
  log("ERROR", "DISCORD", "Discord client 錯誤", { error: error.message });
});

client.on("shardDisconnect", (event, shardId) => {
  log("WARN", "DISCORD", `Shard ${shardId} 斷線，將自動重連`, { code: event?.code });
});

client.on("shardReconnecting", (shardId) => {
  log("INFO", "DISCORD", `Shard ${shardId} 正在重連...`);
});

client.on("shardResume", (shardId, replayedEvents) => {
  log("INFO", "DISCORD", `Shard ${shardId} 已恢復連線`, { replayedEvents });
});

client.on("warn", (info) => {
  log("WARN", "DISCORD", info);
});

// ============================================================
// 主要訊息處理
// ============================================================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  // === !help ===
  if (content === "!help") {
    const helpText = [
      "📋 **指令列表**",
      "",
      "💬 **聊天功能**",
      "`!chat <訊息>` — 跟 AI 聊天",
      "`@Bot <訊息>` — 標記我也能聊天",
      "`回覆 Bot 訊息` — 直接回覆繼續對話",
      "`!chat` + 附圖片 — AI 圖片辨識",
      "",
      "🛠️ **工具功能**",
      "`!translate <語言> <內容>` — 翻譯（例：`!translate 英文 你好`）",
      "`!summary` — 摘要目前的對話內容",
      "`!search <關鍵字>` — AI 知識搜尋摘要",
      "`!code <語言> <描述>` — AI 程式碼生成",
      "`!explain <程式碼>` — AI 解釋程式碼",
      "`!model` — 查看目前模型和配額",
      "",
      "🎮 **趣味功能**",
      "`!draw <描述>` — AI 文字藝術創作",
      "`!quiz` — AI 出題小遊戲（`!quiz score` 查分數）",
      "`!fortune` — 每日運勢占卜",
      "",
      "⚙️ **設定功能**",
      "`!role <角色>` — 切換 AI 人設（例：`!role 貓娘`）",
      "`!role` — 查看目前人設",
      "`!role reset` — 恢復預設人設",
      "`!clear` — 清除對話紀錄",
    ].join("\n");
    return sendReply(message, helpText);
  }

  // === !model ===
  if (content === "!model") {
    checkAndResetQuota();
    const session = chatSessions.get(message.author.id);
    const currentModel = session?.model === "fallback" ? "Gemini 2.5 Flash" : "Gemma 3 27B";
    const memUsage = process.memoryUsage();
    const modelText = [
      "🤖 **模型狀態**",
      "",
      `目前使用：**${currentModel}**`,
      "",
      `📊 **Gemma 3 27B**（主力）：${quotaCounter.primary.used} / ${quotaCounter.primary.limit} 次`,
      `📊 **Gemini 2.5 Flash**（備用）：${quotaCounter.fallback.used} / ${quotaCounter.fallback.limit} 次`,
      "",
      `💾 活躍對話：${chatSessions.size} / ${MAX_SESSIONS}`,
      `📦 記憶體：${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
      `🔄 配額每日重置（台灣時間約下午 3:00）`,
    ].join("\n");
    return sendReply(message, modelText);
  }

  // === !role ===
  if (content === "!role") {
    const role = getUserRole(message.author.id);
    return sendReply(message, `🎭 目前人設：${role}`);
  }
  if (content === "!role reset") {
    userRoles.delete(message.author.id);
    chatSessions.delete(message.author.id);
    return sendReply(message, "🎭 已恢復預設人設，對話紀錄已清除！");
  }
  if (content.startsWith("!role ")) {
    const newRole = content.slice(6).trim();
    if (!newRole) return;
    userRoles.set(message.author.id, newRole);
    chatSessions.delete(message.author.id);
    return sendReply(message, `🎭 人設已切換為：**${newRole}**\n對話紀錄已清除，開始新對話！`);
  }

  // === !clear ===
  if (content === "!clear") {
    chatSessions.delete(message.author.id);
    return sendReply(message, "已清除你的對話紀錄！");
  }

  // === !summary ===
  if (content === "!summary") {
    if (!chatSessions.has(message.author.id)) {
      return sendReply(message, "目前沒有對話紀錄可以摘要！");
    }
    await message.channel.sendTyping();
    try {
      const result = await withTimeout(
        chatSessions.get(message.author.id).chat.sendMessage("請用 3-5 個重點摘要我們目前的對話內容。"),
        TIMEOUT_MS
      );
      return await sendReply(message, `📝 **對話摘要**\n\n${result.response.text()}`);
    } catch {
      return sendReply(message, "摘要生成失敗，請稍後再試！");
    }
  }

  // === !translate ===
  if (content.startsWith("!translate ")) {
    const args = content.slice(11).trim();
    const spaceIndex = args.indexOf(" ");
    if (spaceIndex === -1) {
      return sendReply(message, "格式：`!translate <語言> <內容>`\n例如：`!translate 英文 你好嗎`");
    }
    const targetLang = args.slice(0, spaceIndex);
    const textToTranslate = args.slice(spaceIndex + 1).trim();
    if (!textToTranslate) {
      return sendReply(message, "請提供要翻譯的內容！");
    }

    const cooldownLeft = checkCooldown(message.author.id);
    if (cooldownLeft > 0) {
      return sendReply(message, `⏳ 請稍候 ${cooldownLeft} 秒再試！`);
    }
    cooldowns.set(message.author.id, Date.now());
    await message.channel.sendTyping();

    try {
      const prompt = `請將以下內容翻譯成${targetLang}，只回覆翻譯結果，不要其他說明：\n${textToTranslate}`;
      const result = await callWithRetry(() =>
        withTimeout(primaryModel.generateContent(prompt), TIMEOUT_MS)
      );
      incrementQuota("primary");
      return await sendReply(message, `🌐 **${targetLang}翻譯**\n${result.response.text()}`);
    } catch {
      try {
        const prompt = `請將以下內容翻譯成${targetLang}，只回覆翻譯結果：\n${textToTranslate}`;
        const result = await callWithRetry(() =>
          withTimeout(fallbackModel.generateContent(prompt), TIMEOUT_MS)
        );
        incrementQuota("fallback");
        return await sendReply(message, `🌐 **${targetLang}翻譯**\n${result.response.text()}`);
      } catch {
        return sendReply(message, "翻譯失敗，請稍後再試！");
      }
    }
  }

  // === !draw ===
  if (content.startsWith("!draw ")) {
    const prompt = content.slice(6).trim();
    if (!prompt) return sendReply(message, "請描述你想要的畫面！例：`!draw 一隻在月光下的貓`");

    const cooldownLeft = checkCooldown(message.author.id);
    if (cooldownLeft > 0) return sendReply(message, `⏳ 請稍候 ${cooldownLeft} 秒再試！`);
    cooldowns.set(message.author.id, Date.now());
    await message.channel.sendTyping();

    try {
      const drawPrompt = `你是一位文字藝術家。請根據以下描述，創作一幅精美的文字藝術畫（ASCII Art 或 Emoji Art），並加上簡短的藝術描述。描述：${prompt}`;
      const result = await callWithRetry(() =>
        withTimeout(primaryModel.generateContent(drawPrompt), TIMEOUT_MS)
      );
      incrementQuota("primary");
      return await sendReply(message, `🎨 **AI 文字藝術**\n\n${result.response.text()}`);
    } catch {
      try {
        const drawPrompt = `請根據以下描述創作文字藝術畫（ASCII Art 或 Emoji Art）：${prompt}`;
        const result = await callWithRetry(() =>
          withTimeout(fallbackModel.generateContent(drawPrompt), TIMEOUT_MS)
        );
        incrementQuota("fallback");
        return await sendReply(message, `🎨 **AI 文字藝術**\n\n${result.response.text()}`);
      } catch {
        return sendReply(message, "文字藝術創作失敗，請稍後再試！");
      }
    }
  }

  // === !quiz ===
  if (content === "!quiz score") {
    const score = quizScores.get(message.author.id) || 0;
    return sendReply(message, `🏆 你的測驗分數：**${score}** 分`);
  }
  if (content.startsWith("!quiz answer ") || content.startsWith("!quiz a ")) {
    const active = quizActive.get(message.author.id);
    if (!active) return sendReply(message, "你目前沒有進行中的題目！用 `!quiz` 開始新題目。");
    if (Date.now() - active.timestamp > 120000) {
      quizActive.delete(message.author.id);
      return sendReply(message, `⏰ 作答超時！正確答案是：**${active.answer}**`);
    }
    const userAnswer = content.includes("!quiz answer ") ? content.slice(13).trim() : content.slice(8).trim();
    quizActive.delete(message.author.id);
    if (userAnswer.toUpperCase() === active.answer.toUpperCase()) {
      const newScore = (quizScores.get(message.author.id) || 0) + 10;
      quizScores.set(message.author.id, newScore);
      return sendReply(message, `✅ 正確！+10 分，目前總分：**${newScore}** 分`);
    } else {
      return sendReply(message, `❌ 答錯了！正確答案是：**${active.answer}**\n目前分數：**${quizScores.get(message.author.id) || 0}** 分`);
    }
  }
  if (content === "!quiz") {
    const cooldownLeft = checkCooldown(message.author.id);
    if (cooldownLeft > 0) return sendReply(message, `⏳ 請稍候 ${cooldownLeft} 秒再試！`);
    cooldowns.set(message.author.id, Date.now());
    await message.channel.sendTyping();

    try {
      const quizPrompt = `請出一道有趣的選擇題（知識、趣味、冷知識皆可），格式如下：
📝 題目：（題目內容）
A. 選項一
B. 選項二
C. 選項三
D. 選項四

最後另起一行，只寫正確答案的字母，格式為：ANSWER:X（X 為 A/B/C/D）`;
      const result = await callWithRetry(() =>
        withTimeout(primaryModel.generateContent(quizPrompt), TIMEOUT_MS)
      );
      incrementQuota("primary");
      const quizText = result.response.text();
      const answerMatch = quizText.match(/ANSWER:\s*([A-D])/i);
      const answer = answerMatch ? answerMatch[1].toUpperCase() : "A";
      const displayText = quizText.replace(/ANSWER:\s*[A-D]/i, "").trim();
      quizActive.set(message.author.id, { answer, timestamp: Date.now() });
      return await sendReply(message, `🧠 **AI 測驗**\n\n${displayText}\n\n💡 用 \`!quiz a <A/B/C/D>\` 作答（2 分鐘內）`);
    } catch {
      return sendReply(message, "出題失敗，請稍後再試！");
    }
  }

  // === !fortune ===
  if (content === "!fortune") {
    const cooldownLeft = checkCooldown(message.author.id);
    if (cooldownLeft > 0) return sendReply(message, `⏳ 請稍候 ${cooldownLeft} 秒再試！`);
    cooldowns.set(message.author.id, Date.now());
    await message.channel.sendTyping();

    const today = new Date().toISOString().slice(0, 10);
    const seed = `${today}-${message.author.id}`;

    try {
      const fortunePrompt = `你是一位占卜師。請根據種子「${seed}」給出今日運勢，包含：
🌟 今日運勢等級（大吉/中吉/小吉/吉/末吉/凶/大凶）
💼 事業運、💕 感情運、💰 財運（各一句話）
🎯 今日幸運物
⚠️ 今日注意事項
風格要有趣、活潑，帶點幽默。`;
      const result = await callWithRetry(() =>
        withTimeout(primaryModel.generateContent(fortunePrompt), TIMEOUT_MS)
      );
      incrementQuota("primary");
      return await sendReply(message, `🔮 **今日運勢**\n\n${result.response.text()}`);
    } catch {
      try {
        const result = await callWithRetry(() =>
          withTimeout(fallbackModel.generateContent(`請給出今日運勢占卜，包含事業、感情、財運和幸運物。`), TIMEOUT_MS)
        );
        incrementQuota("fallback");
        return await sendReply(message, `🔮 **今日運勢**\n\n${result.response.text()}`);
      } catch {
        return sendReply(message, "占卜失敗，天機不可洩漏...請稍後再試！");
      }
    }
  }

  // === !search ===
  if (content.startsWith("!search ")) {
    const query = content.slice(8).trim();
    if (!query) return sendReply(message, "請輸入搜尋關鍵字！例：`!search 黑洞是什麼`");

    const cooldownLeft = checkCooldown(message.author.id);
    if (cooldownLeft > 0) return sendReply(message, `⏳ 請稍候 ${cooldownLeft} 秒再試！`);
    cooldowns.set(message.author.id, Date.now());
    await message.channel.sendTyping();

    try {
      const searchPrompt = `請針對「${query}」提供詳細的知識摘要，包含：
1. 簡短定義/說明
2. 3-5 個重點
3. 有趣的冷知識（如果有的話）
請用繁體中文回覆，條理清晰。`;
      const result = await callWithRetry(() =>
        withTimeout(primaryModel.generateContent(searchPrompt), TIMEOUT_MS)
      );
      incrementQuota("primary");
      return await sendReply(message, `🔍 **搜尋結果：${query}**\n\n${result.response.text()}`);
    } catch {
      try {
        const result = await callWithRetry(() =>
          withTimeout(fallbackModel.generateContent(`請針對「${query}」提供知識摘要，用繁體中文。`), TIMEOUT_MS)
        );
        incrementQuota("fallback");
        return await sendReply(message, `🔍 **搜尋結果：${query}**\n\n${result.response.text()}`);
      } catch {
        return sendReply(message, "搜尋失敗，請稍後再試！");
      }
    }
  }

  // === !code ===
  if (content.startsWith("!code ")) {
    const args = content.slice(6).trim();
    const spaceIndex = args.indexOf(" ");
    if (spaceIndex === -1) {
      return sendReply(message, "格式：`!code <語言> <描述>`\n例如：`!code python 排序演算法`");
    }
    const lang = args.slice(0, spaceIndex);
    const desc = args.slice(spaceIndex + 1).trim();
    if (!desc) return sendReply(message, "請描述要生成的程式碼！");

    const cooldownLeft = checkCooldown(message.author.id);
    if (cooldownLeft > 0) return sendReply(message, `⏳ 請稍候 ${cooldownLeft} 秒再試！`);
    cooldowns.set(message.author.id, Date.now());
    await message.channel.sendTyping();

    try {
      const codePrompt = `請用 ${lang} 寫出以下功能的程式碼：${desc}
要求：
1. 程式碼放在 \`\`\`${lang} 程式碼區塊中
2. 加上簡短的中文註解
3. 最後簡短說明程式碼的運作方式`;
      const result = await callWithRetry(() =>
        withTimeout(primaryModel.generateContent(codePrompt), TIMEOUT_MS)
      );
      incrementQuota("primary");
      return await sendReply(message, `💻 **${lang} 程式碼生成**\n\n${result.response.text()}`);
    } catch {
      try {
        const result = await callWithRetry(() =>
          withTimeout(fallbackModel.generateContent(`請用 ${lang} 寫出：${desc}。用程式碼區塊格式，加中文註解。`), TIMEOUT_MS)
        );
        incrementQuota("fallback");
        return await sendReply(message, `💻 **${lang} 程式碼生成**\n\n${result.response.text()}`);
      } catch {
        return sendReply(message, "程式碼生成失敗，請稍後再試！");
      }
    }
  }

  // === !explain ===
  if (content.startsWith("!explain ")) {
    const code = content.slice(9).trim();
    if (!code) return sendReply(message, "請提供要解釋的程式碼！例：`!explain console.log('hello')`");

    const cooldownLeft = checkCooldown(message.author.id);
    if (cooldownLeft > 0) return sendReply(message, `⏳ 請稍候 ${cooldownLeft} 秒再試！`);
    cooldowns.set(message.author.id, Date.now());
    await message.channel.sendTyping();

    try {
      const explainPrompt = `請用繁體中文解釋以下程式碼，包含：
1. 這段程式碼的功能
2. 逐行/逐段解釋
3. 使用了哪些重要概念
4. 可能的改進建議

程式碼：
${code}`;
      const result = await callWithRetry(() =>
        withTimeout(primaryModel.generateContent(explainPrompt), TIMEOUT_MS)
      );
      incrementQuota("primary");
      return await sendReply(message, `📖 **程式碼解釋**\n\n${result.response.text()}`);
    } catch {
      try {
        const result = await callWithRetry(() =>
          withTimeout(fallbackModel.generateContent(`請用繁體中文解釋這段程式碼：\n${code}`), TIMEOUT_MS)
        );
        incrementQuota("fallback");
        return await sendReply(message, `📖 **程式碼解釋**\n\n${result.response.text()}`);
      } catch {
        return sendReply(message, "程式碼解釋失敗，請稍後再試！");
      }
    }
  }

  // === 判斷是否為聊天訊息 ===
  let userMessage = null;
  const imageAttachments = message.attachments.filter((att) =>
    att.contentType?.startsWith("image/")
  );

  if (content.startsWith("!chat")) {
    userMessage = content.slice(5).trim();
  } else if (message.mentions.has(client.user)) {
    userMessage = content.replace(/<@!?\d+>/g, "").trim();
  } else if (message.reference) {
    try {
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedMsg.author.id === client.user.id) {
        userMessage = content;
      }
    } catch {}
  }

  if (userMessage === null) return;

  if (!userMessage && imageAttachments.size === 0) {
    return sendReply(message, "請輸入訊息或附上圖片！使用 `!help` 查看指令說明。");
  }

  const cooldownLeft = checkCooldown(message.author.id);
  if (cooldownLeft > 0) {
    return sendReply(message, `⏳ 請稍候 ${cooldownLeft} 秒再試！`);
  }
  cooldowns.set(message.author.id, Date.now());

  await message.channel.sendTyping();

  // === 圖片辨識 ===
  if (imageAttachments.size > 0) {
    try {
      const parts = [];
      for (const [, att] of imageAttachments) {
        const { base64, mimeType } = await fetchImageAsBase64(att.url);
        parts.push({ inlineData: { data: base64, mimeType } });
      }
      parts.push({ text: userMessage || "請描述這張圖片" });

      const result = await callWithRetry(() =>
        withTimeout(fallbackModel.generateContent(parts), TIMEOUT_MS)
      );
      incrementQuota("fallback");
      log("INFO", "API", "圖片辨識成功", { userId: message.author.id });
      return await sendReply(message, result.response.text());
    } catch (error) {
      if (error.message === "TIMEOUT") {
        return sendReply(message, "⏰ 圖片辨識超時，請再試一次！");
      }
      if (error.message?.includes("429") || error.message?.includes("quota")) {
        return sendReply(message, "API 配額已滿！圖片辨識功能暫時無法使用。");
      }
      log("ERROR", "API", "圖片辨識失敗", { error: error.message });
      return sendReply(message, "抱歉，圖片辨識失敗，請稍後再試！");
    }
  }

  // === 純文字聊天 ===
  try {
    const reply = await chatWithAI(message.author.id, userMessage);
    await sendReply(message, reply);
  } catch (error) {
    if (error.message === "TIMEOUT") {
      return sendReply(message, "⏰ AI 回應超時，請再試一次！");
    }
    if (error.message?.includes("429") || error.message?.includes("quota")) {
      return sendReply(message, "所有模型的 API 配額都已滿！請明天再試。");
    }
    log("ERROR", "API", "聊天失敗", { error: error.message, userId: message.author.id });
    return sendReply(message, "抱歉，AI 目前無法回應，請稍後再試！");
  }
});

// ============================================================
// 10. 健康監控（每 5 分鐘）
// ============================================================
const HEALTH_INTERVAL = 5 * 60 * 1000;
const healthTimer = setInterval(() => {
  const mem = process.memoryUsage();
  log("INFO", "HEALTH", "健康狀態報告", {
    sessions: chatSessions.size,
    quotaPrimary: `${quotaCounter.primary.used}/${quotaCounter.primary.limit}`,
    quotaFallback: `${quotaCounter.fallback.used}/${quotaCounter.fallback.limit}`,
    heapMB: Math.round(mem.heapUsed / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    uptime: `${Math.round(process.uptime() / 60)}min`,
  });
}, HEALTH_INTERVAL);

// 定時清理過期冷卻記錄（每 10 分鐘）
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [userId, lastTime] of cooldowns) {
    if (now - lastTime > COOLDOWN_MS * 2) {
      cooldowns.delete(userId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log("DEBUG", "MEMORY", `清理 ${cleaned} 筆過期冷卻記錄`);
  }
}, 10 * 60 * 1000);

// ============================================================
// 7. 全域錯誤捕獲
// ============================================================
process.on("uncaughtException", (error) => {
  log("ERROR", "FATAL", "未捕獲的異常，即將退出", { error: error.message, stack: error.stack });
  shutdown(1);
});

process.on("unhandledRejection", (reason) => {
  log("WARN", "PROMISE", "未處理的 Promise 拒絕", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

// ============================================================
// 3. 優雅關閉
// ============================================================
let isShuttingDown = false;

async function shutdown(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log("INFO", "SHUTDOWN", "正在優雅關閉...");

  clearInterval(healthTimer);
  clearInterval(cleanupTimer);

  saveQuota();
  log("INFO", "SHUTDOWN", "配額已儲存");

  try {
    client.destroy();
    log("INFO", "SHUTDOWN", "Discord client 已登出");
  } catch (err) {
    log("WARN", "SHUTDOWN", "Discord 登出失敗", { error: err.message });
  }

  log("INFO", "SHUTDOWN", "Bot 已關閉，再見！");
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ============================================================
// 啟動 Bot
// ============================================================
log("INFO", "STARTUP", "正在連接 Discord...");
client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
  log("ERROR", "STARTUP", "Discord 登入失敗", { error: err.message });
  process.exit(1);
});

require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const Anthropic = require("@anthropic-ai/sdk");

// --- 初始化 Discord Bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- 初始化 Claude API ---
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 每位使用者的對話紀錄 (記憶體內)
const conversationHistory = new Map();
const MAX_HISTORY = 20; // 每位使用者最多保留 20 則訊息

// --- Bot 上線 ---
client.once("ready", () => {
  console.log(`Bot 已上線！登入為 ${client.user.tag}`);
});

// --- 監聽訊息 ---
client.on("messageCreate", async (message) => {
  // 忽略 bot 自己的訊息
  if (message.author.bot) return;

  // 檢查是否以 !chat 開頭
  if (!message.content.startsWith("!chat ")) return;

  // 取得使用者的問題
  const userMessage = message.content.slice(6).trim();
  if (!userMessage) {
    return message.reply("請在 `!chat` 後面輸入你的問題！例如：`!chat 你好`");
  }

  // 顯示 "正在輸入..." 狀態
  await message.channel.sendTyping();

  try {
    // 取得或建立該使用者的對話紀錄
    const userId = message.author.id;
    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);

    // 加入使用者訊息
    history.push({ role: "user", content: userMessage });

    // 保持對話紀錄在限制內
    while (history.length > MAX_HISTORY) {
      history.shift();
    }

    // 呼叫 Claude API
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system:
        "你是一個友善的 Discord 聊天機器人助手。請用繁體中文回覆，回答盡量簡潔有趣。",
      messages: history,
    });

    const reply = response.content[0].text;

    // 加入助手回覆到對話紀錄
    history.push({ role: "assistant", content: reply });

    // Discord 訊息長度限制為 2000 字元
    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      // 超過長度就分段發送
      const chunks = splitMessage(reply, 2000);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
  } catch (error) {
    console.error("Claude API 錯誤:", error);
    await message.reply("抱歉，AI 目前無法回應，請稍後再試！");
  }
});

// --- !clear 清除對話紀錄 ---
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content !== "!clear") return;

  conversationHistory.delete(message.author.id);
  await message.reply("已清除你的對話紀錄！");
});

// --- 分段訊息工具函式 ---
function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // 找最後一個換行符切割
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return chunks;
}

// --- 啟動 Bot ---
client.login(process.env.DISCORD_BOT_TOKEN);

import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const HF_TOKEN = process.env.HF_TOKEN;

// ===== AI 呼叫 =====
async function askAI(message) {
  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/google/gemma-2b-it",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          inputs: message,
          parameters: {
            max_new_tokens: 200,
            temperature: 0.7
          }
        })
      }
    );

    const data = await response.json();

    if (data.error) {
      console.log("HF Error:", data.error);
      return "AI 目前很忙（免費伺服器排隊中），請稍後再試 🙏";
    }

    return data[0]?.generated_text || "沒有回應";

  } catch (err) {
    console.log("Fetch Error:", err);
    return "連線錯誤，請稍後再試。";
  }
}

// ===== Bot 上線 =====
client.once("ready", () => {
  console.log(`🤖 Bot 已上線：${client.user.tag}`);
});

// ===== 監聽訊息 =====
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!chat")) return;

  const prompt = message.content.replace("!chat", "").trim();

  if (!prompt) {
    return message.reply("請輸入內容，例如：!chat 你好");
  }

  await message.channel.sendTyping();

  const reply = await askAI(prompt);

  message.reply(reply);
});

// ===== 登入 =====
client.login(process.env.DISCORD_TOKEN);

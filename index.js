import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const HF_TOKEN = process.env.HF_TOKEN;

async function askAI(message) {
  const response = await fetch(
    "https://api-inference.huggingface.co/models/HuggingFaceH4/zephyr-7b-beta",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        inputs: message
      })
    }
  );

  const data = await response.json();

  if (data.error) {
    return "AI 暫時忙碌中，請稍後再試。";
  }

  return data[0]?.generated_text || "沒有回應";
}

client.once("ready", () => {
  console.log(`🤖 Bot 已上線：${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!chat")) return;

  const prompt = message.content.replace("!chat", "").trim();

  await message.channel.sendTyping();

  const reply = await askAI(prompt);
  message.reply(reply);
});

client.login(process.env.DISCORD_TOKEN);

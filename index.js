import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let conversations = {};

client.once("ready", () => {
  console.log(`🤖 Bot 已上線：${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!chat")) return;

  const userId = message.author.id;
  const prompt = message.content.replace("!chat", "").trim();

  if (!conversations[userId]) {
    conversations[userId] = [
      { role: "system", content: "你是一個像 ChatGPT 一樣自然、專業的助手。" }
    ];
  }

  conversations[userId].push({
    role: "user",
    content: prompt
  });

  await message.channel.sendTyping();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: conversations[userId]
    });

    const reply = completion.choices[0].message.content;

    conversations[userId].push({
      role: "assistant",
      content: reply
    });

    const chunks = reply.match(/[\s\S]{1,1900}/g);

    for (let chunk of chunks) {
      await message.reply(chunk);
    }

  } catch (error) {
    console.error(error);
    message.reply("發生錯誤，請稍後再試。");
  }
});

client.login(process.env.DISCORD_TOKEN);

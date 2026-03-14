# Discord AI Chatbot

Discord 聊天機器人，使用 Claude API 進行 AI 對話。

## 功能

- `!chat <訊息>` — 與 AI 聊天
- `!clear` — 清除你的對話紀錄
- 每位使用者獨立對話紀錄（最多 20 則）
- 自動分段處理長訊息

## 設定步驟

### 1. 建立 Discord Bot

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)
2. 點擊 **New Application** → 輸入名稱
3. 進入 **Bot** 頁面 → 點擊 **Reset Token** → 複製 Token
4. 開啟以下 **Privileged Gateway Intents**：
   - Message Content Intent
5. 進入 **OAuth2 → URL Generator**：
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`
6. 複製產生的 URL，在瀏覽器開啟，邀請 Bot 到你的伺服器

### 2. 取得 Anthropic API Key

1. 前往 [Anthropic Console](https://console.anthropic.com/)
2. 建立 API Key

### 3. 安裝與執行

```bash
# 安裝依賴
npm install

# 複製環境變數檔案並填入你的 Token
cp .env.example .env
# 編輯 .env 填入 DISCORD_BOT_TOKEN 和 ANTHROPIC_API_KEY

# 啟動 Bot
npm start
```

## 部署到 GitHub + Railway / Render

1. 將程式碼推送到 GitHub
2. 到 [Railway](https://railway.app) 或 [Render](https://render.com) 連結 GitHub repo
3. 設定環境變數 `DISCORD_BOT_TOKEN` 和 `ANTHROPIC_API_KEY`
4. 部署完成後 Bot 就會 24/7 上線

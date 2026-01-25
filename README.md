# cp2nus-telegram-bot

Telegram bot for monitoring EVS2 Consumer Portal (cp2nus.evs.com.sg) A/C credits. Calls the same backend endpoints as the Flutter web app - no brittle DOM scraping.

## Quick Start

```bash
# 1. Setup
cp .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN

# 2. Install
npm install

# 3. Run
npm run dev        # development
npm run build      # production build
npm start          # production run
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | show all commands |
| `/help` | quick help guide |
| `/login <user> <pass>` | log in (DM only; stored in-memory) |
| `/credits` | check balance (money + credits) |
| `/usage [days]` | daily usage breakdown (default: 7d) |
| `/avgspend [days]` | average usage per day (default: 7d) |
| `/predict` | estimate when you'll run out (based on last 7 days) |
| `/rank` | compare usage to neighbors ⚠️ |
| `/topup` | get portal links |
| `/meter` | show meter details |
| `/remind` | toggle daily low-balance alerts (9am) |
| `/logout` | forget credentials |

⚠️ `/rank` currently blocked by API permissions (no bypass found)

## Features

- ⚡ concise, casual responses
- 🔐 in-memory credential storage (not persisted)
- 📊 daily usage tracking and predictions (7-day average)
- 🔔 automatic reminders when < 2 days left (sent at 9am daily)
- 💰 balance and credit monitoring
- 📝 structured logging for debugging
- ✅ production-ready error handling
- 🎯 calls the same backend endpoints as the portal
- 🚀 graceful fallback when detailed history unavailable (uses month-to-date summary)

## Security

- **Secrets:** Store in `.env` only (never commit)
- **Access Control:** Set `TELEGRAM_ALLOWED_USER_IDS` in `.env` to restrict users
- **Login:** `/login` only works in private DMs
- **Storage:** Credentials stored in-memory only (cleared on restart)

## Environment Variables

```bash
TELEGRAM_BOT_TOKEN=your_bot_token          # required
TELEGRAM_ALLOWED_USER_IDS=123456,789012    # optional (comma-separated)
```

## Tech Stack

- Node.js + TypeScript
- Telegraf (Telegram bot framework)
- Native fetch (HTTP client)

## How It Works

See [PROCESS.md](./PROCESS.md) for detailed development process, API reverse engineering, and permission bypass strategy.

## Status

Working commands: **11/12 (92%)**

All commands functional except `/rank` (neighbor comparison), which is blocked by backend API permissions with no alternative endpoint available.

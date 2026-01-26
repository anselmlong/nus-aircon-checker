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
| `/balance` | check current money balance |
| `/usage [days]` | daily usage breakdown (default: 7d) |
| `/avg [days]` | average usage per day (default: 7d) |
| `/predict` | estimate when you'll run out (based on last 7 days) |
| `/rank` | compare usage to neighbors |
| `/topup` | get portal links |
| `/remind` | toggle low-balance alerts (predictive) |
| `/logout` | forget credentials |

## Features

- ⚡ concise, casual responses
- 🔐 in-memory credential storage (not persisted)
- 📊 daily usage tracking and predictions (7-day average)
- 🔔 automatic reminders when < 2 days left (based on usage)
- 💰 balance monitoring with `$` formatting
- 📝 structured logging for debugging
- ✅ production-ready error handling
- 🎯 calls the same backend endpoints as the portal

## Security

- **Secrets:** Store in `.env` only (never commit)
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

See [PROCESS.md](./PROCESS.md) for detailed development process, API reverse engineering, and command details.

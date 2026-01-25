# cp2nus-telegram-bot

Telegram bot wrapper for EVS2 Consumer Portal (cp2nus.evs.com.sg) to view remaining A/C credits.

Implementation note: instead of brittle DOM scraping, it calls the same backend endpoints the Flutter web app uses.

## Setup

1. Create `.env` from `.env.example`.
2. Install deps:

```bash
npm install
```

## Run

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

## bot commands

- `/start` - show all commands
- `/help` - quick help guide
- `/login <user> <pass>` - log in (dm only; stored in-memory)
- `/credits` - check balance (money + credits)
- `/usage [days]` - daily usage breakdown (default: 7d)
- `/avgspend [days]` - average usage per day (default: 7d)
- `/predict` - estimate when you'll run out (based on last 7 days)
- `/rank` - compare usage to neighbors
- `/topup` - get portal links
- `/meter` - show meter details
- `/remind` - toggle daily low-balance alerts (9am)
- `/logout` - forget credentials

## security

- put secrets only in `.env` (never commit it)
- strongly recommended: set `TELEGRAM_ALLOWED_USER_IDS` to restrict access
- note: `/login` takes credentials in chat - always use a private dm with the bot

## features

- ⚡ concise, casual responses
- 🔐 in-memory credential storage (not persisted)
- 📊 daily usage tracking and predictions (7-day average)
- 🔔 automatic reminders when < 2 days left (sent at 9am daily)
- 💰 balance and credit monitoring
- 📝 structured logging for debugging
- ✅ production-ready error handling
- 🎯 calls the same backend endpoints as the portal

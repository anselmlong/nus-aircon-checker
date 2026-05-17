# NUS Aircon Checker

> For those who forget to top-up their aircon and wake up sweaty...

Telegram bot for monitoring EVS2 Consumer Portal (cp2nus.evs.com.sg) A/C credits. Calls the same backend endpoints as the Flutter web app — no brittle DOM scraping.

**Supported venues:** RVRC, Acacia College, Pioneer House, and any residence using the cp2evs system.

Find `@aircon_checker_bot` on Telegram, send `/start` to begin.

---

## Quick Start

```bash
cp .env.example .env
# Set TELEGRAM_BOT_TOKEN in .env
npm install
npm run dev        # development with hot reload
npm run build      # production build
npm start          # production run
```

## Features

- 📱 **Persistent button keyboard** — tap instead of typing commands
- 🔐 **Conversational onboarding** — guided login with security reassurance
- 💰 **Balance monitoring** — check credits with `$` formatting
- 📊 **Daily usage tracking** — breakdowns and 7-day averages
- 📈 **Run-out prediction** — estimate when credits will run out
- 📅 **Daily summaries** — 10am SGT recap with yesterday's usage
- 🔔 **Smart alerts** — notified when balance is low (< $1, < $3, < 2 days)
- 💡 **Eco tips** — gentle sustainability nudges in daily summaries
- 📆 **Monthly spending** — persistent tracking across restarts
- 🏆 **Neighbor comparison** — see how your usage ranks
- ✅ **Production-ready** — structured logging, error handling, TypeScript

## Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `/start` | | welcome message + onboarding |
| `/help` | `/h` | quick help guide |
| `/login <user> <pass>` | `/l` | log in (DM only) |
| `/balance` | `/bal`, `/b` | check current balance |
| `/usage [days]` | `/u` | daily usage breakdown (default: 7d) |
| `/avg [days]` | `/a` | average spend per day |
| `/predict` | `/p` | estimate when you'll run out |
| `/rank` | `/r` | compare usage to neighbors |
| `/spent` | `/m` | monthly spending summary |
| `/topup <amount>` | `/t` | top up via portal link |
| `/remind` | `/rem` | configure reminders |
| `/cancel` | | cancel onboarding |
| `/logout` | `/lo` | forget credentials |

## Security

- **Login:** Restricted to private DMs only
- **Storage:** Credentials encrypted at rest with AES (auto-generated keys)
- **Access:** Optional user ID whitelist via `TELEGRAM_ALLOWED_USER_IDS`
- **Secrets:** `.env` file never committed

## Environment Variables

```bash
TELEGRAM_BOT_TOKEN=your_bot_token          # required
TELEGRAM_ALLOWED_USER_IDS=123456,789012    # optional (comma-separated)
BOT_DEBUG=1                                # optional (verbose logging)
```

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Bot Framework:** Telegraf
- **HTTP Client:** Native fetch (no axios)
- **Storage:** Encrypted file-based (AES)

## Documentation

- [HACKATHON.md](./HACKATHON.md) — Project story, inspiration, and development journey
- [PROCESS.md](./PROCESS.md) — Technical details, API reverse engineering, and architecture

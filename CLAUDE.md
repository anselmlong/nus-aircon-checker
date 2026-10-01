# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run Commands

```bash
npm install          # Install dependencies
npm run dev          # Development with hot reload (tsx watch)
npm run build        # TypeScript compilation to dist/
npm start            # Run production build (node dist/index.js)
```

## Environment Setup

Copy `.env.example` to `.env` and set:
- `TELEGRAM_BOT_TOKEN` (required) - Telegram bot token
- `TELEGRAM_ALLOWED_USER_IDS` (optional) - Comma-separated user IDs for access control
- `ENCRYPTION_KEY` (optional) - At least 16 characters; if absent, the bot creates `.evs-storage.key`

Debug flags: `BOT_DEBUG=1` for bot logging, `EVS_DEBUG=1` for API request logging.

## Architecture

This is a Telegram bot that monitors NUS aircon (EVS2) credits by calling the same backend API as the Flutter web portal (cp2nus.evs.com.sg).

### Core Components

- **`src/index.ts`** - Entry point, loads dotenv and starts bot
- **`src/bot.ts`** - Telegraf bot with command handlers, encrypted credential storage, daily reminder scheduler (10am SGT)
- **`src/evsClient.ts`** - EVS API client for username-only ORE reads, optional password auth, legacy fallback, balances, usage, and rank
- **`src/storage.ts`** - AES-GCM encrypted file storage for credentials, reminders, daily usage, and balance snapshots
- **`src/dnsWarm.ts`** - DNS warm-up helper for EVS hosts
- **`src/config.ts`** - Environment variable parsing and validation
- **`src/mutex.ts`** - Promise-based mutex for serializing concurrent operations

### API Details

The ORE data endpoints use a claim-based `svcClaimDto` containing username, endpoint, scope, target, and operation. Auth is username-only for normal bot use: when no password is provided, `EvsClient.login()` returns guest state `{ token: "guest", userId: 0, username }` and intentionally skips the EVS login API because the ORE data endpoints do not validate Bearer tokens.

Password logins are still supported. If a password is provided, the client authenticates against `https://evs2u.evs.com.sg/login`; disabled legacy accounts can fall back to the legacy NUS portal for balance-only reads.

### Data Flow

1. User sends `/start` or `/login <username>` in DM.
2. Username is validated through balance endpoints, then credentials are encrypted on disk.
3. Data commands call ORE endpoints with guest Bearer state unless a password was supplied.
4. Daily job runs at 10am SGT, snapshots balances, derives balance-delta daily spend, backfills missing API usage, and sends configured summaries or alerts.

### Bot Conventions

- Lowercase, casual response tone
- Currency always formatted with `$` prefix via `formatMoney()`
- `/login` restricted to private DMs only
- Stored credentials are encrypted at rest; protect `ENCRYPTION_KEY` and `.evs-storage.key` because either can decrypt local bot storage

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

Debug flags: `BOT_DEBUG=1` for bot logging, `EVS_DEBUG=1` for API request logging.

## Architecture

This is a Telegram bot that monitors NUS aircon (EVS2) credits by calling the same backend API as the Flutter web portal (cp2nus.evs.com.sg).

### Core Components

- **`src/index.ts`** - Entry point, loads dotenv and starts bot
- **`src/bot.ts`** - Telegraf bot with command handlers, in-memory credential storage, daily reminder scheduler (9am alerts)
- **`src/evsClient.ts`** - EVS API client with Bearer token auth, handles login and all data endpoints
- **`src/config.ts`** - Environment variable parsing and validation
- **`src/mutex.ts`** - Promise-based mutex for serializing concurrent operations

### API Details

The EVS backend uses a claim-based authorization pattern with `svcClaimDto` containing username, endpoint, scope, target, and operation. Key insight: "read" operations have looser permissions than "list" operations. The client uses `withAuthRetry()` to automatically re-authenticate on 403 errors.

### Data Flow

1. User sends `/login` in DM → credentials stored in-memory Map
2. Data commands authenticate via `EvsClient.login()` → returns JWT token
3. API calls use Bearer token, mutex ensures serialization
4. Daily reminder loop checks all opted-in users at 9am, alerts if <2 days credits remain

### Bot Conventions

- Lowercase, casual response tone
- Currency always formatted with `$` prefix via `formatMoney()`
- `/login` restricted to private DMs only
- Credentials cleared on restart (not persisted)

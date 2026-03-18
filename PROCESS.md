# Development Process

## Overview

This bot wraps the EVS2 Consumer Portal (cp2nus.evs.com.sg) backend API to provide Telegram-based A/C credit monitoring. Instead of fragile DOM scraping, it reverse-engineered and calls the same endpoints used by the Flutter web app.

**Timeline:** January 25 - March 18, 2026 (v1.0 → v2.0)

---

## API Discovery & Reverse Engineering

### Initial Approach
1. Inspected network traffic on cp2nus.evs.com.sg (Flutter web app)
2. Identified backend API at `ore.evs.com.sg`
3. Extracted authentication flow and endpoint structure

### Authentication Pattern
- Login endpoint: `https://evs2u.evs.com.sg/login`
- Returns `token` and `userInfo`
- Subsequent requests use a Bearer token in the `Authorization` header

### Working Endpoints (operation: "read")
- `meter_p_credit_balance` — balance and credits
- `meter_p_info` — meter details
- `get_month_to_date_usage` — monthly usage summary
- `get_meter_p_reading_daily` — daily usage history (with read permissions)

### Restricted Endpoints (operation: "list")
Initial testing revealed 403 errors on:
- `meter_p_reading` — raw reading data
- `meter_p_reading_daily` — daily usage history (some accounts)
- Usage rank comparison endpoint

**Root Cause:** Account lacks "list" operation permissions.

### Permission Bypass Solution
Found alternative endpoint: `get_month_to_date_usage`
- Uses `operation: "read"` (not "list")
- Returns month-to-date usage in SGD
- Bypasses permission restrictions

---

## Bot Architecture

### Core Components

**`evsClient.ts`** — API client
- Handles authentication and session management
- Implements all EVS API endpoint wrappers with Bearer token auth
- Handles multi-layer balance fetches (meter vs money)
- Auto-retry with `withAuthRetry()` on 403 errors
- Legacy account fallback for older meter types

**`bot.ts`** — Telegram bot logic (~1100 lines)
- Command handlers for all A/C monitoring features
- Conversational onboarding flow (username → password)
- Persistent ReplyKeyboard with 7 buttons
- 2-tier reminder system (smart alerts + daily summaries)
- Eco tips in daily summaries (~33% chance)
- Shared handler functions to avoid code duplication
- Daily job at 10am SGT with timezone-correct scheduling

**`storage.ts`** — Encrypted credential storage
- AES encryption at rest with auto-generated keys
- Backward-compatible migrations when types change
- Optional in-memory mode for ephemeral deployments
- Graceful handling of decryption failures

**`config.ts`** — Environment configuration
- Telegram bot token
- Optional user whitelist for access control
- Encryption key (optional, auto-generated if missing)

**`mutex.ts`** — Promise-based mutex
- Serializes concurrent API calls to avoid rate limiting
- Used for all authenticated API requests

### Security Considerations
- Credentials encrypted at rest with AES
- `/login` restricted to DMs only
- Optional user ID whitelist via `TELEGRAM_ALLOWED_USER_IDS`
- Secrets via `.env` (never committed)
- No credentials persisted to third-party services

---

## Project Evolution

### v1.0 (Jan 25-27, 2026) — Core Bot
- Basic Telegram bot with Telegraf
- Balance checking, usage breakdown, run-out prediction
- Neighbor usage rank comparison
- Initial reminder system (fixed threshold)
- Short command aliases (/b, /u, /p, /r)
- kWh-credit account support

### v1.1 (Feb 2, 2026) — Encrypted Storage
- Persistent login with encrypted file storage
- Auto-generated encryption keys
- Decryption failure protection (canSave flag)
- Version sync between package.json and help text

### v1.2 (Feb 12-20, 2026) — UX Improvements
- Inline button menu for quick command access
- Monthly spending tracker with persistent daily usage
- Legacy portal fallback for disabled accounts
- Balance selection heuristic improvements
- Better reminder thresholds (usage-based prediction)

### v1.3 (Mar 4, 2026) — Login UX
- Improved login error messages with examples
- Bracket detection (`<user>` vs `user`)
- Developer contact for repeated failures

### v2.0 (Mar 18, 2026) — UX Overhaul
- Persistent ReplyKeyboard (7 buttons, 2-2-2-1 grid)
- Conversational onboarding flow (guided login)
- 2-tier reminder system (smart alerts + daily summaries)
- 10am SGT timezone fix for daily job
- Eco tips in daily summaries
- Sentence case capitalization throughout
- Shared handler functions (eliminated ~270 lines duplication)

---

## Key Technical Decisions

### Why No DOM Scraping
The Flutter web app uses a proper REST API. Scraping the DOM would be fragile and miss the real data structures. Calling the same endpoints directly is more reliable and maintainable.

### Why Native Fetch
No need for axios or other HTTP libraries. Native `fetch` works fine for this use case and adds zero dependencies.

### Why In-Memory + Encrypted File Storage
Credentials need to survive bot restarts for good UX, but shouldn't be stored in plaintext. AES encryption with auto-generated keys provides good security without user setup. In-memory mode is available for ephemeral deployments.

### Why Telegraf
Telegraf provides excellent TypeScript support, middleware chains, and command handling out of the box. It's lightweight and well-maintained.

### Why Simple State Machine for Onboarding
Telegraf's WizardScene requires session middleware and adds complexity. A simple `Map` + `bot.on('text')` handler achieves the same result with less code and no new dependencies.

---

## Command Implementation

### Static Commands (no auth)
- `/start` — conversational onboarding or welcome message
- `/help` — quick help guide
- `/topup` — balance + portal link

### Authentication Commands
- `/login <user> <pass>` — DM-only login (also via conversational flow)
- `/cancel` — abort onboarding
- `/logout` — clear credentials

### Data Commands (require auth)
- `/balance` — current money balance
- `/usage [days]` — daily usage breakdown (default: 7d)
- `/avg [days]` — average spend per day
- `/predict` — run-out estimation
- `/rank` — neighbor usage comparison
- `/spent` — monthly spending summary

### User Features
- `/remind` — configure reminders via inline buttons:
  - **Smart Alerts:** notified when balance is low (< $1, < $3, < 2 days)
  - **Daily Summary:** receive usage recap every morning at 10am SGT
  - **Off:** no reminders

---

## Lessons Learned

1. **"Read" beats "list"** — Backend often has multiple endpoints for same data. "Read" operations typically have looser permissions than "list". Always try all variations.

2. **Graceful degradation** — When full data unavailable, provide month-to-date summary rather than failing completely.

3. **Error messages are UX** — Bracket detection, examples in error messages, and developer contact info all reduce support burden.

4. **Users prefer buttons** — Adding a persistent ReplyKeyboard dramatically improved UX. Most users never type `/` at all now.

5. **Some APIs are browser-only** — The `init_pay` endpoint requires browser cookies/session. Server-side integration was never going to work regardless of headers added.

6. **Timezone handling matters** — Always use explicit UTC offsets, not server-local time, for scheduled jobs.

7. **Storage migrations are critical** — Backward-compatible type migrations prevent data loss when features evolve.

---

## Production Readiness

- ✅ Type-safe TypeScript throughout
- ✅ Structured logging for debugging
- ✅ Comprehensive error handling
- ✅ Encrypted credential storage
- ✅ Automatic daily reminders
- ✅ Conversational onboarding
- ✅ Persistent button keyboard
- ✅ 2-tier reminder system
- ✅ Backward-compatible storage migrations
- ✅ Environment-based configuration
- ✅ Zero external API dependencies

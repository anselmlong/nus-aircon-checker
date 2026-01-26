# Development Process

## Overview

This bot wraps the EVS2 Consumer Portal (cp2nus.evs.com.sg) backend API to provide Telegram-based A/C credit monitoring. Instead of fragile DOM scraping, it reverse-engineered and calls the same endpoints used by the Flutter web app.

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
- `meter_p_credit_balance` - balance and credits
- `meter_p_info` - meter details
- `get_month_to_date_usage` - monthly usage summary

### Restricted Endpoints (operation: "list")
Initial testing revealed 403 errors on:
- `meter_p_reading` - raw reading data
- `meter_p_reading_daily` - daily usage history
- Usage rank comparison endpoint

**Root Cause:** Account lacks "list" operation permissions.

## Permission Bypass Solution

### Discovery
Found alternative endpoint: `get_month_to_date_usage`
- Uses `operation: "read"` (not "list")
- Returns month-to-date usage in SGD
- Bypasses permission restrictions


## Bot Architecture

### Core Components

**`evsClient.ts`** - API client
- Handles authentication and session management
- Implements all EVS API endpoint wrappers with Bearer token auth
- Handles multi-layer balance fetches (meter vs money)

**`bot.ts`** - Telegram bot logic
- Command handlers for automated A/C monitoring
- In-memory credential storage (not persisted)
- Daily reminder system (9am alerts based on usage prediction)
- Centralized currency formatting (prepending `$`)

**`config.ts`** - Environment configuration
- Telegram bot token
- Optional user whitelist for access control

**`mutex.ts`** - Simple mutex for thread-safe operations

### Security Considerations
- Credentials stored in-memory only (cleared on restart)
- `/login` restricted to DMs only
- Optional user ID whitelist via `TELEGRAM_ALLOWED_USER_IDS`
- Secrets via `.env` (never committed)

## Command Implementation

### Static Commands (no auth)
- `/start`, `/help` - documentation
- `/topup` - portal links

### Authentication Commands
- `/login <user> <pass>` - DM-only login
- `/logout` - clear credentials

### Data Commands (require auth)
- `/balance` - check current money balance
- `/usage [days]` - daily breakdown of usage
- `/avg [days]` - average spend per day calculation
- `/predict` - run-out estimation based on current usage
- `/rank` - neighbor usage comparison

### User Features
- `/remind` - send a reminder when credits are low (based on average)
- Alerts sent automatically when < 2 days of credits remain

## Technical Stack

- **Runtime:** Node.js with TypeScript
- **Bot Framework:** Telegraf
- **HTTP Client:** Native fetch
- **Build:** tsc → `dist/`
- **Dev Mode:** tsx watch

## Lessons Learned

1. **Read over List:** Backend often has multiple endpoints for same data - "read" operations typically have looser permissions than "list"
2. **Graceful Degradation:** When full data unavailable, provide month-to-date summary rather than failing completely
3. **Error Handling:** User-friendly error messages, no technical details leaked
4. **Security:** DM-only login, in-memory storage, optional whitelisting

## Production Readiness

- ✅ Structured logging for debugging
- ✅ Comprehensive error handling
- ✅ Type-safe TypeScript throughout
- ✅ Environment-based configuration
- ✅ Automatic daily reminders
- ✅ Concise, casual UX (lowercase responses)

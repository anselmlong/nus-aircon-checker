# NUS Aircon Checker

> For those who forget to top-up their aircon and wake up sweaty.

## Inspiration

Every week, I'd wake up sweaty.

In my dorm, we pay for our own aircon. I've always been lazy about checking the account balance. The only signal I get that it ran out of money is when the aircon stops working.

So yeah... I wake up sweaty.

I hate waking up sweaty.

With some guidance and a bit of copying network requests, I managed to replicate the aircon website's functionality inside Telegram. Now I can:
- Check my balance
- Predict when I'm running out
- Top up before my room turns into a sauna

## What it does

A Telegram bot that monitors your NUS aircon credits (EVS2 Consumer Portal) so you never wake up sweaty again. Instead of manually checking the portal, you can:

- **Check your balance** instantly via Telegram
- **Track daily usage** with breakdowns and averages
- **Predict when you'll run out** based on your usage pattern
- **Get smart alerts** when balance drops below $3, below $1, or < 2 days remain
- **Receive daily summaries** at 10am SGT with your usage recap and occasional eco tips
- **View monthly spending** with persistent tracking across sessions
- **Top up before it's too late** — direct link to the portal

Supported residences: **RVRC, Acacia College, Pioneer House**, and any venue using the cp2evs system.

## How we built it

The Flutter web app at cp2nus.evs.com.sg makes API calls to `ore.evs.com.sg`. Instead of fragile DOM scraping, we **reverse-engineered the network requests** and called the same backend endpoints directly.

**Key technical decisions:**
- **Node.js + TypeScript + Telegraf** — lightweight, type-safe, no framework bloat
- **Native `fetch`** — no axios or extra dependencies
- **Bearer token auth** — same pattern as the Flutter app (login returns JWT, subsequent requests use `Authorization: Bearer`)
- **Encrypted storage** — credentials encrypted at rest with AES, auto-generated keys
- **Permission workaround** — the backend has two permission levels: `read` (looser) and `list` (stricter). We discovered `get_month_to_date_usage` uses `read` permissions, bypassing 403 errors on daily history endpoints.

**Evolution:**

| Phase | Date | What we built |
|-------|------|---------------|
| v1.0 | Jan 25-27, 2026 | Core bot: balance, usage, predict, rank, reminders |
| v1.1 | Feb 2, 2026 | Persistent login with encrypted storage |
| v1.2 | Feb 12-20, 2026 | Inline buttons, monthly spending tracker, legacy account fallback |
| v1.3 | Mar 4, 2026 | Better login error messages |
| v2.0 | Mar 18, 2026 | UX overhaul: persistent keyboard, conversational onboarding, 2-tier reminders, eco tips |

**Architecture:**
- `evsClient.ts` — API client handling auth + all endpoint wrappers
- `bot.ts` — Telegram command handlers, daily reminder scheduler, conversational onboarding, persistent keyboard
- `storage.ts` — Encrypted credential storage with backward-compatible migrations
- `config.ts` — Environment-based configuration
- `mutex.ts` — Promise-based mutex for serializing concurrent API calls

## Challenges we ran into

### 1. Permission denied (403)
The backend's `meter_p_reading_daily` and usage rank endpoints require `list` operation permissions that our accounts don't have. We found alternative endpoints that use `read` permissions instead.

**Lesson:** When APIs have multiple endpoints for similar data, the `read` operation often has looser permissions than `list`. Always try all variations before giving up.

### 2. initPay is browser-only
We tried implementing direct top-up through the API, but `init_pay` always returns 403 server-side (it requires browser cookies/session). After multiple debugging attempts, we pivoted to showing balance + portal link instead.

**Lesson:** Some APIs are browser-only for a reason. Server-side integration was never going to work, no matter how many headers we added.

### 3. Timezone bugs
The daily reminder job used `setHours(9, 0, 0, 0)` which runs on the *server's* timezone, not Singapore time. Fixed with `setUTCHours(2, 0, 0, 0)` (10am SGT = 2am UTC).

### 4. Duplicate handler hell
The original bot had the same logic copy-pasted across `/command` handlers and `callback_query` handlers (~270 lines of duplication). Refactored into shared functions called by both entry points.

### 5. kWh vs money accounts
Some NUS residences use kWh-credit instead of dollar-based billing. Added fallback handling to detect and support both account types.

### 6. Legacy accounts
Some older accounts get 403 on certain endpoints. Added fallback to legacy portal data instead of failing completely.

## Accomplishments that we're proud of

- **Zero external API libraries** — pure `fetch`, no axios, no SDK
- **Reverse-engineered a production API** without any documentation
- **Encrypted credential storage** with automatic key generation and failure protection
- **Graceful degradation** — when full usage data isn't available, the bot falls back to month-to-date summaries instead of crashing
- **Conversational onboarding** — new users get guided through credential entry step-by-step with security reassurances
- **2-tier reminder system** — smart alerts for threshold warnings + daily summaries for routine check-ins
- **Monthly spending tracker** — persistent daily usage tracking across bot restarts
- **Zero new dependencies across all versions** — v1.0 to v2.0, no new npm packages added
- **Backward-compatible storage migrations** — existing user data seamlessly upgraded when types change

## What we learned

1. **"Read" beats "list"** — When APIs have multiple endpoints for similar data, the `read` operation often has looser permissions than `list`. Always try all variations before giving up.

2. **In-memory storage is fine for bots** — Credentials don't need a database. They're cleared on restart anyway (which is a security feature, not a bug). But encrypted persistent storage is even better for UX.

3. **Telegraf's `bot.on('text')` is powerful for conversational flows** — No need for WizardScene or session middleware. A simple `Map` + state machine handles onboarding cleanly.

4. **Users prefer buttons over typing commands** — Adding a persistent ReplyKeyboard dramatically improved UX. Most users never type `/` at all now.

5. **Some APIs are browser-only for a reason** — The `init_pay` endpoint requires browser cookies and session state. Server-side integration was never going to work, no matter how many headers we added.

6. **Error messages are UX** — Bracket detection (`<user>` instead of `user`), examples in error messages, and developer contact info for repeated failures all reduce support burden.

## What's next for NUS Aircon Checker

- **Multi-account support** — Let roommates share a bot instance with separate credential slots
- **Spending analytics** — Weekly/monthly trends, usage graphs, cost projections
- **Smart predictions** — Factor in weekends vs weekdays (usage patterns differ significantly)
- **Group chat mode** — Send summaries to a shared room chat, not just DMs
- **Scheduled top-ups** — Integrate with the portal to auto-top-up when balance is low (if the API allows it)
- **Multi-venue comparison** — Compare usage patterns across different NUS residences

## Tech Stack

- **Runtime:** Node.js with TypeScript
- **Bot Framework:** Telegraf
- **HTTP Client:** Native fetch
- **Storage:** Encrypted file-based (AES, auto-generated keys)
- **Build:** tsc → `dist/`

## Quick Start

```bash
cp .env.example .env
# Set TELEGRAM_BOT_TOKEN in .env
npm install
npm run dev
```

Find `@aircon_checker_bot` on Telegram, send `/start`, and follow the onboarding flow.

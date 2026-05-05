import { Telegraf, type Context } from "telegraf";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { EncryptedStorage, type UserCreds, type UserReminder, type DailyUsageRecord } from "./storage.js";
import { getCreditBalance, getMeterUsage, getUsageRank, analyzeUsage } from "./services/ore.js";
import { detectHostelType } from "./utils/hostelDetect.js";
import { isValidAmount, isValidMeterId } from "./utils/validation.js";

// Eco tips for daily summaries (~33% chance of showing)
const ECO_TIPS: string[] = [
  "💡 Setting your AC to 25°C saves ~15% energy compared to 22°C",
  "💡 A clean AC filter improves efficiency by up to 10%",
  "💡 Using a fan with AC lets you set it 2°C higher for the same comfort",
  "💡 Closing curtains during the day keeps rooms cooler naturally",
  "💡 Each degree lower on your AC adds ~3-5% to your energy bill",
  "💡 Turn off AC 10 minutes before leaving — it stays cool longer than you think",
  "💡 Regular AC servicing can reduce energy consumption by 15-20%",
  "💡 Open windows in the evening to cool your room for free",
  "💡 AC works harder when doors are left open — keep them closed",
  "💡 Sleep mode on AC can save 10-20% overnight energy",
  "💡 Heat from appliances makes AC work harder — use them in the evening",
  "💡 Good insulation means your AC doesn't have to run as long",
];

function isAllowedUser(userId: number | undefined): boolean {
  if (!userId) return false;
  const allowed = config.telegram.allowedUserIds;
  if (allowed.length === 0) return true;
  return allowed.includes(userId);
}

export function startBot(): void {
  const bot = new Telegraf(config.telegram.token);

  const getOrCreateEncryptionKey = (): string => {
    if (config.encryptionKey && config.encryptionKey.length > 0) return config.encryptionKey;

    const keyPath = ".evs-storage.key";
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath, "utf8").trim();
      if (existing.length > 0) return existing;
    }

    const key = randomBytes(32).toString("base64");
    writeFileSync(keyPath, key + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Best-effort permissions.
    }
    return key;
  };

  const storage = new EncryptedStorage(getOrCreateEncryptionKey());
  const inMemoryCreds = new Map<number, UserCreds>();
  const inMemoryReminders = new Map<number, UserReminder>();
  const onboardingState = new Map<number, { step: "meterId"; chatId: number }>();
  const topupState = new Set<number>();

  function completeLogin(userId: number, meterId: string, chatId?: number): void {
    userCreds.set(userId, { meterId });
    if (typeof chatId === "number") {
      const existing = userReminders.get(userId);
      userReminders.set(userId, { chatId, level: existing?.level ?? "off" });
    }
    console.log(`[login] user ${userId} logged in with meter ${meterId}`);
    if (!storage.getHostelType(userId)) {
      detectHostelType(meterId)
        .then((ht) => storage.setHostelType(userId, ht))
        .catch(() => {});
    }
  }

  const userCreds = {
    get: (userId: number) => storage?.getCreds(userId) ?? inMemoryCreds.get(userId),
    set: (userId: number, creds: UserCreds) => {
      if (storage) storage.setCreds(userId, creds);
      else inMemoryCreds.set(userId, creds);
    },
    delete: (userId: number) => {
      if (storage) storage.deleteCreds(userId);
      else inMemoryCreds.delete(userId);
    },
  };

  const userReminders = {
    get: (userId: number) => storage?.getReminder(userId) ?? inMemoryReminders.get(userId),
    set: (userId: number, reminder: UserReminder) => {
      if (storage) storage.setReminder(userId, reminder);
      else inMemoryReminders.set(userId, reminder);
    },
    entries: () => storage?.getAllReminders().entries() ?? inMemoryReminders.entries(),
    size: () => storage?.getAllReminders().size ?? inMemoryReminders.size,
  };

  const BOT_DEBUG = process.env.BOT_DEBUG === "1";

  const PERSISTENT_KEYBOARD = {
    keyboard: [
      [{ text: "💰 Balance" }, { text: "📊 Usage" }],
      [{ text: "📈 Predict" }, { text: "💸 Monthly" }],
      [{ text: "🏆 Rank" }, { text: "💳 Top Up" }],
      [{ text: "🔔 Reminders" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };

  console.log("[bot] starting up...");
  storage.load();
  console.log("[bot] persistent storage enabled");
  console.log("[bot] allowed user ids:", config.telegram.allowedUserIds.length > 0 ? config.telegram.allowedUserIds : "any");

  bot.use((ctx, next) => {
    const msg = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
    if (msg?.startsWith("/")) {
      const cmd = msg.split(/\s+/)[0];
      const safeCmd = cmd === "/login" ? "/login" : msg.slice(0, 50);
      console.log("[cmd]", {
        cmd: safeCmd,
        user: ctx.from?.id,
        chat: ctx.chat?.id,
        ts: new Date().toISOString(),
      });
    }
    return next();
  });

  const getCreds = (userId: number | undefined): UserCreds | undefined => {
    if (!userId) return undefined;
    return userCreds.get(userId);
  };

  bot.catch((err, ctx) => {
    // Avoid leaking details into chat; log locally.
    console.error("[bot error]", {
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      updateId: ctx.update.update_id,
      from: ctx.from?.id,
      chat: ctx.chat?.id,
      timestamp: new Date().toISOString(),
    });
    // Inform user without leaking error details
    ctx.reply("Oops, something went wrong. Try again?").catch(() => {
      // Silent fail if we can't even send error message
    });
  });

  bot.start(async (ctx) => {
    const isLoggedIn = !!getCreds(ctx.from?.id);
    const isPrivate = ctx.chat?.type === "private";

    const welcomeLines = [
      "Welcome to Aircon Checker Bot! 👋",
      "",
      "I help you track your aircon credits at NUS residences.",
      "",
      "📍 Supported venues:",
      "• RVRC",
      "• Acacia College",
      "• Pioneer House",
      "• Any residence using the cp2evs system",
      "",
      "📊 Commands:",
      "  Check: /balance, /usage, /predict, /rank, /spent",
      "  Manage: /login, /remind, /logout",
    ];

    if (isLoggedIn) {
      welcomeLines.push("", "Tap a button or use a command to get started.");
      await ctx.reply(welcomeLines.join("\n"), isPrivate ? { reply_markup: PERSISTENT_KEYBOARD } : undefined);
    } else if (isPrivate) {
      // Clear any existing onboarding state (restart flow)
      if (ctx.from?.id) onboardingState.delete(ctx.from.id);

      welcomeLines.push(
        "",
        "To get started, I need your meter ID.",
        "It's the 8-digit number on the sticker at your aircon unit.",
        "",
        "What's your meter ID?",
      );
      await ctx.reply(welcomeLines.join("\n"));

      if (ctx.from?.id && typeof ctx.chat?.id === "number") {
        onboardingState.set(ctx.from.id, { step: "meterId", chatId: ctx.chat.id });
      }
    } else {
      await ctx.reply(welcomeLines.join("\n"));
    }
  });

  bot.command("cancel", async (ctx) => {
    if (ctx.from?.id) {
      onboardingState.delete(ctx.from.id);
      topupState.delete(ctx.from.id);
    }
    await ctx.reply("Cancelled. Send /start to begin again.");
  });

  bot.command(["help", "h"], async (ctx) => {
    await ctx.reply(
      [
        "Aircon Checker Bot v2.0",
        "",
        "DM me /login <meter_id> to log in.",
        "/b or /bal - check balance",
        "/u [days] - daily usage breakdown",
        "/m or /spent - total spent this month",
        "/p - predict when you'll run out",
        "/r - compare to neighbors",
        "/t - top up via portal link",
        "/rem - toggle low balance alerts (off by default)",
        "/lo - clear login (re-login with /login <meter_id>)",
        "",
        "Or just tap the buttons below!",
        "",
        "Changes in v2.0: persistent buttons, daily summaries, eco tips",
        "",
        "Developed by @anselmlong",
        "Feel free to text if the bot breaks!",
      ].join("\n"),
    );
  });

  function parseIntArg(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) return undefined;
    return Math.floor(n);
  }

  async function ensureAuthed(ctx: Context): Promise<UserCreds | undefined> {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("Not authorized");
      return undefined;
    }

    const creds = getCreds(ctx.from?.id);
    if (!creds) {
      await ctx.reply("Not logged in. DM me /login <meter_id>");
      return undefined;
    }

    // Remember where to send reminders (private chats only).
    if (ctx.from?.id && typeof ctx.chat?.id === "number") {
      const existing = userReminders.get(ctx.from.id);
      userReminders.set(ctx.from.id, {
        chatId: ctx.chat.id,
        level: existing?.level ?? "off",
      });
    }

    return creds;
  }

  function formatMoney(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  function buildPredictionLine(balance: number, avgPerDay: number): string {
    if (!(avgPerDay > 0)) return "No usage data yet";
    const daysLeft = balance / avgPerDay;
    if (!Number.isFinite(daysLeft)) return "Can't estimate run-out";
    if (daysLeft < 1) return `⚠️ Running out soon (~${Math.max(0, daysLeft).toFixed(1)} days left)`;
    if (daysLeft < 2) return `Heads up: ~${daysLeft.toFixed(1)} days left`;
    return `~${daysLeft.toFixed(1)} days left`;
  }

  // Shared handler functions — used by both bot.command() and bot.hears()
  async function handleBalance(ctx: Context, creds: UserCreds): Promise<void> {
    try {
      const bal = await getCreditBalance(creds.meterId);
      await ctx.reply(`💰 ${formatMoney(bal ?? 0)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Couldn't fetch balance: ${msg}`);
      console.error("[balance] failed:", { userId: ctx.from?.id, error: msg });
    }
  }

  async function handleUsage(ctx: Context, creds: UserCreds, days: number = 7): Promise<void> {
    try {
      const [bal, usage] = await Promise.all([
        getCreditBalance(creds.meterId),
        getMeterUsage(creds.meterId, days),
      ]);

      const balance = bal ?? 0;
      const analyzed = analyzeUsage(usage.history, bal);
      const avgPerDay = analyzed.avgDaily ?? 0;
      const lines: string[] = [];
      lines.push(`💰 ${formatMoney(balance)}`);
      lines.push(`Avg/day (${days}d): ${formatMoney(avgPerDay)}`);
      lines.push(buildPredictionLine(balance, avgPerDay));
      lines.push("");
      lines.push(`last ${days} days:`);

      const dated = usage.history
        .filter((e) => e.datetime && e.reading_diff != null)
        .slice(0, Math.min(14, usage.history.length))
        .reverse();
      for (const e of dated) {
        const date = e.datetime!.slice(0, 10);
        lines.push(`${date}: ${formatMoney(Number(e.reading_diff))}`);
      }

      await ctx.reply(lines.join("\n"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Couldn't fetch usage: ${msg}`);
      console.error("[usage] failed:", { userId: ctx.from?.id, days, error: msg });
    }
  }

  async function handlePredict(ctx: Context, creds: UserCreds): Promise<void> {
    try {
      const [bal, usage] = await Promise.all([
        getCreditBalance(creds.meterId),
        getMeterUsage(creds.meterId, 7),
      ]);
      const balance = bal ?? 0;
      const avgPerDay = analyzeUsage(usage.history, bal).avgDaily ?? 0;
      await ctx.reply(
        [
          `💰 ${formatMoney(balance)}`,
          `avg/day (7d): ${formatMoney(avgPerDay)}`,
          buildPredictionLine(balance, avgPerDay),
        ].join("\n"),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Couldn't predict run-out: ${msg}`);
      console.error("[predict] failed:", { userId: ctx.from?.id, error: msg });
    }
  }

  async function handleRank(ctx: Context, creds: UserCreds): Promise<void> {
    try {
      const rank = await getUsageRank(creds.meterId);
      const pct = rank.rankVal < 0.5 ? 100 * (1 - rank.rankVal) : 100 * rank.rankVal;
      const prefix = rank.rankVal < 0.5 ? "more than" : "less than";
      const updated = rank.updatedAt ? `updated: ${rank.updatedAt}` : undefined;
      await ctx.reply(
        [
          `spent (7d): ${formatMoney(rank.usageLast7Days)}`,
          `you use ${prefix} ${pct.toFixed(0)}% of neighbors`,
          updated,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Couldn't fetch rank: ${msg}`);
      console.error("[rank] failed:", { userId: ctx.from?.id, error: msg });
    }
  }

  async function handleTopup(ctx: Context, creds: UserCreds): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      const bal = await getCreditBalance(creds.meterId);
      topupState.add(userId);
      await ctx.reply(
        [
          `💰 balance: ${formatMoney(bal ?? 0)}`,
          "",
          "How much to top up? Enter an amount in SGD (min $6, max $50):",
        ].join("\n"),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Couldn't fetch balance: ${msg}`);
      console.error("[topup] failed:", { userId, error: msg });
    }
  }

  async function handleSpent(ctx: Context, creds: UserCreds): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
      const usage = await getMeterUsage(creds.meterId, 30);

      // Backfill storage from API data
      if (usage.history.length > 0) {
        const records: DailyUsageRecord = {};
        for (const e of usage.history) {
          if (!e.datetime || e.reading_diff == null) continue;
          records[e.datetime.slice(0, 10)] = Number(e.reading_diff);
        }
        storage.setDailyUsageBulk(userId, records);
      }

      const stored = storage.getTotalSpent(userId, 30);
      const lines: string[] = [];
      lines.push(`💸 monthly aircon spending`);
      lines.push("");

      if (stored.daysTracked === 0) {
        lines.push("No usage data yet — check back tomorrow!");
        lines.push("");
        lines.push("(I'll track your daily spending automatically)");
      } else {
        const avgPerDay = stored.daysTracked > 0 ? stored.total / stored.daysTracked : 0;
        const startDate = stored.dailyBreakdown[0]?.date ?? "N/A";
        const endDate = stored.dailyBreakdown[stored.dailyBreakdown.length - 1]?.date ?? "N/A";
        lines.push(`total: ${formatMoney(stored.total)}`);
        lines.push(`avg/day: ${formatMoney(avgPerDay)}`);
        lines.push(`tracking: ${stored.daysTracked} days`);
        lines.push("");
        lines.push(`period: ${startDate} → ${endDate}`);
      }

      await ctx.reply(lines.join("\n"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Couldn't fetch monthly spending: ${msg}`);
      console.error("[spent] failed:", { userId: ctx.from?.id, error: msg });
    }
  }

  bot.command(["login", "l"], async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("Not authorized");
      return;
    }

    if (ctx.chat?.type !== "private") {
      await ctx.reply("DM me for safety");
      return;
    }

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const parts = text.split(/\s+/).filter(Boolean);
    const meterId = parts[1]?.trim() ?? "";

    if (!isValidMeterId(meterId)) {
      await ctx.reply(
        "Usage: /login <meter_id>\n\nYour meter ID is the 8-digit number on the sticker at your aircon unit.\n\nExample: /l 10013290",
      );
      return;
    }

    const userId = ctx.from?.id;
    if (userId) completeLogin(userId, meterId, ctx.chat?.id);

    if (ctx.chat?.type === "private") {
      await ctx.reply("Logged in! Try /balance", { reply_markup: PERSISTENT_KEYBOARD });
    } else {
      await ctx.reply("Logged in! Try /balance");
    }
  })

  const ANNOUNCE_ALLOWED_IDS = [495290408];

  bot.command(["announce"], async (ctx) => {
    if (!ANNOUNCE_ALLOWED_IDS.includes(ctx.from?.id ?? 0)) {
      await ctx.reply("Not authorized for announce");
      return;
    }

    if (ctx.chat?.type !== "private") {
      await ctx.reply("DM me for safety");
      return;
    }

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const msg = text.replace(/^\/announce\s*/i, "").trim();
    if (!msg) {
      await ctx.reply("Usage: /announce <message>");
      return;
    }

    const uniqueChatIds = new Set<number>();
    for (const [, rem] of userReminders.entries()) {
      if (typeof rem.chatId === "number") uniqueChatIds.add(rem.chatId);
    }

    let ok = 0;
    let fail = 0;
    for (const chatId of uniqueChatIds) {
      try {
        await bot.telegram.sendMessage(chatId, msg);
        ok += 1;
      } catch {
        fail += 1;
      }
    }

    await ctx.reply(`Sent to ${ok} chats${fail > 0 ? ` (${fail} failed)` : ""}`);
  });

  bot.command(["logout", "lo"], async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("Not authorized");
      return;
    }

    if (ctx.from?.id) {
      userCreds.delete(ctx.from.id);
      console.log(`[logout] user ${ctx.from.id} logged out`);
    }
    await ctx.reply("Logged out. Use /login to sign in again", {
      reply_markup: { remove_keyboard: true },
    });
  });

  bot.command(["balance", "bal", "b"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleBalance(ctx, creds);
  });

  bot.command(["topup", "top", "t"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleTopup(ctx, creds);
  });

  bot.command(["avg", "a"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const parts = text.split(/\s+/).filter(Boolean);
    const days = Math.min(60, Math.max(1, parseIntArg(parts[1]) ?? 7));

    try {
      const usage = await getMeterUsage(creds.meterId, days);
      const avgPerDay = analyzeUsage(usage.history, null).avgDaily ?? 0;
      await ctx.reply(`Avg/day (${days}d): ${formatMoney(avgPerDay)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Couldn't calculate avg: ${msg}`);
      console.error("[avg] failed:", { userId: ctx.from?.id, error: msg });
    }
  });

  bot.command(["usage", "u"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const parts = text.split(/\s+/).filter(Boolean);
    const days = Math.min(60, Math.max(1, parseIntArg(parts[1]) ?? 7));
    await handleUsage(ctx, creds, days);
  });

  bot.command(["predict", "p"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handlePredict(ctx, creds);
  });

  bot.command(["rank", "r"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleRank(ctx, creds);
  });

  bot.command(["spent", "monthly", "month", "m"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleSpent(ctx, creds);
  });

  // Persistent keyboard button handlers
  bot.hears("💰 Balance", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleBalance(ctx, creds);
  });

  bot.hears("📊 Usage", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleUsage(ctx, creds);
  });

  bot.hears("📈 Predict", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handlePredict(ctx, creds);
  });

  bot.hears("💸 Monthly", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleSpent(ctx, creds);
  });

  bot.hears("🏆 Rank", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleRank(ctx, creds);
  });

  bot.hears("💳 Top Up", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;
    await handleTopup(ctx, creds);
  });

  bot.hears("🔔 Reminders", async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) { await ctx.reply("Not authorized"); return; }
    if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
      await ctx.reply("Can't configure reminders here");
      return;
    }

    const existing = userReminders.get(ctx.from.id);
    const currentLevel = existing?.level ?? "off";

    const keyboard = {
      inline_keyboard: [
        [{ text: currentLevel === "alerts" ? "Smart Alerts ✓" : "Smart Alerts", callback_data: "remind_alerts" }],
        [{ text: currentLevel === "daily" ? "Daily Summary ✓" : "Daily Summary", callback_data: "remind_daily" }],
        [{ text: currentLevel === "off" ? "Off ✓" : "Off", callback_data: "remind_off" }],
      ],
    };

    await ctx.reply(
      [
        "🔔 Reminder settings",
        "",
        "Smart alerts: notify when balance is low (< $1, < $3, < 2 days left)",
        "Daily summary: send usage recap every morning at 10am",
        "",
        "Current selection:",
      ].join("\n"),
      { reply_markup: keyboard },
    );
  });

  bot.command(["remind", "rem"], async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("Not authorized");
      return;
    }

    if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
      await ctx.reply("Can't configure reminders here");
      return;
    }

    const existing = userReminders.get(ctx.from.id);
    const currentLevel = existing?.level ?? "off";

    const keyboard = {
      inline_keyboard: [
        [{ text: currentLevel === "alerts" ? "Smart Alerts ✓" : "Smart Alerts", callback_data: "remind_alerts" }],
        [{ text: currentLevel === "daily" ? "Daily Summary ✓" : "Daily Summary", callback_data: "remind_daily" }],
        [{ text: currentLevel === "off" ? "Off ✓" : "Off", callback_data: "remind_off" }],
      ],
    };

    await ctx.reply(
      [
        "🔔 Reminder settings",
        "",
        "Smart alerts: notify when balance is low (< $1, < $3, < 2 days left)",
        "Daily summary: send usage recap every morning at 10am",
        "",
        "Current selection:",
      ].join("\n"),
      { reply_markup: keyboard },
    );
  });

  // Daily job: check reminders AND store usage for all users
  // Runs at 10am SGT (UTC+8) = 2am UTC
  const scheduleDailyJob = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(2, 0, 0, 0); // 10am SGT = 2am UTC
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delayMs = next.getTime() - now.getTime();

    console.log(`[daily] next run at ${next.toISOString()} (in ${(delayMs / 1000 / 60 / 60).toFixed(1)}h)`);

    setTimeout(() => {
      (async () => {
        const startedAt = Date.now();
        
        // Process ALL users with credentials (not just those with reminders enabled)
        const allCreds = storage.getAllCreds();
        console.log(`[daily] running for ${allCreds.size} users`);

        for (const [userId, creds] of allCreds.entries()) {
          try {
            const userStartedAt = Date.now();
            const [bal, usage] = await Promise.all([
              getCreditBalance(creds.meterId),
              getMeterUsage(creds.meterId, 7),
            ]);

            const userMs = Date.now() - userStartedAt;
            if (BOT_DEBUG || userMs > 2000) {
              console.log(`[daily] user ${userId} fetched in ${userMs}ms`);
            }

            // Store daily usage data
            if (usage.history.length > 0) {
              const records: DailyUsageRecord = {};
              for (const e of usage.history) {
                if (!e.datetime || e.reading_diff == null) continue;
                records[e.datetime.slice(0, 10)] = Number(e.reading_diff);
              }
              storage.setDailyUsageBulk(userId, records);
              storage.pruneOldUsage(userId, 90);
            }

            // Check reminder level for this user
            const rem = userReminders.get(userId);
            if (!rem?.level || rem.level === "off") continue;

            const balance = bal ?? 0;
            const analyzed = analyzeUsage(usage.history, bal);
            const avgPerDay = analyzed.avgDaily ?? 0;
            const daysLeft = avgPerDay > 0 ? balance / avgPerDay : Infinity;

            // SMART ALERTS: Only send if threshold conditions met
            if (rem.level === "alerts") {
              const isCritical = balance < 1;
              const isLow = balance < 3;
              const isRunningOut = daysLeft < 2;

              if (!isCritical && !isLow && !isRunningOut) continue;

              const emoji = isCritical ? "🚨" : "⚠️";
              const urgency = isCritical ? "critically low" : isLow ? "low" : "running low";
              const daysLeftStr = Number.isFinite(daysLeft) && avgPerDay > 0 ? `~${daysLeft.toFixed(1)} days left` : "";
              
              const lines = [
                `${emoji} ${urgency} on credits!`,
                `balance: ${formatMoney(balance)}`,
              ];
              if (avgPerDay > 0) lines.push(`avg/day: ${formatMoney(avgPerDay)}`);
              if (daysLeftStr) lines.push(daysLeftStr);
              lines.push("");
              lines.push("Top up: https://cp2nus.evs.com.sg/");

              await bot.telegram.sendMessage(rem.chatId, lines.join("\n"));
            }
            // DAILY SUMMARY: Always send recap
            else if (rem.level === "daily") {
              // Get yesterday's usage (Singapore timezone)
              const nowSg = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC+8
              const yesterdaySg = new Date(nowSg);
              yesterdaySg.setDate(yesterdaySg.getDate() - 1);
              const yesterdayStr = yesterdaySg.toISOString().split("T")[0]; // YYYY-MM-DD

              const yesterdayEntry = usage.history.find((e) => e.datetime?.startsWith(yesterdayStr));
              const yesterdayUsage = yesterdayEntry?.reading_diff ?? null;
              const daysLeftStr = Number.isFinite(daysLeft) && avgPerDay > 0 ? `~${daysLeft.toFixed(1)} days left` : "N/A";

              const lines = [
                "☀️ Good morning! Here's your daily aircon summary:",
                "",
                `💰 Balance: ${formatMoney(balance)}`,
                `📊 Yesterday: ${yesterdayUsage != null ? formatMoney(Number(yesterdayUsage)) : "Pending"}`,
                `📈 Avg/day (7d): ${formatMoney(avgPerDay)}`,
                `⏳ ${daysLeftStr}`,
              ];

              // Add eco tip ~33% of the time
              if (Math.random() < 0.33) {
                lines.push("");
                lines.push(ECO_TIPS[Math.floor(Math.random() * ECO_TIPS.length)]);
              }

              await bot.telegram.sendMessage(rem.chatId, lines.join("\n"));
            }
          } catch (e) {
            console.error("[daily] check failed:", { userId, error: e instanceof Error ? e.message : String(e) });
          }
        }

        const totalMs = Date.now() - startedAt;
        if (BOT_DEBUG || totalMs > 2000) {
          console.log(`[daily] job finished in ${totalMs}ms`);
        }
      })()
        .catch((e) => console.error("[daily] job crashed:", e instanceof Error ? e.message : String(e)))
        .finally(() => scheduleDailyJob());
    }, delayMs);
  };

  scheduleDailyJob();

  bot.on("text", async (ctx) => {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) return;
    if (ctx.chat?.type !== "private") return;

    const userId = ctx.from?.id;
    if (!userId) return;
    if (!isAllowedUser(userId)) return;

    // Topup amount collection
    if (topupState.has(userId)) {
      const input = text.trim();
      const amount = Number(input.replace(/[^0-9.]/g, ""));
      if (!isValidAmount(amount)) {
        await ctx.reply("Please enter a valid amount between $6 and $50 (e.g. 20).");
        return;
      }
      topupState.delete(userId);
      const creds = getCreds(userId);
      if (!creds) {
        await ctx.reply("Not logged in. DM me /login <meter_id>");
        return;
      }
      const hostelType = storage.getHostelType(userId);
      const path = hostelType === "cp2" ? "/webapp" : "/cp2nus/webapp";
      const webAppUrl =
        `${config.server.url}${path}` +
        `?txtMtrId=${encodeURIComponent(creds.meterId)}` +
        `&txtAmount=${encodeURIComponent(amount.toFixed(2))}`;
      const isHttps = config.server.url.startsWith("https://");
      const button = isHttps
        ? { text: "💳 Pay Now", web_app: { url: webAppUrl } }
        : { text: "💳 Pay Now", url: webAppUrl };
      await ctx.reply(
        [
          `Meter: ${creds.meterId}`,
          `Amount: $${amount.toFixed(2)} SGD`,
          "",
          isHttps ? "Tap below to pay:" : "Open the link below to pay:",
        ].join("\n"),
        { reply_markup: { inline_keyboard: [[button]] } },
      );
      return;
    }

    if (!onboardingState.has(userId)) return;

    const state = onboardingState.get(userId)!;
    const input = text.trim();

    if (state.step === "meterId") {
      if (!isValidMeterId(input)) {
        await ctx.reply(
          "That doesn't look right. I need the 8-digit number from the sticker at your aircon unit.\n\nExample: 10013290",
        );
        return;
      }

      onboardingState.delete(userId);
      completeLogin(userId, input, ctx.chat?.id);

      if (ctx.chat?.type === "private") {
        await ctx.reply("Logged in! Try /balance", { reply_markup: PERSISTENT_KEYBOARD });
      } else {
        await ctx.reply("Logged in! Try /balance");
      }
    }
  });

  // Handle inline button callbacks
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data) return;

    // Acknowledge the callback
    await ctx.answerCbQuery();

    const creds = getCreds(ctx.from?.id);

    switch (data) {
      case "cmd_balance": {
        if (!creds) {
          await ctx.reply("Not logged in. DM me /login <meter_id>");
          return;
        }
        await handleBalance(ctx, creds);
        break;
      }

      case "cmd_usage": {
        if (!creds) {
          await ctx.reply("Not logged in. DM me /login <meter_id>");
          return;
        }
        await handleUsage(ctx, creds, 7);
        break;
      }

      case "cmd_predict": {
        if (!creds) {
          await ctx.reply("Not logged in. DM me /login <meter_id>");
          return;
        }
        await handlePredict(ctx, creds);
        break;
      }

      case "cmd_rank": {
        if (!creds) {
          await ctx.reply("Not logged in. DM me /login <meter_id>");
          return;
        }
        await handleRank(ctx, creds);
        break;
      }

      case "cmd_topup": {
        const creds = getCreds(ctx.from?.id);
        if (!creds) {
          await ctx.reply("Not logged in. DM me /login <meter_id>");
          return;
        }
        await handleTopup(ctx, creds);
        break;
      }

      case "cmd_spent": {
        if (!creds) {
          await ctx.reply("Not logged in. DM me /login <meter_id>");
          return;
        }
        await handleSpent(ctx, creds);
        break;
      }

      case "cmd_remind": {
        if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
          await ctx.reply("Can't configure reminders here");
          return;
        }

        const existing = userReminders.get(ctx.from.id);
        const currentLevel = existing?.level ?? "off";

        const keyboard = {
          inline_keyboard: [
            [{ text: currentLevel === "alerts" ? "Smart Alerts ✓" : "Smart Alerts", callback_data: "remind_alerts" }],
            [{ text: currentLevel === "daily" ? "Daily Summary ✓" : "Daily Summary", callback_data: "remind_daily" }],
            [{ text: currentLevel === "off" ? "Off ✓" : "Off", callback_data: "remind_off" }],
          ],
        };

        await ctx.reply(
          [
            "🔔 Reminder settings",
            "",
            "Smart alerts: notify when balance is low (< $1, < $3, < 2 days left)",
            "Daily summary: send usage recap every morning at 10am",
            "",
            "Current selection:",
          ].join("\n"),
          { reply_markup: keyboard },
        );
        break;
      }

      case "remind_alerts": {
        if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
          await ctx.reply("Can't configure reminders here");
          return;
        }
        userReminders.set(ctx.from.id, { chatId: ctx.chat.id, level: "alerts" });
        await ctx.editMessageText(
          [
            "🔔 Reminder settings",
            "",
            "Smart alerts: notify when balance is low (< $1, < $3, < 2 days left)",
            "Daily summary: send usage recap every morning at 10am",
            "",
            "Current selection: Smart Alerts ✓",
          ].join("\n"),
        );
        break;
      }

      case "remind_daily": {
        if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
          await ctx.reply("Can't configure reminders here");
          return;
        }
        userReminders.set(ctx.from.id, { chatId: ctx.chat.id, level: "daily" });
        await ctx.editMessageText(
          [
            "🔔 Reminder settings",
            "",
            "Smart alerts: notify when balance is low (< $1, < $3, < 2 days left)",
            "Daily summary: send usage recap every morning at 10am",
            "",
            "Current selection: Daily Summary ✓",
          ].join("\n"),
        );
        break;
      }

      case "remind_off": {
        if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
          await ctx.reply("Can't configure reminders here");
          return;
        }
        userReminders.set(ctx.from.id, { chatId: ctx.chat.id, level: "off" });
        await ctx.editMessageText(
          [
            "🔔 Reminder settings",
            "",
            "Smart alerts: notify when balance is low (< $1, < $3, < 2 days left)",
            "Daily summary: send usage recap every morning at 10am",
            "",
            "Current selection: Off ✓",
          ].join("\n"),
        );
        break;
      }

      case "cmd_help": {
        const keyboard = {
          inline_keyboard: [
            [
              { text: "💰 Balance", callback_data: "cmd_balance" },
              { text: "📊 Usage", callback_data: "cmd_usage" },
            ],
            [
              { text: "💸 Monthly", callback_data: "cmd_spent" },
              { text: "📈 Predict", callback_data: "cmd_predict" },
            ],
            [
              { text: "🏆 Rank", callback_data: "cmd_rank" },
              { text: "💳 Top Up", callback_data: "cmd_topup" },
            ],
            [
              { text: "🔔 Reminders", callback_data: "cmd_remind" },
            ],
          ],
        };

        await ctx.reply(
          [
            "Aircon Checker Bot v2.0",
            "",
            "DM me /login <meter_id> to log in.",
            "/b or /bal - check balance",
            "/u [days] - daily usage breakdown",
            "/m or /spent - total spent this month",
            "/p - predict when you'll run out",
            "/r - compare to neighbors",
            "/t - top up link",
            "/rem - toggle low balance alerts (off by default)",
            "/lo - clear login (re-login with /login <meter_id>)",
            "",
            "Or just tap the buttons below!",
            "",
            "Changes in v2.0: persistent buttons, daily summaries, eco tips",
            "",
            "Developed by @anselmlong",
            "Feel free to text if the bot breaks!",
          ].join("\n"),
          { reply_markup: keyboard },
        );
        break;
      }
    }
  });

  const stopSafe = (signal: "SIGINT" | "SIGTERM") => {
    try {
      bot.stop(signal);
    } catch {
      // If we get a signal before bot.launch resolves, Telegraf throws.
    }
  };

  bot
    .launch()
    .then(() => {
      console.log("[bot] launched successfully");
      process.once("SIGINT", () => {
        console.log("[bot] received SIGINT, stopping gracefully...");
        stopSafe("SIGINT");
      });
      process.once("SIGTERM", () => {
        console.log("[bot] received SIGTERM, stopping gracefully...");
        stopSafe("SIGTERM");
      });
    })
    .catch((err) => {
      console.error("[bot] failed to launch:", err);
      process.exit(1);
    });
}

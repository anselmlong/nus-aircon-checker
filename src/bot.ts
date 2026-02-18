import { Telegraf, type Context } from "telegraf";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { EvsClient, type Balances } from "./evsClient.js";
import { EncryptedStorage, type UserCreds, type UserReminder } from "./storage.js";

function isAllowedUser(userId: number | undefined): boolean {
  if (!userId) return false;
  const allowed = config.telegram.allowedUserIds;
  if (allowed.length === 0) return true;
  return allowed.includes(userId);
}

export function startBot(): void {
  const evs = new EvsClient(undefined);
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
    ctx.reply("oops, something went wrong. try again?").catch(() => {
      // Silent fail if we can't even send error message
    });
  });

  bot.start(async (ctx) => {
    const isLoggedIn = !!getCreds(ctx.from?.id);
    
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
          { text: "❓ Help", callback_data: "cmd_help" },
        ],
      ],
    };

    await ctx.reply(
      [
        "hey! i check your aircon usage.",
        "",
        isLoggedIn ? "tap a button below or use commands:" : "dm me /login <user> <pass> to get started",
        "",
        "/login (/l) <user> <pass> - log in (dm only)",
        "/balance (/bal, /b) - check balance",
        "/usage (/u) [days] - daily usage (default: 7d)",
        "/spent (/m) - total spent this month",
        "/avg (/a) [days] - avg per day (default: 7d)",
        "/predict (/p) - will you run out soon?",
        "/rank (/r) - compare to neighbors",
        "/topup (/t) - top up link + creds",
        "/remind (/rem) - toggle low balance alerts",
        "/logout (/lo) - forget credentials",
        "/help (/h) - show commands",
      ].join("\n"),
      { reply_markup: keyboard },
    );
  });

  bot.command(["help", "h"], async (ctx) => {
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
        "aircon checker bot v1.3",
        "",
        "dm me /l <user> <pass> to log in.",
        "/b or /bal - check balance",
        "/u [days] - daily usage breakdown",
        "/m or /spent - total spent this month",
        "/p - predict when you'll run out",
        "/r - compare to neighbors",
        "/t - top up link + your creds",
        "/rem - toggle low balance alerts (off by default)",
        "/lo - clear login",
        "",
        "or just tap the buttons below!",
        "",
        "changes in v1.3: monthly spending tracker",
        "",
        "developed by @anselmlong",
        "feel free to text if the bot breaks!",
      ].join("\n"),
      { reply_markup: keyboard },
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
      await ctx.reply("not authorized");
      return undefined;
    }

    const creds = getCreds(ctx.from?.id);
    if (!creds) {
      await ctx.reply("not logged in. dm me /login <user> <pass>");
      return undefined;
    }

    // Remember where to send reminders (private chats only).
    if (ctx.from?.id && typeof ctx.chat?.id === "number") {
      const existing = userReminders.get(ctx.from.id);
      userReminders.set(ctx.from.id, {
        chatId: ctx.chat.id,
        enabled: existing?.enabled ?? false,
      });
    }

    return creds;
  }

  function formatMoney(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  function getEffectiveBalance(balances: Balances): number {
    const money = balances.money?.moneyBalance;
    const meter = balances.meterCredit?.meterCreditBalance;
    
    const hasMoney = money !== null && Number.isFinite(money);
    const hasMeter = meter !== null && Number.isFinite(meter);
    
    // If only one value is available, use it
    if (hasMoney && !hasMeter) return money!;
    if (hasMeter && !hasMoney) return meter!;
    if (!hasMoney && !hasMeter) return 0;
    
    // Both values available: apply heuristic
    // Assumption: real balance should be < $100
    
    // If money >= 100 but meter < 100, prefer meter
    if (money! >= 100 && meter! < 100) return meter!;
    
    // If both >= 100, use smaller value
    if (money! >= 100 && meter! >= 100) return Math.min(money!, meter!);
    
    // Otherwise prefer money balance (original priority)
    return money!;
  }

  function buildPredictionLine(balance: number, avgPerDay: number): string {
    if (!(avgPerDay > 0)) return "no usage data yet";
    const daysLeft = balance / avgPerDay;
    if (!Number.isFinite(daysLeft)) return "can't estimate run-out";
    if (daysLeft < 1) return `⚠️ running out soon (~${Math.max(0, daysLeft).toFixed(1)} days left)`;
    if (daysLeft < 2) return `heads up: ~${daysLeft.toFixed(1)} days left`;
    return `~${daysLeft.toFixed(1)} days left`;
  }

  bot.command(["login", "l"], async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("not authorized");
      return;
    }

    if (ctx.chat?.type !== "private") {
      await ctx.reply("dm me for safety");
      return;
    }

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 3) {
      await ctx.reply("usage: /login <user> <pass>");
      return;
    }

    const username = parts[1]?.trim();
    const password = parts.slice(2).join(" ").trim();

    if (!username || !password) {
      await ctx.reply("usage: /login <user> <pass>");
      return;
    }

    try {
      await evs.login(username, password);
      if (ctx.from?.id) {
        userCreds.set(ctx.from.id, { username, password });
        if (typeof ctx.chat?.id === "number") {
          const existing = userReminders.get(ctx.from.id);
          userReminders.set(ctx.from.id, {
            chatId: ctx.chat.id,
            enabled: existing?.enabled ?? false,
          });
        }
        console.log(`[login] user ${ctx.from.id} logged in as ${username}`);
      }
      await ctx.reply("logged in! try /balance");
    } catch (e) {
      await ctx.reply("login failed");
      console.error("[login] failed:", { userId: ctx.from?.id, username, error: e instanceof Error ? e.message : String(e) });
    }
  });

  const ANNOUNCE_ALLOWED_IDS = [495290408];

  bot.command(["announce"], async (ctx) => {
    if (!ANNOUNCE_ALLOWED_IDS.includes(ctx.from?.id ?? 0)) {
      await ctx.reply("not authorized for announce");
      return;
    }

    if (ctx.chat?.type !== "private") {
      await ctx.reply("dm me for safety");
      return;
    }

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const msg = text.replace(/^\/announce\s*/i, "").trim();
    if (!msg) {
      await ctx.reply("usage: /announce <message>");
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

    await ctx.reply(`sent to ${ok} chats${fail > 0 ? ` (${fail} failed)` : ""}`);
  });

  bot.command(["logout", "lo"], async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("not authorized");
      return;
    }

    if (ctx.from?.id) {
      userCreds.delete(ctx.from.id);
      console.log(`[logout] user ${ctx.from.id} logged out`);
    }
    evs.logout();
    await ctx.reply("logged out. use /login to sign in again");
  });

  bot.command(["balance", "bal", "b"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const res = await evs.getBalances(creds.username, creds.password);
      const balance = getEffectiveBalance(res);
      const lastUpdated = res.money.lastUpdated || res.meterCredit.lastUpdated;
      const lines: string[] = [];
      lines.push(`💰 ${formatMoney(balance)}`);
      if (lastUpdated) lines.push(`updated: ${lastUpdated}`);
      await ctx.reply(lines.join("\n"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`couldn't fetch balance: ${msg}`);
      console.error("[balance] failed:", { userId: ctx.from?.id, error: msg });
    }
  });

  bot.command(["topup", "top", "t"], async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("not authorized");
      return;
    }

    const creds = getCreds(ctx.from?.id);
    const lines = [
      "link to top up: https://cp2nus.evs.com.sg/",
      "",
    ];

    if (creds) {
      lines.push("your login:");
      lines.push(`\`${creds.username}\``);
      lines.push(`\`${creds.password}\``);
      lines.push("");
    }

    lines.push("note: balance may take a while to update");

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command(["avg", "a"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const parts = text.split(/\s+/).filter(Boolean);
    const days = Math.min(60, Math.max(1, parseIntArg(parts[1]) ?? 7));

    try {
      const usage = await evs.getDailyUsage(creds.username, creds.password, days);
      await ctx.reply(`avg/day (${days}d): ${formatMoney(usage.avgPerDay)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`couldn't calculate avg: ${msg}`);
      console.error("[avg] failed:", { userId: ctx.from?.id, error: msg });
    }
  });

  bot.command(["usage", "u"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const parts = text.split(/\s+/).filter(Boolean);
    const days = Math.min(60, Math.max(1, parseIntArg(parts[1]) ?? 7));

    try {
      const [balances, usage] = await Promise.all([
        evs.getBalances(creds.username, creds.password),
        evs.getDailyUsage(creds.username, creds.password, days),
      ]);

      const balance = getEffectiveBalance(balances);
      const lines: string[] = [];
      lines.push(`💰 ${formatMoney(balance)}`);
      lines.push(`avg/day (${days}d): ${formatMoney(usage.avgPerDay)}`);
      lines.push(buildPredictionLine(balance, usage.avgPerDay));
      lines.push("");
      lines.push(`last ${days} days:`);

      const daily = usage.daily.slice(-Math.min(14, usage.daily.length));
      for (const d of daily) {
        lines.push(`${d.date}: ${formatMoney(d.usage)}`);
      }

      await ctx.reply(lines.join("\n"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`couldn't fetch usage: ${msg}`);
      console.error("[usage] failed:", { userId: ctx.from?.id, days, error: msg });
    }
  });

  bot.command(["predict", "p"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const [balances, usage] = await Promise.all([
        evs.getBalances(creds.username, creds.password),
        evs.getDailyUsage(creds.username, creds.password, 7),
      ]);

      const balance = getEffectiveBalance(balances);
      await ctx.reply(
        [
          `💰 ${formatMoney(balance)}`,
          `avg/day (7d): ${formatMoney(usage.avgPerDay)}`,
          buildPredictionLine(balance, usage.avgPerDay),
        ].join("\n"),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`couldn't predict run-out: ${msg}`);
      console.error("[predict] failed:", { userId: ctx.from?.id, error: msg });
    }
  });

  bot.command(["rank", "r"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const rank = await evs.getUsageRank(creds.username, creds.password);

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
      await ctx.reply(`couldn't fetch rank: ${msg}`);
      console.error("[rank] failed:", { userId: ctx.from?.id, error: msg });
    }
  });

  bot.command(["spent", "monthly", "month", "m"], async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const usage = await evs.getDailyUsage(creds.username, creds.password, 30);
      const totalSpent = usage.daily.reduce((acc, d) => acc + d.usage, 0);
      
      // Find the date range
      const startDate = usage.daily.length > 0 ? usage.daily[0]!.date : "N/A";
      const endDate = usage.daily.length > 0 ? usage.daily[usage.daily.length - 1]!.date : "N/A";

      const lines: string[] = [];
      lines.push(`💸 monthly aircon spending`);
      lines.push("");
      lines.push(`total (30d): ${formatMoney(totalSpent)}`);
      lines.push(`avg/day: ${formatMoney(usage.avgPerDay)}`);
      lines.push("");
      lines.push(`period: ${startDate} → ${endDate}`);

      await ctx.reply(lines.join("\n"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`couldn't fetch monthly spending: ${msg}`);
      console.error("[spent] failed:", { userId: ctx.from?.id, error: msg });
    }
  });



  bot.command(["remind", "rem"], async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("not authorized");
      return;
    }

    if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
      await ctx.reply("can't configure reminders here");
      return;
    }

    const existing = userReminders.get(ctx.from.id);
    // First use defaults to OFF, so toggling turns it ON
    const enabled = !(existing?.enabled ?? false);
    userReminders.set(ctx.from.id, { chatId: ctx.chat.id, enabled });

    if (enabled) {
      await ctx.reply(
        [
          "✅ reminders on",
          "",
          "you'll get a daily alert (9am) when:",
          "• balance < $1 (critical)",
          "• balance < $3 (low)",
          "• < 2 days of usage left",
        ].join("\n"),
      );
    } else {
      await ctx.reply("reminders off");
    }
  });

  // Minimal reminder loop: once a day, DM users who opted in and are predicted to
  // run out tomorrow.
  const scheduleDailyReminder = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delayMs = next.getTime() - now.getTime();

    console.log(`[reminder] next check at ${next.toISOString()} (in ${(delayMs / 1000 / 60 / 60).toFixed(1)}h)`);

    setTimeout(() => {
      (async () => {
        const startedAt = Date.now();
        console.log(`[reminder] running daily check for ${userReminders.size()} users`);
        for (const [userId, rem] of userReminders.entries()) {
          if (!rem.enabled) continue;
          const creds = userCreds.get(userId);
          if (!creds) continue;

          try {
            const userStartedAt = Date.now();
            const [balances, usage] = await Promise.all([
              evs.getBalances(creds.username, creds.password),
              evs.getDailyUsage(creds.username, creds.password, 7),
            ]);

            const userMs = Date.now() - userStartedAt;
            if (BOT_DEBUG || userMs > 2000) {
              console.log(`[reminder] user ${userId} fetched in ${userMs}ms`);
            }

            const balance = getEffectiveBalance(balances);
            const avgPerDay = usage.avgPerDay;
            const daysLeft = avgPerDay > 0 ? balance / avgPerDay : Infinity;

            // Reminder triggers:
            // 1. Balance < $1 (critical - immediate alert)
            // 2. Balance < $3 (low - alert)
            // 3. Less than 2 days of usage left (based on avg)
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
            lines.push("top up: https://cp2nus.evs.com.sg/");

            await bot.telegram.sendMessage(rem.chatId, lines.join("\n"));
          } catch (e) {
            console.error("[reminder] check failed:", { userId, error: e instanceof Error ? e.message : String(e) });
          }
        }

        const totalMs = Date.now() - startedAt;
        if (BOT_DEBUG || totalMs > 2000) {
          console.log(`[reminder] daily check finished in ${totalMs}ms`);
        }
      })()
        .catch((e) => console.error("[reminder] loop crashed:", e instanceof Error ? e.message : String(e)))
        .finally(() => scheduleDailyReminder());
    }, delayMs);
  };

  scheduleDailyReminder();

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
          await ctx.reply("not logged in. dm me /login <user> <pass>");
          return;
        }
        try {
          const res = await evs.getBalances(creds.username, creds.password);
          const balance = getEffectiveBalance(res);
          const lastUpdated = res.money.lastUpdated || res.meterCredit.lastUpdated;
          const lines: string[] = [];
          lines.push(`💰 ${formatMoney(balance)}`);
          if (lastUpdated) lines.push(`updated: ${lastUpdated}`);
          await ctx.reply(lines.join("\n"));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await ctx.reply(`couldn't fetch balance: ${msg}`);
        }
        break;
      }

      case "cmd_usage": {
        if (!creds) {
          await ctx.reply("not logged in. dm me /login <user> <pass>");
          return;
        }
        try {
          const days = 7;
          const [balances, usage] = await Promise.all([
            evs.getBalances(creds.username, creds.password),
            evs.getDailyUsage(creds.username, creds.password, days),
          ]);

          const balance = getEffectiveBalance(balances);
          const lines: string[] = [];
          lines.push(`💰 ${formatMoney(balance)}`);
          lines.push(`avg/day (${days}d): ${formatMoney(usage.avgPerDay)}`);
          lines.push(buildPredictionLine(balance, usage.avgPerDay));
          lines.push("");
          lines.push(`last ${days} days:`);

          const daily = usage.daily.slice(-Math.min(14, usage.daily.length));
          for (const d of daily) {
            lines.push(`${d.date}: ${formatMoney(d.usage)}`);
          }

          await ctx.reply(lines.join("\n"));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await ctx.reply(`couldn't fetch usage: ${msg}`);
        }
        break;
      }

      case "cmd_predict": {
        if (!creds) {
          await ctx.reply("not logged in. dm me /login <user> <pass>");
          return;
        }
        try {
          const [balances, usage] = await Promise.all([
            evs.getBalances(creds.username, creds.password),
            evs.getDailyUsage(creds.username, creds.password, 7),
          ]);

          const balance = getEffectiveBalance(balances);
          await ctx.reply(
            [
              `💰 ${formatMoney(balance)}`,
              `avg/day (7d): ${formatMoney(usage.avgPerDay)}`,
              buildPredictionLine(balance, usage.avgPerDay),
            ].join("\n"),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await ctx.reply(`couldn't predict run-out: ${msg}`);
        }
        break;
      }

      case "cmd_rank": {
        if (!creds) {
          await ctx.reply("not logged in. dm me /login <user> <pass>");
          return;
        }
        try {
          const rank = await evs.getUsageRank(creds.username, creds.password);

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
          await ctx.reply(`couldn't fetch rank: ${msg}`);
        }
        break;
      }

      case "cmd_topup": {
        const lines = [
          "link to top up: https://cp2nus.evs.com.sg/",
          "",
        ];

        if (creds) {
          lines.push("your login:");
          lines.push(`\`${creds.username}\``);
          lines.push(`\`${creds.password}\``);
          lines.push("");
        }

        lines.push("note: balance may take a while to update");

        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        break;
      }

      case "cmd_spent": {
        if (!creds) {
          await ctx.reply("not logged in. dm me /login <user> <pass>");
          return;
        }
        try {
          const usage = await evs.getDailyUsage(creds.username, creds.password, 30);
          const totalSpent = usage.daily.reduce((acc, d) => acc + d.usage, 0);
          
          const startDate = usage.daily.length > 0 ? usage.daily[0]!.date : "N/A";
          const endDate = usage.daily.length > 0 ? usage.daily[usage.daily.length - 1]!.date : "N/A";

          const lines: string[] = [];
          lines.push(`💸 monthly aircon spending`);
          lines.push("");
          lines.push(`total (30d): ${formatMoney(totalSpent)}`);
          lines.push(`avg/day: ${formatMoney(usage.avgPerDay)}`);
          lines.push("");
          lines.push(`period: ${startDate} → ${endDate}`);

          await ctx.reply(lines.join("\n"));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await ctx.reply(`couldn't fetch monthly spending: ${msg}`);
        }
        break;
      }

      case "cmd_remind": {
        if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
          await ctx.reply("can't configure reminders here");
          return;
        }

        const existing = userReminders.get(ctx.from.id);
        const enabled = !(existing?.enabled ?? false);
        userReminders.set(ctx.from.id, { chatId: ctx.chat.id, enabled });

        if (enabled) {
          await ctx.reply(
            [
              "✅ reminders on",
              "",
              "you'll get a daily alert (9am) when:",
              "• balance < $1 (critical)",
              "• balance < $3 (low)",
              "• < 2 days of usage left",
            ].join("\n"),
          );
        } else {
          await ctx.reply("reminders off");
        }
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
            "aircon checker bot v1.3",
            "",
            "dm me /l <user> <pass> to log in.",
            "/b or /bal - check balance",
            "/u [days] - daily usage breakdown",
            "/m or /spent - total spent this month",
            "/p - predict when you'll run out",
            "/r - compare to neighbors",
            "/t - top up link + your creds",
            "/rem - toggle low balance alerts (off by default)",
            "/lo - clear login",
            "",
            "or just tap the buttons below!",
            "",
            "changes in v1.3: monthly spending tracker",
            "",
            "developed by @anselmlong",
            "feel free to text if the bot breaks!",
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

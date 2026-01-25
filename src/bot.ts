import { Telegraf, type Context } from "telegraf";
import { config } from "./config.js";
import { EvsClient } from "./evsClient.js";

type UserCreds = {
  username: string;
  password: string;
};

type UserReminder = {
  chatId: number;
  enabled: boolean;
};

function isAllowedUser(userId: number | undefined): boolean {
  if (!userId) return false;
  const allowed = config.telegram.allowedUserIds;
  if (allowed.length === 0) return true;
  return allowed.includes(userId);
}

export function startBot(): void {
  const evs = new EvsClient(undefined);
  const bot = new Telegraf(config.telegram.token);
  const userCreds = new Map<number, UserCreds>();
  const userReminders = new Map<number, UserReminder>();

  const BOT_DEBUG = process.env.BOT_DEBUG === "1";

  console.log("[bot] starting up...");
  console.log("[bot] allowed user ids:", config.telegram.allowedUserIds.length > 0 ? config.telegram.allowedUserIds : "any");

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
    await ctx.reply(
      [
        "hey! evs2 cp2nus bot here.",
        "",
        "/login <user> <pass> - log in (dm only)",
        "/balance - check balance",
        "/usage [days] - daily usage (default: 7d)",
        "/avgspend [days] - avg usage per day (default: 7d)",
        "/predict - will you run out soon?",
        "/rank - how you compare to neighbors",
        "/topup - top up link",
        "/meter - meter details",
        "/remind - toggle daily alerts",
        "/logout - forget credentials",
        "/help - show commands",
      ].join("\n"),
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "dm me /login <user> <pass> to get started.",
        "then use /balance to check balance.",
        "/usage shows daily usage.",
        "/predict estimates when you'll run out.",
        "/rank compares you to neighbors.",
        "/topup for the portal link.",
        "/remind toggles daily alerts (9am).",
        "/logout clears your login.",
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
        enabled: existing?.enabled ?? true,
      });
    }

    return creds;
  }

  function formatMoney(n: number): string {
    return `SGD ${n.toFixed(2)}`;
  }

  function buildPredictionLine(balance: number, avgPerDay: number): string {
    if (!(avgPerDay > 0)) return "no usage data yet";
    const daysLeft = balance / avgPerDay;
    if (!Number.isFinite(daysLeft)) return "can't estimate run-out";
    if (daysLeft < 1) return `⚠️ running out soon (~${Math.max(0, daysLeft).toFixed(1)} days left)`;
    if (daysLeft < 2) return `heads up: ~${daysLeft.toFixed(1)} days left`;
    return `~${daysLeft.toFixed(1)} days left`;
  }

  bot.command("login", async (ctx) => {
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

    if (username.length < 3 || password.length < 3) {
      await ctx.reply("username and password must be at least 3 characters");
      return;
    }

    try {
      await evs.login(username, password);
      if (ctx.from?.id) {
        userCreds.set(ctx.from.id, { username, password });
        console.log(`[login] user ${ctx.from.id} logged in as ${username}`);
      }
      await ctx.reply("logged in! try /balance");
    } catch (e) {
      await ctx.reply("login failed");
      console.error("[login] failed:", { userId: ctx.from?.id, username, error: e instanceof Error ? e.message : String(e) });
    }
  });

  bot.command("logout", async (ctx) => {
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

  bot.command("balance", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const res = await evs.getBalances(creds.username, creds.password);
      const lines: string[] = [];
      lines.push(`💰 sgd ${res.money.moneyBalance.toFixed(2)}`);
      if (res.money.lastUpdated) lines.push(`updated: ${res.money.lastUpdated}`);
      await ctx.reply(lines.join("\n"));
    } catch (e) {
      await ctx.reply("couldn't fetch balance");
      console.error("[balance] failed:", { userId: ctx.from?.id, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Keep /credits as alias for backwards compatibility
  bot.command("credits", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const res = await evs.getBalances(creds.username, creds.password);
      const lines: string[] = [];
      lines.push(`💰 sgd ${res.money.moneyBalance.toFixed(2)}`);
      if (res.money.lastUpdated) lines.push(`updated: ${res.money.lastUpdated}`);
      await ctx.reply(lines.join("\n"));
    } catch (e) {
      await ctx.reply("couldn't fetch balance");
      console.error("[credits] failed:", { userId: ctx.from?.id, error: e instanceof Error ? e.message : String(e) });
    }
  });

  bot.command("topup", async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("not authorized");
      return;
    }

    await ctx.reply(
      [
        "link to top up: https://cp2nus.evs.com.sg/",
        "",
        "(for technical reasons, can't link the actual nets site directly)",
        "",
        "note: may take a while to update",
      ].join("\n"),
    );
  });

  bot.command("meter", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const info = await evs.getMeterInfo(creds.username, creds.password);
      const lines: string[] = ["meter info:"];

      if (info && typeof info === "object") {
        const o = info as Record<string, unknown>;
        const keys = [
          "meter_displayname",
          "meter_sn",
          "meter_type",
          "site",
          "building",
          "block",
          "level",
          "unit",
        ];
        for (const k of keys) {
          const v = o[k];
          if (v == null) continue;
          lines.push(`${k}: ${String(v)}`);
        }
        if (lines.length === 1) lines.push(JSON.stringify(o));
      } else {
        lines.push(String(info));
      }

      await ctx.reply(lines.join("\n"));
    } catch (e) {
      await ctx.reply("couldn't fetch meter info");
      console.error("[meter] failed:", { userId: ctx.from?.id, error: e instanceof Error ? e.message : String(e) });
    }
  });

  bot.command("avgspend", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const parts = text.split(/\s+/).filter(Boolean);
    const days = Math.min(60, Math.max(1, parseIntArg(parts[1]) ?? 7));

    try {
      const usage = await evs.getDailyUsage(creds.username, creds.password, days);
      await ctx.reply(`avg/day (${days}d): sgd ${usage.avgPerDay.toFixed(2)}`);
    } catch (e) {
      await ctx.reply("couldn't calculate avg spend");
      console.error("[avgspend] failed:", { userId: ctx.from?.id, error: e instanceof Error ? e.message : String(e) });
    }
  });

  bot.command("usage", async (ctx) => {
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

      const lines: string[] = [];
      lines.push(`💰 sgd ${balances.money.moneyBalance.toFixed(2)}`);
      lines.push(`avg/day (${days}d): sgd ${usage.avgPerDay.toFixed(2)}`);
      lines.push(buildPredictionLine(balances.money.moneyBalance, usage.avgPerDay));
      lines.push("");
      lines.push(`last ${days} days:`);

      const daily = usage.daily.slice(-Math.min(14, usage.daily.length));
      for (const d of daily) {
        lines.push(`${d.date}: sgd ${d.usage.toFixed(2)}`);
      }

      await ctx.reply(lines.join("\n"));
    } catch (e) {
      await ctx.reply("couldn't fetch usage");
      console.error("[usage] failed:", { userId: ctx.from?.id, days, error: e instanceof Error ? e.message : String(e) });
    }
  });

  bot.command("predict", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const [balances, rank] = await Promise.all([
        evs.getBalances(creds.username, creds.password),
        evs.getUsageRank(creds.username, creds.password),
      ]);

      const avgPerDay = rank.usageLast7Days / 7;
      await ctx.reply(
        [
          `💰 sgd ${balances.money.moneyBalance.toFixed(2)}`,
          `avg/day (7d): sgd ${avgPerDay.toFixed(2)}`,
          buildPredictionLine(balances.money.moneyBalance, avgPerDay),
        ].join("\n"),
      );
    } catch (e) {
      await ctx.reply("couldn't predict run-out");
      console.error("[predict] failed:", { userId: ctx.from?.id, error: e instanceof Error ? e.message : String(e) });
    }
  });

  bot.command("rank", async (ctx) => {
    const creds = await ensureAuthed(ctx);
    if (!creds) return;

    try {
      const rank = await evs.getUsageRank(creds.username, creds.password);

      const pct = rank.rankVal < 0.5 ? 100 * (1 - rank.rankVal) : 100 * rank.rankVal;
      const prefix = rank.rankVal < 0.5 ? "more than" : "less than";
      const updated = rank.updatedAt ? `updated: ${rank.updatedAt}` : undefined;

      await ctx.reply(
        [
          `spent (7d): sgd ${rank.usageLast7Days.toFixed(2)}`,
          `you use ${prefix} ${pct.toFixed(0)}% of neighbors`,
          updated,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (e) {
      await ctx.reply("couldn't fetch rank");
      console.error("[rank] failed:", { userId: ctx.from?.id, error: e instanceof Error ? e.message : String(e) });
    }
  });



  bot.command("remind", async (ctx) => {
    if (!isAllowedUser(ctx.from?.id)) {
      await ctx.reply("not authorized");
      return;
    }

    if (!ctx.from?.id || typeof ctx.chat?.id !== "number") {
      await ctx.reply("can't configure reminders here");
      return;
    }

    const existing = userReminders.get(ctx.from.id);
    const enabled = !(existing?.enabled ?? true);
    userReminders.set(ctx.from.id, { chatId: ctx.chat.id, enabled });

    await ctx.reply(enabled ? "reminders on" : "reminders off");
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
        console.log(`[reminder] running daily check for ${userReminders.size} users`);
        for (const [userId, rem] of userReminders.entries()) {
          if (!rem.enabled) continue;
          const creds = userCreds.get(userId);
          if (!creds) continue;

          try {
            const userStartedAt = Date.now();
            const [balances, rank] = await Promise.all([
              evs.getBalances(creds.username, creds.password),
              evs.getUsageRank(creds.username, creds.password),
            ]);

            const userMs = Date.now() - userStartedAt;
            if (BOT_DEBUG || userMs > 2000) {
              console.log(`[reminder] user ${userId} fetched in ${userMs}ms`);
            }

            const avgPerDay = rank.usageLast7Days / 7;
            const line = buildPredictionLine(balances.money.moneyBalance, avgPerDay);
            if (!line.startsWith("heads up") && !line.startsWith("⚠️")) continue;

            await bot.telegram.sendMessage(
              rem.chatId,
              [
                line,
                `money: sgd ${balances.money.moneyBalance.toFixed(2)}`,
                "top up: https://cp2nus.evs.com.sg/",
              ].join("\n"),
            );
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

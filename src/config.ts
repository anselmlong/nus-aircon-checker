import { env } from "node:process";

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  const v = env[name];
  return v && v.length > 0 ? v : undefined;
}

const botToken = required("TELEGRAM_BOT_TOKEN");
const allowedUserIds = (optional("TELEGRAM_ALLOWED_USER_IDS")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n) && n > 0) ?? []) as number[];

if (botToken.length < 40) {
  throw new Error("TELEGRAM_BOT_TOKEN appears invalid (too short)");
}

export const config = {
  telegram: {
    token: botToken,
    allowedUserIds,
  },
};

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT = "evs-bot-salt-v1";

export type UserCreds = {
  username: string;
  password: string;
};

export type UserReminder = {
  chatId: number;
  enabled: boolean;
};

// Daily usage record: date string (YYYY-MM-DD) -> amount spent
export type DailyUsageRecord = Record<string, number>;

type StorageData = {
  creds: Record<string, UserCreds>;
  reminders: Record<string, UserReminder>;
  dailyUsage: Record<string, DailyUsageRecord>; // userId -> { date -> amount }
};

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, KEY_LENGTH);
}

function encrypt(data: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload format");

  const iv = Buffer.from(parts[0]!, "base64");
  if (iv.length !== IV_LENGTH) throw new Error("Invalid IV length");
  const authTag = Buffer.from(parts[1]!, "base64");
  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error("Invalid auth tag length");
  const encrypted = Buffer.from(parts[2]!, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export class EncryptedStorage {
  private key: Buffer;
  private filePath: string;
  private creds: Map<number, UserCreds>;
  private reminders: Map<number, UserReminder>;
  private dailyUsage: Map<number, DailyUsageRecord>;

  constructor(encryptionKey: string, dataDir: string = process.cwd()) {
    if (!encryptionKey || encryptionKey.length < 16) {
      throw new Error("ENCRYPTION_KEY must be at least 16 characters");
    }
    this.key = deriveKey(encryptionKey);
    this.filePath = join(dataDir, ".evs-storage.enc");
    this.creds = new Map();
    this.reminders = new Map();
    this.dailyUsage = new Map();
  }

  load(): void {
    if (!existsSync(this.filePath)) {
      console.log("[storage] no existing data file, starting fresh");
      return;
    }

    try {
      const encrypted = readFileSync(this.filePath, "utf8");
      const json = decrypt(encrypted, this.key);
      const data: StorageData = JSON.parse(json);

      for (const [userId, cred] of Object.entries(data.creds)) {
        this.creds.set(Number(userId), cred);
      }

      for (const [userId, rem] of Object.entries(data.reminders)) {
        this.reminders.set(Number(userId), rem);
      }

      if (data.dailyUsage) {
        for (const [userId, usage] of Object.entries(data.dailyUsage)) {
          this.dailyUsage.set(Number(userId), usage);
        }
      }

      console.log(`[storage] loaded ${this.creds.size} credentials, ${this.reminders.size} reminders, ${this.dailyUsage.size} usage records`);
    } catch (e) {
      console.error("[storage] failed to load data:", e instanceof Error ? e.message : String(e));
      console.log("[storage] starting with empty data (old file may have wrong key)");
    }
  }

  private save(): void {
    const data: StorageData = {
      creds: Object.fromEntries(this.creds),
      reminders: Object.fromEntries(this.reminders),
      dailyUsage: Object.fromEntries(this.dailyUsage),
    };
    const json = JSON.stringify(data);
    const encrypted = encrypt(json, this.key);
    writeFileSync(this.filePath, encrypted, "utf8");
  }

  getCreds(userId: number): UserCreds | undefined {
    return this.creds.get(userId);
  }

  setCreds(userId: number, creds: UserCreds): void {
    this.creds.set(userId, creds);
    this.save();
  }

  deleteCreds(userId: number): void {
    this.creds.delete(userId);
    this.save();
  }

  getReminder(userId: number): UserReminder | undefined {
    return this.reminders.get(userId);
  }

  setReminder(userId: number, reminder: UserReminder): void {
    this.reminders.set(userId, reminder);
    this.save();
  }

  getAllReminders(): Map<number, UserReminder> {
    return new Map(this.reminders);
  }

  getAllCreds(): Map<number, UserCreds> {
    return new Map(this.creds);
  }

  // Daily usage tracking
  getDailyUsage(userId: number): DailyUsageRecord {
    return this.dailyUsage.get(userId) ?? {};
  }

  setDailyUsage(userId: number, date: string, amount: number): void {
    const existing = this.dailyUsage.get(userId) ?? {};
    existing[date] = amount;
    this.dailyUsage.set(userId, existing);
    this.save();
  }

  // Store multiple days at once (for backfilling from API)
  setDailyUsageBulk(userId: number, records: DailyUsageRecord): void {
    const existing = this.dailyUsage.get(userId) ?? {};
    for (const [date, amount] of Object.entries(records)) {
      existing[date] = amount;
    }
    this.dailyUsage.set(userId, existing);
    this.save();
  }

  // Get total spent over a date range
  getTotalSpent(userId: number, days: number): { total: number; dailyBreakdown: Array<{ date: string; amount: number }>; daysTracked: number } {
    const usage = this.dailyUsage.get(userId) ?? {};
    const today = new Date();
    const breakdown: Array<{ date: string; amount: number }> = [];
    let total = 0;

    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const amount = usage[dateStr] ?? 0;
      if (usage[dateStr] !== undefined) {
        breakdown.unshift({ date: dateStr, amount });
        total += amount;
      }
    }

    return { total, dailyBreakdown: breakdown, daysTracked: breakdown.length };
  }

  // Prune old records (keep last N days)
  pruneOldUsage(userId: number, keepDays: number = 90): void {
    const usage = this.dailyUsage.get(userId);
    if (!usage) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const pruned: DailyUsageRecord = {};
    for (const [date, amount] of Object.entries(usage)) {
      if (date >= cutoffStr) {
        pruned[date] = amount;
      }
    }

    this.dailyUsage.set(userId, pruned);
    this.save();
  }
}

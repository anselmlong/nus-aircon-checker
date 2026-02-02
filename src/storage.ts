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

type StorageData = {
  creds: Record<string, UserCreds>;
  reminders: Record<string, UserReminder>;
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
  const authTag = Buffer.from(parts[1]!, "base64");
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
  private canSave: boolean;

  constructor(encryptionKey: string, dataDir: string = process.cwd()) {
    if (!encryptionKey || encryptionKey.length < 16) {
      throw new Error("ENCRYPTION_KEY must be at least 16 characters");
    }
    this.key = deriveKey(encryptionKey);
    this.filePath = join(dataDir, ".evs-storage.enc");
    this.creds = new Map();
    this.reminders = new Map();
    this.canSave = true;
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

      console.log(`[storage] loaded ${this.creds.size} credentials, ${this.reminders.size} reminders`);
    } catch (e) {
      console.error("[storage] failed to load data:", e instanceof Error ? e.message : String(e));
      console.error("[storage] CRITICAL: Cannot decrypt existing file. Refusing to overwrite.");
      console.error("[storage] To fix: delete the file manually or correct ENCRYPTION_KEY");
      console.error(`[storage] File location: ${this.filePath}`);
      this.canSave = false;
    }
  }

  private save(): void {
    if (!this.canSave) {
      console.error("[storage] save blocked: cannot decrypt existing file");
      throw new Error("Cannot save: existing file decryption failed. Delete file manually or fix ENCRYPTION_KEY");
    }
    const data: StorageData = {
      creds: Object.fromEntries(this.creds),
      reminders: Object.fromEntries(this.reminders),
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
}

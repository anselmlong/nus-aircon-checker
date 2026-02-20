/**
 * EVS client wrapper with legacy fallback
 * Tries the main API first, falls back to legacy portal if login fails
 */

import { EvsClient, type Balances, type DailyUsage, type UsageRank } from "./evsClient.js";
import { LegacyEvsClient, type LegacyBalanceResult } from "./legacyEvsClient.js";

export type ClientMode = "main" | "legacy";

export type LoginResult = {
  mode: ClientMode;
  username: string;
};

export type BalanceResult = {
  mode: ClientMode;
  balance: number;
  lastUpdated?: string;
};

export type UsageResult = {
  mode: ClientMode;
  daily: DailyUsage[];
  avgPerDay: number;
};

export type RankResult = {
  mode: ClientMode;
  rankVal: number;
  usageLast7Days: number;
  updatedAt?: string;
};

// Errors that indicate the account works on legacy but not main API
const LEGACY_FALLBACK_ERRORS = [
  "user is disabled",
  "account disabled",
  "not authorized",
  "invalid credentials", // might work on legacy with different validation
];

function shouldFallbackToLegacy(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return LEGACY_FALLBACK_ERRORS.some((e) => msg.includes(e));
}

export class EvsClientWithFallback {
  private readonly mainClient: EvsClient;
  private readonly legacyClient: LegacyEvsClient;
  
  // Track which mode works for each user
  private userModes = new Map<string, ClientMode>();

  constructor() {
    this.mainClient = new EvsClient();
    this.legacyClient = new LegacyEvsClient();
  }

  private getUserMode(username: string): ClientMode | undefined {
    return this.userModes.get(username);
  }

  private setUserMode(username: string, mode: ClientMode): void {
    this.userModes.set(username, mode);
  }

  async login(username: string, password: string): Promise<LoginResult> {
    // If we already know this user needs legacy, try that first
    const knownMode = this.getUserMode(username);
    
    if (knownMode === "legacy") {
      await this.legacyClient.login(username, password);
      return { mode: "legacy", username };
    }

    // Try main API first
    try {
      await this.mainClient.login(username, password);
      this.setUserMode(username, "main");
      return { mode: "main", username };
    } catch (mainError) {
      // Check if we should try legacy fallback
      if (!shouldFallbackToLegacy(mainError)) {
        throw mainError; // Real error, don't fallback
      }

      console.log(`[evs] main API failed for ${username}, trying legacy fallback...`);

      // Try legacy
      try {
        await this.legacyClient.login(username, password);
        this.setUserMode(username, "legacy");
        console.log(`[evs] legacy fallback succeeded for ${username}`);
        return { mode: "legacy", username };
      } catch (legacyError) {
        // Both failed - throw the more informative error
        const mainMsg = mainError instanceof Error ? mainError.message : String(mainError);
        const legacyMsg = legacyError instanceof Error ? legacyError.message : String(legacyError);
        throw new Error(`Login failed on both APIs. Main: ${mainMsg}. Legacy: ${legacyMsg}`);
      }
    }
  }

  async getBalance(username: string, password: string): Promise<BalanceResult> {
    const knownMode = this.getUserMode(username);

    if (knownMode === "legacy") {
      const result = await this.legacyClient.getBalance(username, password);
      return {
        mode: "legacy",
        balance: result.balance,
        lastUpdated: result.lastUpdated,
      };
    }

    // Try main API
    try {
      const balances = await this.mainClient.getBalances(username, password);
      this.setUserMode(username, "main");
      
      // Get effective balance (money > meter credit)
      const money = balances.money?.moneyBalance;
      const meter = balances.meterCredit?.meterCreditBalance;
      const balance = (money !== null && Number.isFinite(money)) ? money :
                      (meter !== null && Number.isFinite(meter)) ? meter : 0;
      const lastUpdated = balances.money?.lastUpdated || balances.meterCredit?.lastUpdated;

      return { mode: "main", balance, lastUpdated };
    } catch (mainError) {
      if (!shouldFallbackToLegacy(mainError)) {
        throw mainError;
      }

      // Fallback to legacy
      try {
        const result = await this.legacyClient.getBalance(username, password);
        this.setUserMode(username, "legacy");
        return {
          mode: "legacy",
          balance: result.balance,
          lastUpdated: result.lastUpdated,
        };
      } catch (legacyError) {
        throw new Error(`Balance fetch failed on both APIs`);
      }
    }
  }

  async getBalances(username: string, password: string): Promise<{ balances: Balances; mode: ClientMode }> {
    const knownMode = this.getUserMode(username);

    if (knownMode === "legacy") {
      const result = await this.legacyClient.getBalance(username, password);
      // Convert legacy result to Balances format
      return {
        mode: "legacy",
        balances: {
          meterCredit: {
            meterCreditBalance: result.balance,
            lastUpdated: result.lastUpdated,
            endpointUsed: "legacy-portal",
          },
          money: {
            moneyBalance: null,
            lastUpdated: undefined,
            endpointUsed: "legacy-portal",
          },
        },
      };
    }

    try {
      const balances = await this.mainClient.getBalances(username, password);
      this.setUserMode(username, "main");
      return { mode: "main", balances };
    } catch (mainError) {
      if (!shouldFallbackToLegacy(mainError)) {
        throw mainError;
      }

      const result = await this.legacyClient.getBalance(username, password);
      this.setUserMode(username, "legacy");
      return {
        mode: "legacy",
        balances: {
          meterCredit: {
            meterCreditBalance: result.balance,
            lastUpdated: result.lastUpdated,
            endpointUsed: "legacy-portal",
          },
          money: {
            moneyBalance: null,
            lastUpdated: undefined,
            endpointUsed: "legacy-portal",
          },
        },
      };
    }
  }

  async getDailyUsage(username: string, password: string, days: number): Promise<UsageResult> {
    const knownMode = this.getUserMode(username);

    if (knownMode === "legacy") {
      throw new Error("Daily usage not available (legacy mode - only balance supported)");
    }

    try {
      const usage = await this.mainClient.getDailyUsage(username, password, days);
      this.setUserMode(username, "main");
      return {
        mode: "main",
        daily: usage.daily,
        avgPerDay: usage.avgPerDay,
      };
    } catch (error) {
      if (shouldFallbackToLegacy(error)) {
        // Can't get usage from legacy, but login works
        this.setUserMode(username, "legacy");
        throw new Error("Daily usage not available (your account only supports the legacy portal)");
      }
      throw error;
    }
  }

  async getUsageRank(username: string, password: string): Promise<RankResult> {
    const knownMode = this.getUserMode(username);

    if (knownMode === "legacy") {
      throw new Error("Usage rank not available (legacy mode - only balance supported)");
    }

    try {
      const rank = await this.mainClient.getUsageRank(username, password);
      this.setUserMode(username, "main");
      return {
        mode: "main",
        rankVal: rank.rankVal,
        usageLast7Days: rank.usageLast7Days,
        updatedAt: rank.updatedAt,
      };
    } catch (error) {
      if (shouldFallbackToLegacy(error)) {
        this.setUserMode(username, "legacy");
        throw new Error("Usage rank not available (your account only supports the legacy portal)");
      }
      throw error;
    }
  }

  logout(username?: string): void {
    this.mainClient.logout();
    this.legacyClient.logout();
    if (username) {
      this.userModes.delete(username);
    }
  }

  /**
   * Check which mode a user is using (for status display)
   */
  getModeForUser(username: string): ClientMode | undefined {
    return this.userModes.get(username);
  }
}

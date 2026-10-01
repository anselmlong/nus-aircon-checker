import { Mutex } from "./mutex.js";

const EVS_LOGIN_URL = "https://evs2u.evs.com.sg/login";

// Legacy portal URLs (fallback for disabled accounts)
const LEGACY_BASE = "https://nus-utown.evs.com.sg";
const LEGACY_LOGIN_URL = `${LEGACY_BASE}/EVSEntApp-war/loginServlet`;
const LEGACY_METER_CREDIT_URL = `${LEGACY_BASE}/EVSEntApp-war/viewMeterCreditServlet`;

const METER_CREDIT_ENDPOINT = "https://ore.evs.com.sg/evs1/get_credit_bal";
const MONEY_BALANCE_ENDPOINT = "https://ore.evs.com.sg/tcm/get_credit_balance";
const HISTORY_ENDPOINT = "https://ore.evs.com.sg/get_history";
const RECENT_USAGE_STAT_ENDPOINT = "https://ore.evs.com.sg/cp/get_recent_usage_stat";

type LoginState = {
  token: string;
  userId: number;
  username: string;
};

type CreditResult = {
  meterCreditBalance: number | null;  // null = not found/unavailable
  lastUpdated?: string;
};

type MoneyResult = {
  moneyBalance: number | null;  // null = not found/unavailable
  lastUpdated?: string;
};

export type Balances = {
  meterCredit: CreditResult;
  money: MoneyResult;
};

export type DailyUsage = {
  date: string;
  usage: number;
};

export type UsageRank = {
  // 0..1, where >0.5 indicates "less than X%" (better) and <0.5 indicates
  // "more than X%" (worse), matching the portal.
  rankVal: number;
  usageLast7Days: number;
  usageUnit?: string;
  updatedAt?: string;
};



function parseNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toEvsDateTime(d: Date): string {
  // Browser sends "YYYY-MM-DD HH:mm:ss.sssZ" (space instead of T).
  return d.toISOString().replace("T", " ");
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isEvsDebugEnabled(): boolean {
  return process.env.EVS_DEBUG === "1";
}

const SAFE_INFO_MESSAGES = new Set([
  "empty tariff",
  "empty balance",
  "empty result",
  "credit balance not found",
  "no data",
  "no history",
  "no reading",
  "no record",
  "no records",
  "not found",
]);

function isSafeInfoMessage(info: unknown): boolean {
  if (typeof info !== "string") return false;
  const lower = info.toLowerCase().trim();
  return SAFE_INFO_MESSAGES.has(lower) || lower.startsWith("no ");
}

// Errors that indicate we should try legacy fallback
const LEGACY_FALLBACK_ERRORS = ["user is disabled", "account disabled"];

function shouldTryLegacy(error: unknown): boolean {
  const msg = errMessage(error).toLowerCase();
  return LEGACY_FALLBACK_ERRORS.some((e) => msg.includes(e));
}

type LegacyState = {
  username: string;
  cookies: string[];
};

export class EvsClient {
  private loginState?: LoginState;
  private legacyState?: LegacyState;
  private legacyUsers = new Set<string>(); // track users that need legacy mode

  private readonly loginMutex = new Mutex();
  private readonly creditsMutex = new Mutex();

  private readonly evsDebug = isEvsDebugEnabled();
  private nextReqId = 1;

  logout(): void {
    this.loginState = undefined;
    this.legacyState = undefined;
  }

  // Pass { fresh: true } when verifying user-supplied credentials: the cached
  // session is keyed by username only, so it would accept any password.
  async login(username: string, password: string = "", options?: { fresh?: boolean; validateGuest?: boolean }): Promise<LoginState> {
    // No password = read-only (username-only) mode. Skip auth — data endpoints
    // don't validate Bearer tokens, so there's nothing to authenticate.
    if (!password) {
      const state: LoginState = { token: "guest", userId: 0, username };
      if (options?.validateGuest) {
        // Confirm the username actually resolves so a typo isn't silently accepted.
        const balances = await this.getBalances(username);
        this.assertBalancesFound(balances);
      }
      this.loginState = state;
      return state;
    }

    return this.loginMutex.run(async () => {
      // If already logged in with same user, return cached state
      if (!options?.fresh && this.loginState && this.loginState.username === username) return this.loginState;
      
      // If user is known to need legacy, use legacy login
      if (this.legacyUsers.has(username)) {
        return this.loginLegacy(username, password);
      }

      // Try main API first
      const resp = await this.evsFetch(
        EVS_LOGIN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
          },
          body: JSON.stringify({
            username,
            password,
            email: "",
            destPortal: "evs2cp",
            platform: "web",
          }),
        },
        "login",
      );

      let data: any;
      try {
        data = await resp.json();
      } catch {
        data = undefined;
      }

      if (!resp.ok) {
        const msg = data?.err || data?.error || `Login failed (${resp.status})`;
        const error = new Error(String(msg));

        // Check if we should try legacy fallback
        if (shouldTryLegacy(error)) {
          console.log(`[evs] main API returned "${msg}" for ${username}, trying legacy fallback...`);
          return this.loginLegacy(username, password);
        }

        throw error;
      }

      const token = data?.token;
      const userInfo = data?.userInfo;
      const userId = userInfo?.id;
      const u = userInfo?.username;

      if (typeof token !== "string" || token.length === 0) throw new Error("Login response missing token");
      if (typeof u !== "string" || u.length === 0) throw new Error("Login response missing username");
      if (typeof userId !== "number" || !Number.isFinite(userId)) throw new Error("Login response missing user id");

      this.loginState = { token, userId, username: u };
      return this.loginState;
    });
  }

  private async loginLegacy(username: string, password: string = ""): Promise<LoginState> {
    const formData = new URLSearchParams({
      txtLoginId: username,
      txtPassword: password,
    });

    const resp = await fetch(LEGACY_LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: LEGACY_BASE,
      },
      body: formData.toString(),
      redirect: "follow", // Follow redirects to detect login failures
    });

    // Collect cookies
    const cookies: string[] = [];
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const parts = c.split(";")[0];
      if (parts) cookies.push(parts);
    }

    const html = await resp.text();

    // Check if login failed (page still has login form = user not authenticated)
    if (html.includes("txtLoginId") && html.includes("txtPassword")) {
      // Extract error message if present
      let errorMsg = "Invalid credentials or account not found";

      if (html.includes("Invalid")) {
        errorMsg = "Invalid credentials";
      } else if (html.includes("not found") || html.includes("does not exist")) {
        errorMsg = "Account not found";
      } else if (html.includes("disabled")) {
        errorMsg = "Account is disabled";
      }

      throw new Error(errorMsg);
    }

    // Success - mark user as legacy and store state
    this.legacyUsers.add(username);
    this.legacyState = { username, cookies };

    // Return a pseudo LoginState for compatibility
    // Legacy portal doesn't give us token/userId, so we use placeholders
    this.loginState = { token: "legacy", userId: 0, username };
    console.log(`[evs] legacy login succeeded for ${username}`);
    return this.loginState;
  }

  async getBalances(loginUsername: string, loginPassword: string = ""): Promise<Balances> {
    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<Balances> => {
        const st = await this.login(loginUsername, loginPassword);

        // If user is in legacy mode, use legacy balance fetch
        if (this.legacyUsers.has(loginUsername)) {
          return this.fetchLegacyBalance(loginUsername, loginPassword);
        }

        const [meterCredit, money] = await Promise.allSettled([
          this.fetchMeterCreditBalance(st),
          this.fetchMoneyBalance(st),
        ]);

        // A hard failure on one source must not discard the other's value.
        // If BOTH hard-failed, surface the real error instead of masking it.
        if (meterCredit.status === "rejected" && money.status === "rejected") {
          throw meterCredit.reason;
        }
        const settle = <T extends object>(
          r: PromiseSettledResult<T>,
          empty: T,
        ): T => {
          if (r.status === "fulfilled") return r.value;
          console.warn(
            `[evs] balance source unavailable, using other source: ${(r.reason as Error)?.message ?? r.reason}`,
          );
          return empty;
        };

        return {
          meterCredit: settle(meterCredit, { meterCreditBalance: null, lastUpdated: undefined }),
          money: settle(money, { moneyBalance: null, lastUpdated: undefined }),
        };
      };

      return this.withAuthRetry(attempt);
    });
  }

  private assertBalancesFound(balances: Balances): void {
    const meter = balances.meterCredit.meterCreditBalance;
    const money = balances.money.moneyBalance;
    if (meter == null && money == null) {
      throw new Error("Account not found");
    }
  }

  private async fetchLegacyBalance(username: string, password: string = "", retryCount: number = 0): Promise<Balances> {
    // Ensure we have valid legacy session
    if (!this.legacyState || this.legacyState.username !== username) {
      await this.loginLegacy(username, password);
    }

    const resp = await fetch(LEGACY_METER_CREDIT_URL, {
      headers: {
        Cookie: this.legacyState!.cookies.join("; "),
        Referer: LEGACY_BASE,
      },
    });

    if (!resp.ok) {
      throw new Error(`Legacy balance fetch failed: HTTP ${resp.status}`);
    }

    const html = await resp.text();

    // Check if session expired
    if (html.includes("txtLoginId") && html.includes("txtPassword")) {
      // Re-login and retry once; a login form after a fresh login means the
      // portal isn't accepting our session, so retrying forever won't help.
      if (retryCount >= 1) {
        throw new Error("Legacy portal session rejected after re-login");
      }
      await this.loginLegacy(username, password);
      return this.fetchLegacyBalance(username, password, retryCount + 1);
    }

    // Parse balance from HTML
    const balance = this.parseLegacyBalance(html);
    const lastUpdated = this.parseLegacyTimestamp(html);

    return {
      meterCredit: {
        meterCreditBalance: balance,
        lastUpdated,
      },
      money: {
        moneyBalance: null,
        lastUpdated: undefined,
      },
    };
  }

  private parseLegacyBalance(html: string): number | null {
    // Look for "Total Balance: S$ XX.XX" or "Last Recorded Credit: S$ XX.XX"
    const patterns = [
      /Total Balance:\s*S?\$?\s*([\d.]+)/i,
      /Last Recorded Credit:\s*S?\$?\s*([\d.]+)/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        const val = parseFloat(match[1]);
        if (Number.isFinite(val)) return val;
      }
    }
    return null;
  }

  private parseLegacyTimestamp(html: string): string | undefined {
    // Look for "Last Recorded Timestamp: DD/MM/YYYY HH:mm:ss"
    const match = html.match(/Last Recorded Timestamp:\s*<\/td>\s*<td[^>]*>(?:<font[^>]*>)?([^<]+)/i);
    return match?.[1]?.trim();
  }

  async getUsageRank(loginUsername: string, loginPassword: string = ""): Promise<UsageRank> {
    // Legacy users don't have access to usage rank
    if (this.legacyUsers.has(loginUsername)) {
      throw new Error("Usage rank not available (legacy portal - only balance supported)");
    }

    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<UsageRank> => {
        const st = await this.login(loginUsername, loginPassword);
        return this.fetchRecentUsageStat(st);
      };

      return this.withAuthRetry(attempt);
    });
  }

  async getDailyUsage(loginUsername: string, loginPassword: string = "", lookbackDays: number = 7): Promise<{ daily: DailyUsage[]; avgPerDay: number }> {
    // Legacy users don't have access to daily usage
    if (this.legacyUsers.has(loginUsername)) {
      throw new Error("Daily usage not available (legacy portal - only balance supported)");
    }

    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<{ daily: DailyUsage[]; avgPerDay: number }> => {
        const st = await this.login(loginUsername, loginPassword);

        const end = new Date();
        const start = new Date(end.getTime() - Math.max(1, lookbackDays) * 24 * 60 * 60 * 1000);
        const points = await this.fetchHistoryDaily(st, start, end, Math.min(400, Math.max(7, lookbackDays + 3)));

        const byDate = new Map<string, number>();
        for (const p of points) {
          const rawTs = p.timestamp;
          const date = rawTs.length >= 10 ? rawTs.slice(0, 10) : rawTs;
          const v = p.diff ?? p.total;
          if (v == null) continue;
          const spent = Math.abs(v);
          byDate.set(date, (byDate.get(date) ?? 0) + spent);
        }

        const daily: DailyUsage[] = [];
        for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
          const date = toISODate(d);
          daily.push({ date, usage: byDate.get(date) ?? 0 });
        }

        // Exponential decay weighted average: recent days weighted more heavily (15%/day decay)
        const reversed = [...daily].reverse(); // index 0 = most recent
        const decayFactor = 0.85;
        const weights = reversed.map((_, i) => Math.pow(decayFactor, i));
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const avgPerDay = totalWeight > 0
          ? reversed.reduce((sum, d, i) => sum + d.usage * weights[i], 0) / totalWeight
          : 0;

        return { daily, avgPerDay };
      };

      return this.withAuthRetry(attempt);
    });
  }



  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const msg = errMessage(e);
      if (!msg.includes("403") && !msg.toLowerCase().includes("not authorized")) throw e;
      this.logout();
      return await fn();
    }
  }

  private async evsFetch(url: string, init: RequestInit, op: string): Promise<Response> {
    const reqId = this.nextReqId++;
    const startedAt = Date.now();
    const timeoutMs = 20_000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

    const mergedInit: RequestInit = {
      ...init,
      signal: controller.signal,
    };

    if (this.evsDebug) {
      console.log(`[evs][${reqId}] start op=${op} url=${url}`);
    }

    try {
      const resp = await fetch(url, mergedInit);
      const ms = Date.now() - startedAt;
      if (this.evsDebug || !resp.ok || ms > 2000) {
        console.log(`[evs][${reqId}] done op=${op} status=${resp.status} ${ms}ms url=${url}`);
      }
      return resp;
    } catch (e) {
      const ms = Date.now() - startedAt;
      console.error(`[evs][${reqId}] fail op=${op} ${ms}ms url=${url} err=${errMessage(e)}`);
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postClaim(
    st: LoginState,
    endpoint: string,
    target: string,
    body: Record<string, unknown>,
    opts: {
      claimEndpoint?: string;
      operation?: "read" | "list";
      userId?: number | null;
      portalHeaders?: boolean;
      op?: string;
    } = {},
  ): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=UTF-8",
      Authorization: `Bearer ${st.token}`,
    };
    if (opts.portalHeaders) {
      headers.accept = "*/*";
      headers.origin = "https://cp2nus.evs.com.sg";
      headers.referer = "https://cp2nus.evs.com.sg/";
    }

    const resp = await this.evsFetch(
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          svcClaimDto: {
            username: st.username,
            user_id: Object.hasOwn(opts, "userId") ? opts.userId! : st.userId,
            svcName: "oresvc",
            endpoint: opts.claimEndpoint ?? endpoint,
            scope: "self",
            target,
            operation: opts.operation ?? "read",
          },
          request: body,
        }),
      },
      opts.op ?? endpoint,
    );

    let data: any;
    try {
      data = await resp.json();
    } catch {
      data = undefined;
    }

    if (resp.status === 403) throw new Error("Not authorized (403)");
    if (!resp.ok) throw new Error(String(data?.error || data?.err || `HTTP ${resp.status}`));
    if (data?.error) throw new Error(String(data.error));
    if (data?.info && typeof data.info === "string" && !isSafeInfoMessage(data.info)) {
      // A well-formed `info` is a benign "no data for this endpoint" note, not an
      // error. Unexpected ones get logged (so we spot new variants) but never
      // thrown — the typed caller decides whether a missing field is an empty.
      console.warn(`[evs] benign info (unexpected): ${data.info}`);
    }

    return data;
  }

  private async fetchBalanceField(
    st: LoginState,
    endpoint: string,
    op: string,
    field: "credit_bal" | "ref_bal",
  ): Promise<{ balance: number | null; lastUpdated?: string }> {
    const data = await this.postClaim(
      st,
      endpoint,
      "meter_p_credit_balance",
      { meter_displayname: st.username },
      { op },
    );

    // Balance field missing with a benign info message ("credit balance not
    // found", ...) means unavailable, not zero.
    if (data?.[field] === undefined && data?.info) {
      return { balance: null, lastUpdated: undefined };
    }

    const lastUpdated =
      (typeof data?.tariff_timestamp === "string" ? data.tariff_timestamp : undefined) ??
      (typeof data?.last_updated === "string" ? data.last_updated : undefined);

    return { balance: parseNumber(data?.[field]) ?? null, lastUpdated };
  }

  private async fetchMeterCreditBalance(st: LoginState): Promise<CreditResult> {
    const res = await this.fetchBalanceField(st, METER_CREDIT_ENDPOINT, "get_credit_bal", "credit_bal");
    return { meterCreditBalance: res.balance, lastUpdated: res.lastUpdated };
  }

  private async fetchMoneyBalance(st: LoginState): Promise<MoneyResult> {
    const res = await this.fetchBalanceField(st, MONEY_BALANCE_ENDPOINT, "get_credit_balance", "ref_bal");
    return { moneyBalance: res.balance, lastUpdated: res.lastUpdated };
  }

  private async fetchRecentUsageStat(st: LoginState): Promise<UsageRank> {
    const data = await this.postClaim(
      st,
      RECENT_USAGE_STAT_ENDPOINT,
      "meter.reading",
      {
        meter_displayname: st.username,
        look_back_hours: 168,
        convert_to_money: true,
      },
      {
        op: "get_recent_usage_stat",
        claimEndpoint: "/cp/get_recent_usage_stat",
        operation: "list",
        userId: null,
        portalHeaders: true,
      },
    );

    const rank = data?.usage_stat?.kwh_rank_in_building;
    const rankVal = parseNumber(rank?.rank_val) ?? 0.5;
    const usageLast7Days = parseNumber(rank?.ref_val) ?? 0;
    const updatedAt = typeof rank?.updated_timestamp === "string" ? rank.updated_timestamp : undefined;
    const usageUnit = typeof rank?.ref_val_unit === "string" ? rank.ref_val_unit : undefined;

    return {
      rankVal,
      usageLast7Days: Math.abs(usageLast7Days),
      usageUnit,
      updatedAt,
    };
  }

  private async fetchHistoryDaily(
    st: LoginState,
    start: Date,
    end: Date,
    maxRecords: number,
  ): Promise<Array<{ timestamp: string; diff?: number; total?: number }>> {
    const data = await this.postClaim(
      st,
      HISTORY_ENDPOINT,
      "meter.reading",
      {
        meter_displayname: st.username,
        history_type: "meter_reading_daily",
        start_datetime: toEvsDateTime(start),
        end_datetime: toEvsDateTime(end),
        normalization: "meter_reading_daily",
        max_number_of_records: String(Math.max(1, Math.floor(maxRecords))),
        convert_to_money: "true",
        check_bypass: "true",
      },
      {
        op: "get_history",
        claimEndpoint: "/get_history",
        operation: "list",
        userId: null,
        portalHeaders: true,
      },
    );

    const root = data?.meter_reading_daily;
    const history = Array.isArray(root?.history) ? root.history : [];

    const points: Array<{ timestamp: string; diff?: number; total?: number }> = [];
    for (const raw of history) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      const timestamp = typeof obj.reading_timestamp === "string" ? obj.reading_timestamp : "";
      const diff = parseNumber(obj.reading_diff);
      const total = parseNumber(obj.reading_total);
      if (timestamp.length === 0 && diff == null && total == null) continue;
      points.push({ timestamp, diff, total });
    }

    return points;
  }

}

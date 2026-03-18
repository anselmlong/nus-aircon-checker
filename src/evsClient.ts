import { Mutex } from "./mutex.js";

const EVS_LOGIN_URL = "https://evs2u.evs.com.sg/login";

// Legacy portal URLs (fallback for disabled accounts)
const LEGACY_BASE = "https://nus-utown.evs.com.sg";
const LEGACY_LOGIN_URL = `${LEGACY_BASE}/EVSEntApp-war/loginServlet`;
const LEGACY_METER_CREDIT_URL = `${LEGACY_BASE}/EVSEntApp-war/viewMeterCreditServlet`;

const METER_CREDIT_ENDPOINT = "https://ore.evs.com.sg/evs1/get_credit_bal";
const MONEY_BALANCE_ENDPOINT = "https://ore.evs.com.sg/tcm/get_credit_balance";

const METER_INFO_ENDPOINT = "https://ore.evs.com.sg/cp/get_meter_info";
const HISTORY_ENDPOINT = "https://ore.evs.com.sg/get_history";
const RECENT_USAGE_STAT_ENDPOINT = "https://ore.evs.com.sg/cp/get_recent_usage_stat";
const MONTH_TO_DATE_USAGE_ENDPOINT = "https://ore.evs.com.sg/get_month_to_date_usage";

type LoginState = {
  token: string;
  userId: number;
  username: string;
};

type CreditResult = {
  meterCreditBalance: number | null;  // null = not found/unavailable
  lastUpdated?: string;
  endpointUsed: string;
};

type MoneyResult = {
  moneyBalance: number | null;  // null = not found/unavailable
  lastUpdated?: string;
  endpointUsed: string;
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
  endpointUsed: string;
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

const DEBUG_USERS = new Set(["10010010"]);

const SAFE_INFO_MESSAGES = new Set([
  "empty tariff",
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
  private readonly meterDisplaynameOverride?: string;

  private loginState?: LoginState;
  private legacyState?: LegacyState;
  private legacyUsers = new Set<string>(); // track users that need legacy mode
  
  private readonly loginMutex = new Mutex();
  private readonly creditsMutex = new Mutex();

  private readonly evsDebug = isEvsDebugEnabled();
  private nextReqId = 1;

  constructor(meterDisplaynameOverride?: string) {
    this.meterDisplaynameOverride = meterDisplaynameOverride;
  }

  logout(): void {
    this.loginState = undefined;
    this.legacyState = undefined;
  }
  
  isLegacyUser(username: string): boolean {
    return this.legacyUsers.has(username);
  }

  async login(username: string, password: string): Promise<LoginState> {
    return this.loginMutex.run(async () => {
      // If already logged in with same user, return cached state
      if (this.loginState && this.loginState.username === username) return this.loginState;
      
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
  
  private async loginLegacy(username: string, password: string): Promise<LoginState> {
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
      redirect: "manual",
    });

    // Collect cookies
    const cookies: string[] = [];
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const parts = c.split(";")[0];
      if (parts) cookies.push(parts);
    }

    const html = await resp.text();

    // Check if login failed (still on login page)
    if (html.includes("txtLoginId") && html.includes("txtPassword")) {
      if (html.includes("Invalid") || html.includes("incorrect")) {
        throw new Error("Invalid credentials");
      }
      throw new Error("Login failed on legacy portal");
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

  async getCreditBalance(loginUsername: string, loginPassword: string): Promise<CreditResult> {
    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<CreditResult> => {
        const st = await this.login(loginUsername, loginPassword);
        const meterDisplayname = this.meterDisplaynameOverride ?? st.username;
        return this.fetchMeterCreditBalance(st, meterDisplayname);
      };

      return this.withAuthRetry(attempt);
    });
  }

  async getBalances(loginUsername: string, loginPassword: string): Promise<Balances> {
    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<Balances> => {
        const st = await this.login(loginUsername, loginPassword);
        
        // If user is in legacy mode, use legacy balance fetch
        if (this.legacyUsers.has(loginUsername)) {
          return this.fetchLegacyBalance(loginUsername, loginPassword);
        }
        
        const meterDisplayname = this.meterDisplaynameOverride ?? st.username;

        const [meterCredit, money] = await Promise.all([
          this.fetchMeterCreditBalance(st, meterDisplayname),
          this.fetchMoneyBalance(st, meterDisplayname),
        ]);

        return { meterCredit, money };
      };

      return this.withAuthRetry(attempt);
    });
  }
  
  private async fetchLegacyBalance(username: string, password: string): Promise<Balances> {
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
      // Re-login and retry
      await this.loginLegacy(username, password);
      return this.fetchLegacyBalance(username, password);
    }

    // Parse balance from HTML
    const balance = this.parseLegacyBalance(html);
    const lastUpdated = this.parseLegacyTimestamp(html);

    return {
      meterCredit: {
        meterCreditBalance: balance,
        lastUpdated,
        endpointUsed: "legacy-portal",
      },
      money: {
        moneyBalance: null,
        lastUpdated: undefined,
        endpointUsed: "legacy-portal",
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

  async getMeterInfo(loginUsername: string, loginPassword: string): Promise<unknown> {
    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<unknown> => {
        const st = await this.login(loginUsername, loginPassword);
        const meterDisplayname = this.meterDisplaynameOverride ?? st.username;
        return this.fetchMeterInfo(st, meterDisplayname);
      };

      return this.withAuthRetry(attempt);
    });
  }

  async getMonthToDateUsage(loginUsername: string, loginPassword: string): Promise<{ usage: number; endpointUsed: string }> {
    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<{ usage: number; endpointUsed: string }> => {
        const st = await this.login(loginUsername, loginPassword);
        const meterDisplayname = this.meterDisplaynameOverride ?? st.username;
        return this.fetchMonthToDateUsage(st, meterDisplayname);
      };

      return this.withAuthRetry(attempt);
    });
  }

  async getUsageRank(loginUsername: string, loginPassword: string): Promise<UsageRank> {
    // Legacy users don't have access to usage rank
    if (this.legacyUsers.has(loginUsername)) {
      throw new Error("Usage rank not available (legacy portal - only balance supported)");
    }
    
    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<UsageRank> => {
        const st = await this.login(loginUsername, loginPassword);
        const meterDisplayname = this.meterDisplaynameOverride ?? st.username;
        return this.fetchRecentUsageStat(st, meterDisplayname);
      };

      return this.withAuthRetry(attempt);
    });
  }

  async getDailyUsage(loginUsername: string, loginPassword: string, lookbackDays: number): Promise<{ daily: DailyUsage[]; avgPerDay: number; endpointUsed: string }> {
    // Legacy users don't have access to daily usage
    if (this.legacyUsers.has(loginUsername)) {
      throw new Error("Daily usage not available (legacy portal - only balance supported)");
    }
    
    return this.creditsMutex.run(async () => {
      const attempt = async (): Promise<{ daily: DailyUsage[]; avgPerDay: number; endpointUsed: string }> => {
        const st = await this.login(loginUsername, loginPassword);
        const meterDisplayname = this.meterDisplaynameOverride ?? st.username;

        const end = new Date();
        const start = new Date(end.getTime() - Math.max(1, lookbackDays) * 24 * 60 * 60 * 1000);
        const series = await this.fetchHistoryDaily(st, meterDisplayname, start, end, Math.min(400, Math.max(7, lookbackDays + 3)));

        const byDate = new Map<string, number>();
        for (const p of series.points) {
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

        const total = daily.reduce((acc, x) => acc + x.usage, 0);
        const avgPerDay = daily.length > 0 ? total / daily.length : 0;

        return { daily, avgPerDay, endpointUsed: series.endpointUsed };
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

  private async fetchMeterCreditBalance(st: LoginState, meterDisplayname: string): Promise<CreditResult> {
    const endpoint = METER_CREDIT_ENDPOINT;
    const resp = await this.evsFetch(
      endpoint,
      {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Authorization: `Bearer ${st.token}`,
      },
      body: JSON.stringify({
        svcClaimDto: {
          username: st.username,
          user_id: st.userId,
          svcName: "oresvc",
          endpoint,
          scope: "self",
          target: "meter_p_credit_balance",
          operation: "read",
        },
        request: {
          meter_displayname: meterDisplayname,
        },
      }),
      },
      "get_credit_bal",
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
    
    // Check if balance data is actually present (not just an info message)
    const hasBalanceData = data?.credit_bal !== undefined;
    if (!hasBalanceData && data?.info && isSafeInfoMessage(data.info)) {
      // Balance not found - return null instead of 0
      return {
        meterCreditBalance: null,
        lastUpdated: undefined,
        endpointUsed: endpoint,
      };
    }
    if (data?.info && !isSafeInfoMessage(data.info)) throw new Error(String(data.info));

    const meterCreditBalance = parseNumber(data?.credit_bal) ?? null;

    // Debug logging for specific users
    if (DEBUG_USERS.has(st.username)) {
      console.log(`[debug][${st.username}] fetchMeterCreditBalance response:`, JSON.stringify(data, null, 2));
    }

    const lastUpdated =
      (typeof data?.tariff_timestamp === "string" ? data.tariff_timestamp : undefined) ??
      (typeof data?.last_updated === "string" ? data.last_updated : undefined);

    return {
      meterCreditBalance,
      lastUpdated,
      endpointUsed: endpoint,
    };
  }

  private async fetchMoneyBalance(st: LoginState, meterDisplayname: string): Promise<MoneyResult> {
    const endpoint = MONEY_BALANCE_ENDPOINT;
    const resp = await this.evsFetch(
      endpoint,
      {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Authorization: `Bearer ${st.token}`,
      },
      body: JSON.stringify({
        svcClaimDto: {
          username: st.username,
          user_id: st.userId,
          svcName: "oresvc",
          endpoint,
          scope: "self",
          target: "meter_p_credit_balance",
          operation: "read",
        },
        request: {
          meter_displayname: meterDisplayname,
        },
      }),
      },
      "get_credit_balance",
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
    
    // Check if balance data is actually present (not just an info message)
    const hasBalanceData = data?.ref_bal !== undefined;
    if (!hasBalanceData && data?.info && isSafeInfoMessage(data.info)) {
      // Balance not found - return null instead of 0
      return {
        moneyBalance: null,
        lastUpdated: undefined,
        endpointUsed: endpoint,
      };
    }
    if (data?.info && !isSafeInfoMessage(data.info)) throw new Error(String(data.info));

    const moneyBalance = parseNumber(data?.ref_bal) ?? null;

    // Debug logging for specific users
    if (DEBUG_USERS.has(st.username)) {
      console.log(`[debug][${st.username}] fetchMoneyBalance response:`, JSON.stringify(data, null, 2));
    }

    const lastUpdated =
      (typeof data?.tariff_timestamp === "string" ? data.tariff_timestamp : undefined) ??
      (typeof data?.last_updated === "string" ? data.last_updated : undefined);

    return {
      moneyBalance,
      lastUpdated,
      endpointUsed: endpoint,
    };
  }

  private async fetchMeterInfo(st: LoginState, meterDisplayname: string): Promise<unknown> {
    const endpoint = METER_INFO_ENDPOINT;
    const resp = await this.evsFetch(
      endpoint,
      {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Authorization: `Bearer ${st.token}`,
      },
      body: JSON.stringify({
        svcClaimDto: {
          username: st.username,
          user_id: st.userId,
          svcName: "oresvc",
          endpoint,
          scope: "self",
          target: "meter_p_info",
          operation: "read",
        },
        request: {
          meter_displayname: meterDisplayname,
        },
      }),
      },
      "get_meter_info",
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
    if (data?.info && !isSafeInfoMessage(data.info)) throw new Error(String(data.info));

    return data?.meter_info ?? data ?? {};
  }

  private async fetchMonthToDateUsage(st: LoginState, meterDisplayname: string): Promise<{ usage: number; endpointUsed: string }> {
    const endpoint = MONTH_TO_DATE_USAGE_ENDPOINT;
    const resp = await this.evsFetch(
      endpoint,
      {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Authorization: `Bearer ${st.token}`,
      },
      body: JSON.stringify({
        svcClaimDto: {
          username: st.username,
          user_id: st.userId,
          svcName: "oresvc",
          endpoint,
          scope: "self",
          target: "meter_p_reading",
          operation: "read",
        },
        request: {
          meter_displayname: meterDisplayname,
        },
      }),
      },
      "get_month_to_date_usage",
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
    if (data?.info && !isSafeInfoMessage(data.info)) throw new Error(String(data.info));

    const usage = parseNumber(data?.month_to_date_usage) ?? 0;

    return {
      usage,
      endpointUsed: endpoint,
    };
  }

  private async fetchRecentUsageStat(st: LoginState, meterDisplayname: string): Promise<UsageRank> {
    const endpoint = RECENT_USAGE_STAT_ENDPOINT;
    const resp = await this.evsFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "Content-Type": "application/json; charset=UTF-8",
          authorization: `Bearer ${st.token}`,
          origin: "https://cp2nus.evs.com.sg",
          referer: "https://cp2nus.evs.com.sg/",
        },
        body: JSON.stringify({
          svcClaimDto: {
            username: st.username,
            user_id: null,
            svcName: "oresvc",
            endpoint: "/cp/get_recent_usage_stat",
            scope: "self",
            target: "meter.reading",
            operation: "list",
          },
          request: {
            meter_displayname: meterDisplayname,
            look_back_hours: 168,
            convert_to_money: true,
          },
        }),
      },
      "get_recent_usage_stat",
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
    if (data?.info && !isSafeInfoMessage(data.info)) throw new Error(String(data.info));

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
      endpointUsed: endpoint,
    };
  }

  private async fetchHistoryDaily(
    st: LoginState,
    meterDisplayname: string,
    start: Date,
    end: Date,
    maxRecords: number,
  ): Promise<{ points: Array<{ timestamp: string; diff?: number; total?: number }>; endpointUsed: string }> {
    const endpoint = HISTORY_ENDPOINT;
    const resp = await this.evsFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "Content-Type": "application/json; charset=UTF-8",
          authorization: `Bearer ${st.token}`,
          origin: "https://cp2nus.evs.com.sg",
          referer: "https://cp2nus.evs.com.sg/",
        },
        body: JSON.stringify({
          svcClaimDto: {
            username: st.username,
            user_id: null,
            svcName: "oresvc",
            endpoint: "/get_history",
            scope: "self",
            target: "meter.reading",
            operation: "list",
          },
          request: {
            meter_displayname: meterDisplayname,
            history_type: "meter_reading_daily",
            start_datetime: toEvsDateTime(start),
            end_datetime: toEvsDateTime(end),
            normalization: "meter_reading_daily",
            max_number_of_records: String(Math.max(1, Math.floor(maxRecords))),
            convert_to_money: "true",
            check_bypass: "true",
          },
        }),
      },
      "get_history",
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
    if (data?.info && !isSafeInfoMessage(data.info)) throw new Error(String(data.info));

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

    return { points, endpointUsed: endpoint };
  }

}

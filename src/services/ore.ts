const ORE_BASE = "https://ore.evs.com.sg";

const ORE_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/json; charset=UTF-8",
  Origin: "https://cp2.evs.com.sg",
  Referer: "https://cp2.evs.com.sg/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  Authorization: "Bearer",
};

function toIsoRange(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d{3}/, "");
  return { start: fmt(start), end: fmt(end) };
}

function toIsoRangeHours(hours: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d{3}/, "");
  return { start: fmt(start), end: fmt(end) };
}

async function orePost(path: string, body: unknown): Promise<Response> {
  return fetch(`${ORE_BASE}/${path}`, {
    method: "POST",
    headers: ORE_HEADERS,
    body: JSON.stringify(body),
  });
}

export type HistoryEntry = {
  datetime?: string;
  reading_diff?: number | null;
};

export type UsageRank = {
  rankVal: number;
  usageLast7Days: number;
  updatedAt?: string;
};

export type AnalyzedUsage = {
  avgDaily: number | null;
  total: number | null;
  lastDay: number | null;
  zeroStreak: number;
  spike: { lastDay: number; avgDaily: number; factor: number } | null;
  warnings: string[];
};

export type MeterInfo = {
  address?: string | null;
  premise?: { block?: string; level?: string; unit?: string; building?: string };
  [key: string]: unknown;
};

export type MeterSummary = {
  meter_info: MeterInfo | null;
  address: string | null;
  credit_bal: number | null;
};

export async function getMeterInfo(meterId: string): Promise<MeterInfo | null> {
  const resp = await orePost("cp/get_meter_info", {
    request: { meter_displayname: meterId },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data?.meter_info as MeterInfo) ?? null;
}

export async function getMeterSummary(meterId: string): Promise<MeterSummary> {
  const [meterInfoResult, creditBalResult] = await Promise.allSettled([
    getMeterInfo(meterId),
    getCreditBalance(meterId),
  ]);
  const meterInfo = meterInfoResult.status === "fulfilled" ? meterInfoResult.value : null;
  return {
    meter_info: meterInfo,
    address: meterInfo?.address ?? null,
    credit_bal: creditBalResult.status === "fulfilled" ? creditBalResult.value : null,
  };
}

export async function getCreditBalance(meterId: string): Promise<number | null> {
  const resp = await orePost("tcm/get_credit_balance", {
    request: { meter_displayname: meterId },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  // API returns ref_bal as string or number
  const val = data?.ref_bal;
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function getMeterUsage(
  meterId: string,
  days = 7,
): Promise<{ days: number; history: HistoryEntry[]; meta: unknown }> {
  const { start, end } = toIsoRange(days);
  const resp = await orePost("get_history", {
    request: {
      meter_displayname: meterId,
      history_type: "meter_reading_daily",
      start_datetime: start,
      end_datetime: end,
      normalization: "meter_reading_daily",
      max_number_of_records: "1000",
      convert_to_money: "true",
      check_bypass: "true",
    },
  });
  if (!resp.ok) throw new Error(`get_history failed: HTTP ${resp.status}`);
  const data = await resp.json();
  const block = data?.meter_reading_daily ?? {};
  return {
    days,
    history: Array.isArray(block.history) ? (block.history as HistoryEntry[]) : [],
    meta: block.meta ?? null,
  };
}

export type NightlyUsage = {
  date: string;
  amount: number;
};

export async function getNightlyUsageDelta(
  meterId: string,
  nights = 7,
): Promise<{ nightly: NightlyUsage[] }> {
  const hours = 48;
  const { start, end } = toIsoRangeHours(hours);
  const resp = await orePost("get_history", {
    request: {
      meter_displayname: meterId,
      history_type: "meter_reading_hourly",
      start_datetime: start,
      end_datetime: end,
      max_number_of_records: "50",
      convert_to_money: "true",
    },
  });
  if (!resp.ok) throw new Error(`get_history hourly failed: HTTP ${resp.status}`);
  const data = await resp.json();
  const history = data?.meter_reading_hourly?.history ?? [];

  const sorted = [...history].sort((a, b) =>
    (a.reading_timestamp ?? "").localeCompare(b.reading_timestamp ?? "")
  );

  const latest = sorted[sorted.length - 1];
  const yesterday = sorted.find(h => {
    const ts = h.reading_timestamp;
    if (!ts) return false;
    const d = new Date(ts);
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    return ts.startsWith(yesterdayDate.toISOString().slice(0, 10));
  });

  if (!latest?.reading_total || !yesterday?.reading_total) {
    return { nightly: [] };
  }

  const latestTotal = Number(latest.reading_total);
  const yesterdayTotal = Number(yesterday.reading_total);
  const delta = Math.max(0, latestTotal - yesterdayTotal);

  return {
    nightly: [{ date: new Date().toISOString().slice(0, 10), amount: delta }],
  };
}

export async function getUsageRank(meterId: string): Promise<UsageRank> {
  const resp = await orePost("cp/get_recent_usage_stat", {
    request: {
      meter_displayname: meterId,
      look_back_hours: 168,
      convert_to_money: true,
    },
  });
  if (resp.status === 403) throw new Error("Usage rank not available for this meter.");
  if (!resp.ok) throw new Error(`get_recent_usage_stat failed: HTTP ${resp.status}`);
  const data = await resp.json();
  const rank = data?.usage_stat?.kwh_rank_in_building;
  return {
    rankVal: typeof rank?.rank_val === "number" ? rank.rank_val : 0.5,
    usageLast7Days: Math.abs(typeof rank?.ref_val === "number" ? rank.ref_val : 0),
    updatedAt: typeof rank?.updated_timestamp === "string" ? rank.updated_timestamp : undefined,
  };
}

export function analyzeUsage(history: HistoryEntry[], creditBal: number | null): AnalyzedUsage {
  const diffs = history
    .map((x) => Number(x.reading_diff))
    .filter((n) => Number.isFinite(n) && n >= 0);

  if (!diffs.length) {
    return { avgDaily: null, total: null, lastDay: null, zeroStreak: 0, spike: null, warnings: [] };
  }

  // Weighted average: recent days weighted more heavily, 15% decay per day
  const decayFactor = 0.85;
  const weights = diffs.map((_, i) => Math.pow(decayFactor, i));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const avgDaily = diffs.reduce((sum, d, i) => sum + d * weights[i], 0) / totalWeight;

  const total = diffs.reduce((a, b) => a + b, 0);
  const lastDay = diffs[0] ?? null;

  let zeroStreak = 0;
  for (const d of diffs) {
    if (d <= 0.05) zeroStreak += 1;
    else break;
  }

  // Use weighted avg for spike detection and days-left calculation
  let spike: AnalyzedUsage["spike"] = null;
  if (avgDaily > 0 && lastDay != null && lastDay >= avgDaily * 2.5 && lastDay >= 1) {
    spike = { lastDay, avgDaily, factor: lastDay / avgDaily };
  }

  const warnings: string[] = [];
  if (zeroStreak >= 3) {
    warnings.push(`🟡 Usage has been near zero for ${zeroStreak} day(s).`);
  }
  if (spike) {
    warnings.push(
      `🔴 Yesterday's usage (${spike.lastDay.toFixed(2)}) is much higher than your recent average (${spike.avgDaily.toFixed(2)}).`,
    );
  }
  const bal = Number(creditBal);
  if (Number.isFinite(bal) && avgDaily > 0) {
    const daysLeft = bal / avgDaily;
    if (daysLeft <= 3) {
      warnings.push(
        `🟠 Current balance may last only about ${daysLeft.toFixed(1)} day(s) at your recent usage.`,
      );
    }
  }

  return { avgDaily: avgDaily ?? null, total, lastDay, zeroStreak, spike, warnings };
}

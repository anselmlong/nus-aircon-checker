#!/usr/bin/env npx ts-node
/**
 * Meter API Test Script
 * Tests balance fetching for meters from CSV to validate API robustness.
 * 
 * Usage:
 *   npx ts-node scripts/test-meters.ts [options]
 * 
 * Options:
 *   --csv <path>       Path to meters CSV (default: /tmp/meters_data/meters.csv)
 *   --sample <n>       Test random sample of n meters (default: 50)
 *   --building <name>  Filter by building name
 *   --all              Test all meters (warning: slow + rate limits)
 *   --dry-run          Just parse CSV and show stats, no API calls
 */

import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const EVS_LOGIN_URL = "https://evs2u.evs.com.sg/login";
const METER_CREDIT_ENDPOINT = "https://ore.evs.com.sg/evs1/get_credit_bal";
const MONEY_BALANCE_ENDPOINT = "https://ore.evs.com.sg/tcm/get_credit_balance";
const METER_INFO_ENDPOINT = "https://ore.evs.com.sg/cp/get_meter_info";

// Test account - needs valid creds to get auth token
const TEST_USERNAME = process.env.TEST_USERNAME || "";
const TEST_PASSWORD = process.env.TEST_PASSWORD || "";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface MeterRecord {
  meter_displayname: string;
  unit: string;
  level: string;
  block: string;
  building: string;
  address: string;
  mms_online_timestamp: string | null;
  esim_id: string;
  tariff_price: string;
}

interface TestResult {
  meter_displayname: string;
  building: string;
  online: boolean;
  meterCreditBalance: number | null;
  moneyBalance: number | null;
  meterCreditError: string | null;
  moneyError: string | null;
  meterCreditRaw: any;
  moneyRaw: any;
  meterInfo: any;
  meterInfoError: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

async function login(username: string, password: string): Promise<{ token: string; userId: number; username: string }> {
  const resp = await fetch(EVS_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      username,
      password,
      email: "",
      destPortal: "evs2cp",
      platform: "web",
    }),
  });

  const data = await resp.json() as any;
  if (!resp.ok) throw new Error(data?.err || data?.error || `Login failed (${resp.status})`);

  return {
    token: data.token,
    userId: data.userInfo?.id,
    username: data.userInfo?.username,
  };
}

async function fetchMeterCredit(token: string, username: string, userId: number, meterDisplayname: string): Promise<{ balance: number | null; error: string | null; raw: any }> {
  try {
    const resp = await fetch(METER_CREDIT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        svcClaimDto: {
          username,
          user_id: userId,
          svcName: "oresvc",
          endpoint: METER_CREDIT_ENDPOINT,
          scope: "self",
          target: "meter_p_credit_balance",
          operation: "read",
        },
        request: { meter_displayname: meterDisplayname },
      }),
    });

    const data = await resp.json() as any;
    
    if (!resp.ok) {
      return { balance: null, error: `HTTP ${resp.status}`, raw: data };
    }
    if (data?.error) {
      return { balance: null, error: String(data.error), raw: data };
    }
    
    const balance = parseFloat(data?.credit_bal);
    return {
      balance: Number.isFinite(balance) ? balance : null,
      error: null,
      raw: data,
    };
  } catch (e) {
    return { balance: null, error: e instanceof Error ? e.message : String(e), raw: null };
  }
}

async function fetchMoneyBalance(token: string, username: string, userId: number, meterDisplayname: string): Promise<{ balance: number | null; error: string | null; raw: any }> {
  try {
    const resp = await fetch(MONEY_BALANCE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        svcClaimDto: {
          username,
          user_id: userId,
          svcName: "oresvc",
          endpoint: MONEY_BALANCE_ENDPOINT,
          scope: "self",
          target: "meter_p_credit_balance",
          operation: "read",
        },
        request: { meter_displayname: meterDisplayname },
      }),
    });

    const data = await resp.json() as any;
    
    if (!resp.ok) {
      return { balance: null, error: `HTTP ${resp.status}`, raw: data };
    }
    if (data?.error) {
      return { balance: null, error: String(data.error), raw: data };
    }
    
    const balance = parseFloat(data?.ref_bal);
    return {
      balance: Number.isFinite(balance) ? balance : null,
      error: null,
      raw: data,
    };
  } catch (e) {
    return { balance: null, error: e instanceof Error ? e.message : String(e), raw: null };
  }
}

async function fetchMeterInfo(token: string, username: string, userId: number, meterDisplayname: string): Promise<{ info: any; error: string | null }> {
  try {
    const resp = await fetch(METER_INFO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        svcClaimDto: {
          username,
          user_id: userId,
          svcName: "oresvc",
          endpoint: METER_INFO_ENDPOINT,
          scope: "self",
          target: "meter_p_info",
          operation: "read",
        },
        request: { meter_displayname: meterDisplayname },
      }),
    });

    const data = await resp.json() as any;
    
    if (!resp.ok) return { info: null, error: `HTTP ${resp.status}` };
    if (data?.error) return { info: null, error: String(data.error) };
    
    return { info: data?.meter_info ?? data, error: null };
  } catch (e) {
    return { info: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV Parsing
// ─────────────────────────────────────────────────────────────────────────────

function loadMeters(csvPath: string): MeterRecord[] {
  const content = readFileSync(csvPath, "utf-8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
  }) as MeterRecord[];
  
  return records.map(r => ({
    ...r,
    mms_online_timestamp: r.mms_online_timestamp === "null" || !r.mms_online_timestamp ? null : r.mms_online_timestamp,
  }));
}

function sampleMeters(meters: MeterRecord[], n: number): MeterRecord[] {
  if (n >= meters.length) return meters;
  
  const shuffled = [...meters].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  
  const csvPath = args.includes("--csv") ? args[args.indexOf("--csv") + 1] : "/tmp/meters_data/meters.csv";
  const sampleSize = args.includes("--sample") ? parseInt(args[args.indexOf("--sample") + 1], 10) : 50;
  const buildingFilter = args.includes("--building") ? args[args.indexOf("--building") + 1] : null;
  const testAll = args.includes("--all");
  const dryRun = args.includes("--dry-run");
  
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  NUS Aircon Checker - Meter API Test Suite");
  console.log("═══════════════════════════════════════════════════════════════════\n");
  
  // Load meters
  console.log(`Loading meters from: ${csvPath}`);
  let meters = loadMeters(csvPath);
  console.log(`Total meters loaded: ${meters.length}`);
  
  // Filter by building if specified
  if (buildingFilter) {
    meters = meters.filter(m => m.building.toLowerCase().includes(buildingFilter.toLowerCase()));
    console.log(`Filtered to building "${buildingFilter}": ${meters.length} meters`);
  }
  
  // Stats
  const onlineMeters = meters.filter(m => m.mms_online_timestamp !== null);
  const offlineMeters = meters.filter(m => m.mms_online_timestamp === null);
  const buildings = new Set(meters.map(m => m.building));
  
  console.log(`\n📊 Meter Statistics:`);
  console.log(`   Online:  ${onlineMeters.length}`);
  console.log(`   Offline: ${offlineMeters.length}`);
  console.log(`   Buildings: ${buildings.size}`);
  
  // Show building breakdown
  const byBuilding = new Map<string, { total: number; online: number }>();
  for (const m of meters) {
    const entry = byBuilding.get(m.building) || { total: 0, online: 0 };
    entry.total++;
    if (m.mms_online_timestamp) entry.online++;
    byBuilding.set(m.building, entry);
  }
  
  console.log(`\n📍 By Building:`);
  for (const [building, stats] of [...byBuilding.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10)) {
    console.log(`   ${building}: ${stats.total} (${stats.online} online)`);
  }
  if (byBuilding.size > 10) console.log(`   ... and ${byBuilding.size - 10} more buildings`);
  
  if (dryRun) {
    console.log("\n[dry-run] Skipping API tests.");
    return;
  }
  
  // Check credentials
  if (!TEST_USERNAME || !TEST_PASSWORD) {
    console.log("\n⚠️  No test credentials provided.");
    console.log("   Set TEST_USERNAME and TEST_PASSWORD env vars to run API tests.");
    console.log("   Example: TEST_USERNAME=10000019 TEST_PASSWORD=xxx npx ts-node scripts/test-meters.ts");
    return;
  }
  
  // Login
  console.log(`\n🔐 Logging in as ${TEST_USERNAME}...`);
  let auth: { token: string; userId: number; username: string };
  try {
    auth = await login(TEST_USERNAME, TEST_PASSWORD);
    console.log(`   ✓ Logged in (userId: ${auth.userId})`);
  } catch (e) {
    console.error(`   ✗ Login failed: ${e instanceof Error ? e.message : e}`);
    return;
  }
  
  // Select meters to test
  const toTest = testAll ? meters : sampleMeters(meters, sampleSize);
  console.log(`\n🧪 Testing ${toTest.length} meters...\n`);
  
  const results: TestResult[] = [];
  const delayMs = 200; // Rate limiting
  
  for (let i = 0; i < toTest.length; i++) {
    const meter = toTest[i];
    const progress = `[${i + 1}/${toTest.length}]`;
    
    process.stdout.write(`${progress} ${meter.meter_displayname} (${meter.building})... `);
    
    const [meterCredit, moneyBalance, meterInfo] = await Promise.all([
      fetchMeterCredit(auth.token, auth.username, auth.userId, meter.meter_displayname),
      fetchMoneyBalance(auth.token, auth.username, auth.userId, meter.meter_displayname),
      fetchMeterInfo(auth.token, auth.username, auth.userId, meter.meter_displayname),
    ]);
    
    const result: TestResult = {
      meter_displayname: meter.meter_displayname,
      building: meter.building,
      online: meter.mms_online_timestamp !== null,
      meterCreditBalance: meterCredit.balance,
      moneyBalance: moneyBalance.balance,
      meterCreditError: meterCredit.error,
      moneyError: moneyBalance.error,
      meterCreditRaw: meterCredit.raw,
      moneyRaw: moneyBalance.raw,
      meterInfo: meterInfo.info,
      meterInfoError: meterInfo.error,
    };
    
    results.push(result);
    
    // Status indicator
    const creditOk = meterCredit.balance !== null;
    const moneyOk = moneyBalance.balance !== null;
    const status = creditOk && moneyOk ? "✓" : creditOk || moneyOk ? "~" : "✗";
    const balStr = moneyOk ? `$${moneyBalance.balance!.toFixed(2)}` : creditOk ? `$${meterCredit.balance!.toFixed(2)}` : "N/A";
    
    console.log(`${status} ${balStr}`);
    
    // Rate limiting
    if (i < toTest.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Results Summary
  // ─────────────────────────────────────────────────────────────────────────────
  
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  Results Summary");
  console.log("═══════════════════════════════════════════════════════════════════\n");
  
  const withMeterCredit = results.filter(r => r.meterCreditBalance !== null);
  const withMoneyBalance = results.filter(r => r.moneyBalance !== null);
  const withBoth = results.filter(r => r.meterCreditBalance !== null && r.moneyBalance !== null);
  const withNeither = results.filter(r => r.meterCreditBalance === null && r.moneyBalance === null);
  const onlyMeterCredit = results.filter(r => r.meterCreditBalance !== null && r.moneyBalance === null);
  const onlyMoneyBalance = results.filter(r => r.meterCreditBalance === null && r.moneyBalance !== null);
  
  console.log(`📊 Balance Availability:`);
  console.log(`   Both endpoints work:     ${withBoth.length}/${results.length}`);
  console.log(`   Only meter_credit:       ${onlyMeterCredit.length}/${results.length}`);
  console.log(`   Only money_balance:      ${onlyMoneyBalance.length}/${results.length}`);
  console.log(`   Neither works:           ${withNeither.length}/${results.length}`);
  
  // Check for $0 balances
  const zeroMeterCredit = withMeterCredit.filter(r => r.meterCreditBalance === 0);
  const zeroMoneyBalance = withMoneyBalance.filter(r => r.moneyBalance === 0);
  
  console.log(`\n💰 Zero Balance Analysis:`);
  console.log(`   $0 meter_credit:  ${zeroMeterCredit.length}/${withMeterCredit.length}`);
  console.log(`   $0 money_balance: ${zeroMoneyBalance.length}/${withMoneyBalance.length}`);
  
  // Check discrepancies
  const discrepancies = withBoth.filter(r => {
    const diff = Math.abs((r.meterCreditBalance ?? 0) - (r.moneyBalance ?? 0));
    return diff > 0.01;
  });
  
  if (discrepancies.length > 0) {
    console.log(`\n⚠️  Balance Discrepancies (meter_credit ≠ money_balance):`);
    for (const d of discrepancies.slice(0, 10)) {
      console.log(`   ${d.meter_displayname}: credit=$${d.meterCreditBalance?.toFixed(2)} vs money=$${d.moneyBalance?.toFixed(2)}`);
    }
    if (discrepancies.length > 10) console.log(`   ... and ${discrepancies.length - 10} more`);
  }
  
  // Error analysis
  const meterCreditErrors = new Map<string, number>();
  const moneyErrors = new Map<string, number>();
  
  for (const r of results) {
    if (r.meterCreditError) {
      meterCreditErrors.set(r.meterCreditError, (meterCreditErrors.get(r.meterCreditError) ?? 0) + 1);
    }
    if (r.moneyError) {
      moneyErrors.set(r.moneyError, (moneyErrors.get(r.moneyError) ?? 0) + 1);
    }
  }
  
  if (meterCreditErrors.size > 0) {
    console.log(`\n❌ Meter Credit Errors:`);
    for (const [err, count] of meterCreditErrors) {
      console.log(`   "${err}": ${count}`);
    }
  }
  
  if (moneyErrors.size > 0) {
    console.log(`\n❌ Money Balance Errors:`);
    for (const [err, count] of moneyErrors) {
      console.log(`   "${err}": ${count}`);
    }
  }
  
  // Online vs offline analysis
  const onlineResults = results.filter(r => r.online);
  const offlineResults = results.filter(r => !r.online);
  
  const onlineWithBalance = onlineResults.filter(r => r.meterCreditBalance !== null || r.moneyBalance !== null);
  const offlineWithBalance = offlineResults.filter(r => r.meterCreditBalance !== null || r.moneyBalance !== null);
  
  console.log(`\n🔌 Online Status vs Balance:`);
  console.log(`   Online meters with balance:  ${onlineWithBalance.length}/${onlineResults.length}`);
  console.log(`   Offline meters with balance: ${offlineWithBalance.length}/${offlineResults.length}`);
  
  // Sample of failures for debugging
  if (withNeither.length > 0) {
    console.log(`\n🔍 Sample Failed Meters (for debugging):`);
    for (const r of withNeither.slice(0, 5)) {
      console.log(`\n   Meter: ${r.meter_displayname} (${r.building})`);
      console.log(`   Online: ${r.online}`);
      console.log(`   Meter Credit Error: ${r.meterCreditError}`);
      console.log(`   Money Balance Error: ${r.moneyError}`);
      if (r.meterCreditRaw) console.log(`   Meter Credit Raw: ${JSON.stringify(r.meterCreditRaw)}`);
      if (r.moneyRaw) console.log(`   Money Balance Raw: ${JSON.stringify(r.moneyRaw)}`);
    }
  }
  
  // Write detailed results to file
  const outputPath = "/tmp/meter-test-results.json";
  const fs = await import("node:fs");
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n📁 Detailed results saved to: ${outputPath}`);
  
  console.log("\n═══════════════════════════════════════════════════════════════════\n");
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});

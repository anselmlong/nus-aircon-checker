#!/usr/bin/env npx ts-node
/**
 * Test specific user accounts
 */

const EVS_LOGIN_URL = "https://evs2u.evs.com.sg/login";
const METER_CREDIT_ENDPOINT = "https://ore.evs.com.sg/evs1/get_credit_bal";
const MONEY_BALANCE_ENDPOINT = "https://ore.evs.com.sg/tcm/get_credit_balance";

interface TestAccount {
  username: string;
  password: string;
  note?: string;
}

const ACCOUNTS: TestAccount[] = [
  { username: "10013290", password: "RVE2213", note: "anselm" },
  { username: "10009002", password: "2216114N", note: "test user 1" },
  { username: "10010003", password: "250003E", note: "test user 2" },
  { username: "10010010", password: "???", note: "the $0 bug user - need password" },
];

async function login(username: string, password: string): Promise<{ token: string; userId: number; username: string } | null> {
  try {
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
    if (!resp.ok) {
      console.log(`   ✗ Login failed: ${data?.err || data?.error || resp.status}`);
      return null;
    }

    return {
      token: data.token,
      userId: data.userInfo?.id,
      username: data.userInfo?.username,
    };
  } catch (e) {
    console.log(`   ✗ Login error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function fetchBalance(endpoint: string, endpointName: string, token: string, username: string, userId: number, meterDisplayname: string): Promise<{ balance: number | null; raw: any }> {
  try {
    const resp = await fetch(endpoint, {
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
          endpoint,
          scope: "self",
          target: "meter_p_credit_balance",
          operation: "read",
        },
        request: { meter_displayname: meterDisplayname },
      }),
    });

    const data = await resp.json() as any;
    
    const balanceField = endpointName === "meter_credit" ? "credit_bal" : "ref_bal";
    const balance = parseFloat(data?.[balanceField]);
    
    return {
      balance: Number.isFinite(balance) ? balance : null,
      raw: data,
    };
  } catch (e) {
    return { balance: null, raw: { error: e instanceof Error ? e.message : String(e) } };
  }
}

async function testAccount(account: TestAccount) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`Testing: ${account.username} (${account.note || "no note"})`);
  console.log(`${"═".repeat(70)}`);
  
  if (account.password === "???") {
    console.log("   ⚠️  No password provided, skipping");
    return;
  }
  
  // Login
  console.log(`\n🔐 Logging in...`);
  const auth = await login(account.username, account.password);
  if (!auth) return;
  
  console.log(`   ✓ Logged in (userId: ${auth.userId}, returned username: ${auth.username})`);
  
  // Test with login username as meter_displayname
  console.log(`\n📊 Testing balance with meter_displayname = "${account.username}" (login username)`);
  
  const meterCredit1 = await fetchBalance(METER_CREDIT_ENDPOINT, "meter_credit", auth.token, auth.username, auth.userId, account.username);
  const moneyBalance1 = await fetchBalance(MONEY_BALANCE_ENDPOINT, "money_balance", auth.token, auth.username, auth.userId, account.username);
  
  console.log(`   meter_credit: ${meterCredit1.balance !== null ? `$${meterCredit1.balance.toFixed(2)}` : "N/A"}`);
  console.log(`   money_balance: ${moneyBalance1.balance !== null ? `$${moneyBalance1.balance.toFixed(2)}` : "N/A"}`);
  
  // If username differs from returned username, also test with returned username
  if (auth.username !== account.username) {
    console.log(`\n📊 Testing with meter_displayname = "${auth.username}" (returned username)`);
    
    const meterCredit2 = await fetchBalance(METER_CREDIT_ENDPOINT, "meter_credit", auth.token, auth.username, auth.userId, auth.username);
    const moneyBalance2 = await fetchBalance(MONEY_BALANCE_ENDPOINT, "money_balance", auth.token, auth.username, auth.userId, auth.username);
    
    console.log(`   meter_credit: ${meterCredit2.balance !== null ? `$${meterCredit2.balance.toFixed(2)}` : "N/A"}`);
    console.log(`   money_balance: ${moneyBalance2.balance !== null ? `$${moneyBalance2.balance.toFixed(2)}` : "N/A"}`);
  }
  
  // Show raw responses
  console.log(`\n🔍 Raw meter_credit response:`);
  console.log(JSON.stringify(meterCredit1.raw, null, 2));
  
  console.log(`\n🔍 Raw money_balance response:`);
  console.log(JSON.stringify(moneyBalance1.raw, null, 2));
}

async function main() {
  console.log("NUS Aircon Checker - Specific Account Tests");
  console.log("Testing each account to see what the API actually returns\n");
  
  for (const account of ACCOUNTS) {
    await testAccount(account);
  }
  
  console.log(`\n${"═".repeat(70)}`);
  console.log("Done");
  console.log(`${"═".repeat(70)}\n`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});

// Quick test for 10010010
(async () => {
  console.log("\n\n=== TESTING 10010010 ===\n");
  const auth = await login("10010010", "250010E");
  if (!auth) return;
  
  console.log(`Logged in: userId=${auth.userId}, username=${auth.username}`);
  
  const mc = await fetchBalance(METER_CREDIT_ENDPOINT, "meter_credit", auth.token, auth.username, auth.userId, "10010010");
  const mb = await fetchBalance(MONEY_BALANCE_ENDPOINT, "money_balance", auth.token, auth.username, auth.userId, "10010010");
  
  console.log("\nmeter_credit raw:", JSON.stringify(mc.raw, null, 2));
  console.log("\nmoney_balance raw:", JSON.stringify(mb.raw, null, 2));
  
  // Also try with different meter_displayname variations
  console.log("\n--- Trying meter_displayname = username from login response ---");
  const mc2 = await fetchBalance(METER_CREDIT_ENDPOINT, "meter_credit", auth.token, auth.username, auth.userId, auth.username);
  const mb2 = await fetchBalance(MONEY_BALANCE_ENDPOINT, "money_balance", auth.token, auth.username, auth.userId, auth.username);
  console.log("meter_credit:", mc2.balance, "raw:", JSON.stringify(mc2.raw));
  console.log("money_balance:", mb2.balance, "raw:", JSON.stringify(mb2.raw));
})();

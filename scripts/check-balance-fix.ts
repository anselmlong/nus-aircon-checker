#!/usr/bin/env npx ts-node
/**
 * Regression for the "empty balance" login bug — exercises the exact
 * username-only guest validation path the bot uses on `/login <user>`:
 *
 *   evs.login(username, "", validateGuest=true)
 *
 *  - 10013842  (bug account): meter_credit -> {"info":"empty balance"},
 *              money -> ~$20. login() must RESOLVE (no "empty balance" throw)
 *              and report a balance via getBalances.
 *  - 100013842 (invalid):     login() must THROW so /login shows a clear error.
 *  - 10013290  (known-good):  login() must RESOLVE.
 */
import { EvsClient } from "../dist/evsClient.js";

async function main() {
  const evs = new EvsClient();

  const cases = [
    { username: "10013842", expect: "resolves", why: "empty-balance account" },
    { username: "100013842", expect: "throws", why: "invalid username" },
    { username: "10013290", expect: "resolves", why: "known-good (anselm)" },
  ];

  let failed = 0;
  for (const c of cases) {
    let outcome: string;
    try {
      await evs.login(c.username, "", true); // validate via balance probe
      const b: any = await evs.getBalances(c.username);
      outcome = `OK  meter=${b.meterCredit?.meterCreditBalance} money=${b.money?.moneyBalance}`;
    } catch (e) {
      outcome = `THREW: ${(e as Error).message}`;
    }

    const pass = c.expect === "throws"
      ? outcome.startsWith("THREW")
      : outcome.startsWith("OK") && !/meter=null money=null/.test(outcome);

    if (!pass) failed++;
    console.log(`${pass ? "PASS" : "FAIL"} ${c.username.padEnd(9)} (${c.why})  ->  ${outcome}`);
  }

  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
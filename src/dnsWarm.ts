import * as dns from "node:dns";

// EVS domains the bot communicates with
const EVS_DOMAINS = [
  "evs2u.evs.com.sg",
  "ore.evs.com.sg",
  "nus-utown.evs.com.sg",
];

// Pre-resolve domains at startup to warm the OS DNS cache
export async function warmDnsCache(): Promise<void> {
  const results = await Promise.allSettled(
    EVS_DOMAINS.map(async (domain) => {
      const start = Date.now();
      const addrs = await dns.promises.resolve4(domain);
      const ms = Date.now() - start;
      console.log(`[dns] warmed ${domain} → ${addrs.join(", ")} (${ms}ms)`);
    }),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`[dns] warm failed: ${r.reason}`);
    }
  }
  console.log(`[dns] cache warmed for ${EVS_DOMAINS.length} domains`);
}
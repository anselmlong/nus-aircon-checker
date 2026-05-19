import * as dns from "node:dns";

type CacheEntry = {
  address: string;
  family: number;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 300_000; // 5 minutes
let hits = 0;
let misses = 0;

export function cachedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void,
): void {
  const key = hostname.toLowerCase();
  const cached = cache.get(key);

  if (cached && Date.now() < cached.expiresAt) {
    hits++;
    callback(null, cached.address, cached.family);
    return;
  }

  misses++;
  dns.lookup(hostname, { ...options, all: false }, (err, address, family) => {
    if (!err && typeof address === "string") {
      cache.set(key, { address, family, expiresAt: Date.now() + DEFAULT_TTL_MS });
    }
    callback(err, address, family);
  });
}

export function getStats(): string {
  const lines: string[] = [`DNS cache: ${hits} hits, ${misses} misses, ${cache.size} entries`];
  cache.forEach((e, host) => {
    const ttl = Math.round((e.expiresAt - Date.now()) / 1000);
    lines.push(`  ${host} → ${e.address} (${ttl}s)`);
  });
  return lines.join("\n");
}
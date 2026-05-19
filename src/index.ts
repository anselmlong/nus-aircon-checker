import "dotenv/config";
import { Agent, setGlobalDispatcher } from "undici";
import { warmDnsCache } from "./dnsWarm.js";
import { startBot } from "./bot.js";

// Connection pooling + keepalive — reuse TCP/TLS connections across requests
// Saves ~280ms of TCP+TLS handshake on repeat calls within 60s
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000,
    connections: 50,
    pipelining: 10,
  }),
);

// Pre-resolve EVS domains at startup to warm OS-level DNS cache
warmDnsCache().catch(() => {});

startBot();
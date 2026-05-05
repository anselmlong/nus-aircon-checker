export type HostelType = "cp2" | "cp2nus";

const WEBPOS_BASE = "https://nus-utown.evs.com.sg";
const WEBPOS_HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Upgrade-Insecure-Requests": "1",
};

function classifyResponse(html: string): "valid" | "invalid" | "unknown" {
  const body = String(html || "");
  const isValid =
    body.includes("<title>EVS POS Package Selection Page</title>") ||
    body.includes('action="/EVSWebPOS/selectOfferServlet"') ||
    body.includes("Please confirm you are purchasing for the above premise");
  const isInvalid =
    body.includes("<title>EVS POS Main Page</title>") ||
    body.includes("Meter not found.") ||
    body.includes('action="/EVSWebPOS/loginServlet"');
  if (isValid) return "valid";
  if (isInvalid) return "invalid";
  return "unknown";
}

// "valid"   → meter found on cp2 WebPOS (PGPR/PGP/RC/NUSC) → cp2
// "invalid" → meter NOT on cp2 WebPOS → assume cp2nus (UTown/RVRC)
// "unknown" → unclassifiable → default to cp2nus, log warning
export async function detectHostelType(meterId: string): Promise<HostelType> {
  const body = new URLSearchParams({ txtMtrId: meterId.trim() }).toString();
  try {
    const resp = await fetch(`${WEBPOS_BASE}/EVSWebPOS/loginServlet`, {
      method: "POST",
      headers: {
        ...WEBPOS_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: WEBPOS_BASE,
        Referer: `${WEBPOS_BASE}/EVSWebPOS/`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return "cp2nus";
    const html = await resp.text();
    const result = classifyResponse(html);
    if (result === "unknown") {
      console.warn(`[hostelDetect] unclassifiable response for meter ${meterId}, defaulting to cp2nus`);
    }
    return result === "valid" ? "cp2" : "cp2nus";
  } catch {
    return "cp2nus";
  }
}

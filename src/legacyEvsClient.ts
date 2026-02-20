/**
 * Legacy EVS client for nus-utown.evs.com.sg
 * Fallback when the main API (evs2u.evs.com.sg) doesn't work
 */

const LEGACY_BASE = "https://nus-utown.evs.com.sg";
const LOGIN_URL = `${LEGACY_BASE}/EVSEntApp-war/loginServlet`;
const METER_CREDIT_URL = `${LEGACY_BASE}/EVSEntApp-war/viewMeterCreditServlet`;
const LOGOUT_URL = `${LEGACY_BASE}/EVSEntApp-war/logoutServlet`;

export type LegacyBalanceResult = {
  meterId: string;
  balance: number;
  lastUpdated: string | undefined;
  packageId: string | undefined;
};

function extractValue(html: string, label: string): string | undefined {
  // Look for patterns like: <td>Meter ID:</td>\n<td><font...>VALUE</font></td>
  const labelPattern = new RegExp(
    `${label}[:\\s]*</td>\\s*<td[^>]*>(?:<font[^>]*>)?([^<]+)`,
    "i"
  );
  const match = html.match(labelPattern);
  if (match?.[1]) return match[1].trim();

  // Alternative: look for "label: VALUE" in same td
  const altPattern = new RegExp(`${label}[:\\s]+([^<\\n]+)`, "i");
  const altMatch = html.match(altPattern);
  return altMatch?.[1]?.trim();
}

function extractBalance(html: string): number | undefined {
  // Look for "Total Balance: S$ XX.XX" or "Last Recorded Credit: S$ XX.XX"
  const patterns = [
    /Total Balance:\s*S?\$?\s*([\d.]+)/i,
    /Last Recorded Credit:\s*S?\$?\s*([\d.]+)/i,
    /credit_bal["\s:]+(\d+\.?\d*)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const val = parseFloat(match[1]);
      if (Number.isFinite(val)) return val;
    }
  }
  return undefined;
}

export class LegacyEvsClient {
  private cookies: string[] = [];

  async login(username: string, password: string): Promise<boolean> {
    // Clear old cookies
    this.cookies = [];

    const formData = new URLSearchParams({
      txtLoginId: username,
      txtPassword: password,
    });

    const resp = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: LEGACY_BASE,
      },
      body: formData.toString(),
      redirect: "manual",
    });

    // Collect cookies from response
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const parts = c.split(";")[0];
      if (parts) this.cookies.push(parts);
    }

    // Check if login succeeded by looking at response
    const html = await resp.text();

    // Login fails if we see the login form again or error message
    if (html.includes("txtLoginId") && html.includes("txtPassword")) {
      // Still on login page - check if there's error text
      if (html.includes("Invalid") || html.includes("incorrect")) {
        throw new Error("Invalid credentials");
      }
      // No error but still on login page - might be disabled or other issue
      throw new Error("Login failed - account may be disabled");
    }

    // Success if we get redirected to authenticated pages
    return html.includes("/EVSEntApp-war/") || html.includes("logoutServlet");
  }

  async getBalance(username: string, password: string): Promise<LegacyBalanceResult> {
    // Ensure logged in
    await this.login(username, password);

    const resp = await fetch(METER_CREDIT_URL, {
      headers: {
        Cookie: this.cookies.join("; "),
        Referer: LEGACY_BASE,
      },
    });

    if (!resp.ok) {
      throw new Error(`Failed to fetch balance: HTTP ${resp.status}`);
    }

    const html = await resp.text();

    // Check if session expired
    if (html.includes("txtLoginId") && html.includes("txtPassword")) {
      throw new Error("Session expired");
    }

    const balance = extractBalance(html);
    if (balance === undefined) {
      throw new Error("Could not parse balance from response");
    }

    // Extract other info
    const meterId = extractValue(html, "Meter ID") ?? username;
    const packageId = extractValue(html, "Package ID");
    const lastUpdated = extractValue(html, "Last Recorded Timestamp");

    return {
      meterId,
      balance,
      lastUpdated,
      packageId,
    };
  }

  async logout(): Promise<void> {
    if (this.cookies.length === 0) return;

    try {
      await fetch(LOGOUT_URL, {
        headers: {
          Cookie: this.cookies.join("; "),
        },
      });
    } catch {
      // Ignore logout errors
    }

    this.cookies = [];
  }
}

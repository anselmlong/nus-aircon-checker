import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyInitData(initData: string, botToken: string): boolean {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

export function extractInitDataUserId(initData: string): number | null {
  try {
    const params = new URLSearchParams(initData);
    const userStr = params.get("user");
    if (!userStr) return null;
    const user = JSON.parse(userStr) as { id?: unknown };
    return typeof user.id === "number" ? user.id : null;
  } catch {
    return null;
  }
}

export function isValidMeterId(meterId: unknown): boolean {
  return /^\d{8}$/.test(String(meterId || "").trim());
}

export function isValidAmount(amount: unknown): boolean {
  const n = Number(String(amount || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 6 && n <= 50;
}

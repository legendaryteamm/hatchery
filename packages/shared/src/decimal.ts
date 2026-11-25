/**
 * Exact decimal arithmetic for money (no floating point). Amounts are strings like "12.5" or
 * "0.000000000000000001"; USD is kept in integer micro-dollars (6 decimals), as in the database.
 */

const DECIMAL = /^(\d{1,30})(?:\.(\d{1,18}))?$/;

/** "12.34" -> 1234n * 10^(scale-2). Throws on anything that is not a plain non-negative decimal. */
export function parseDecimal(s: string, scale: number): bigint {
  const m = DECIMAL.exec(s.trim());
  if (!m) throw new Error(`not a non-negative decimal: ${JSON.stringify(s)}`);
  const frac = m[2] ?? "";
  if (frac.length > scale) {
    // Only exact values are accepted at this scale (no silent rounding of money).
    if (/[^0]/.test(frac.slice(scale))) throw new Error(`${s} has more than ${scale} decimals`);
  }
  return BigInt(m[1]!) * 10n ** BigInt(scale) + BigInt((frac.slice(0, scale) || "0").padEnd(scale, "0"));
}

/** Micro-dollars -> "12.345678" (always 6 decimals). */
export function formatMicros(micros: bigint): string {
  const neg = micros < 0n;
  const s = (neg ? -micros : micros).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** USD string (up to 6 decimals, may be negative) -> micro-dollars. */
export function usdToMicros(usd: string): bigint {
  const t = usd.trim();
  const neg = t.startsWith("-");
  const v = parseDecimal(neg ? t.slice(1) : t, 6);
  return neg ? -v : v;
}

/**
 * amountNative x usdPerNative, rounded half-up to the micro-dollar. Both inputs are decimal
 * strings with up to 18 decimals.
 */
export function nativeToUsdMicros(amountNative: string, usdPerNative: string): bigint {
  const a = parseDecimal(amountNative, 18);
  const r = parseDecimal(usdPerNative, 18);
  const product = a * r; // scale 36
  const unit = 10n ** 30n; // 36 - 6
  return (product + unit / 2n) / unit;
}

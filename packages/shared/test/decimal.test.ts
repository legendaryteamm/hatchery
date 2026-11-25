import { describe, expect, it } from "vitest";
import { formatMicros, nativeToUsdMicros, parseDecimal, usdToMicros } from "../src/decimal.ts";

describe("exact money arithmetic", () => {
  it("parses and formats without floating point", () => {
    expect(parseDecimal("12.34", 6)).toBe(12_340_000n);
    expect(parseDecimal("0.000001", 6)).toBe(1n);
    expect(parseDecimal("5", 6)).toBe(5_000_000n);
    expect(parseDecimal("1.50000000", 6)).toBe(1_500_000n); // trailing zeros beyond the scale are fine
    expect(() => parseDecimal("1.0000001", 6)).toThrow(/more than 6 decimals/);
    for (const bad of ["-1", "1e5", "", "1.", ".5", "0x10", "1,5"]) expect(() => parseDecimal(bad, 6), bad).toThrow();
    expect(formatMicros(12_340_000n)).toBe("12.340000");
    expect(formatMicros(-5n)).toBe("-0.000005");
    expect(formatMicros(0n)).toBe("0.000000");
    expect(usdToMicros("-3.25")).toBe(-3_250_000n);
  });

  it("converts native amounts to USD, rounding half-up to the micro-dollar", () => {
    expect(nativeToUsdMicros("2", "1")).toBe(2_000_000n);
    expect(nativeToUsdMicros("0.1", "0.2")).toBe(20_000n); // 0.02 exactly (floating point gives 0.020000000000000004)
    expect(nativeToUsdMicros("1.234567891", "1")).toBe(1_234_568n); // ...891 rounds up
    expect(nativeToUsdMicros("0.0000004", "1")).toBe(0n);
    expect(nativeToUsdMicros("0.0000005", "1")).toBe(1n);
    expect(nativeToUsdMicros("123456789.123456789123456789", "2500.5")).toBe(308_703_701_203_203_701n); // 308703701203.2037012... (checked with Python decimal)
  });
});

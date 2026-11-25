import { describe, expect, it } from "vitest";
import { costMicroUsd, microsToUsd, petIdentity, priceTable } from "../src/index.ts";

describe("prices", () => {
  it("computes cost from real token counts in micro-dollars", () => {
    // 1000 in * $4 + 500 out * $20 + 2000 cache-read * $0.2 + 100 cache-write * $5 (per MTok)
    expect(costMicroUsd("claude-opus-5-5", { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 })).toBe(4000 + 10000 + 400 + 500);
  });
  it("refuses unpriced models", () => {
    expect(() => costMicroUsd("mystery", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toThrow(/no price/);
  });
  it("formats micro-dollars exactly", () => {
    expect(microsToUsd(1234)).toBe("0.001234");
    expect(microsToUsd(12_345_678)).toBe("12.345678");
    expect(microsToUsd(0)).toBe("0.000000");
  });
  it("accepts overrides", () => {
    const t = priceTable({ PRICE_TABLE_JSON: JSON.stringify({ m: { inputPerMTok: 1, outputPerMTok: 1, cacheWritePerMTok: 1, cacheReadPerMTok: 1 } }) });
    expect(t.m?.inputPerMTok).toBe(1);
    expect(t["claude-opus-5-5"]).toBeDefined();
  });
});

describe("pet identity", () => {
  it("is deterministic and well-formed", () => {
    expect(petIdentity("agent-1")).toEqual(petIdentity("agent-1"));
    expect(petIdentity("agent-1")).not.toEqual(petIdentity("agent-2"));
    expect(petIdentity("x").shellColor).toMatch(/^#[0-9a-f]{6}$/);
  });
});

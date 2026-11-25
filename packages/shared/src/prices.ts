/**
 * Model price table used to turn REAL token counts into USD (BUILD_PROMPT.md section 6).
 *
 * Source: Anthropic first-party API list prices as of PRICES_AS_OF (USD per million tokens).
 * Cache writes use the 5-minute TTL rate (1.25x input). Override or extend at runtime with the
 * PRICE_TABLE_JSON env var (same shape as PRICES) - e.g. when prices change or for a new model.
 * A model missing from the table cannot be used: the desk refuses to record unpriced spend.
 */
export const PRICES_AS_OF = "2026-11-03";

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-2": { inputPerMTok: 8, outputPerMTok: 40, cacheWritePerMTok: 10, cacheReadPerMTok: 0.2 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.1 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheWritePerMTok: 0.125, cacheReadPerMTok: 0.01 },
  // Test-only model used by the scripted fake provider; priced so tests exercise real arithmetic.
  "fake-model": { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export function priceTable(env: Record<string, string | undefined> = process.env): Record<string, ModelPrice> {
  if (!env.PRICE_TABLE_JSON) return PRICES;
  return { ...PRICES, ...(JSON.parse(env.PRICE_TABLE_JSON) as Record<string, ModelPrice>) };
}

/** Cost in integer micro-dollars (1e-6 USD), rounded half up. */
export function costMicroUsd(model: string, u: TokenUsage, table: Record<string, ModelPrice> = PRICES): number {
  const p = table[model];
  if (!p) throw new Error(`no price for model ${model}; add it to PRICE_TABLE_JSON`);
  // tokens * ($ per 1e6 tokens) = micro-dollars
  const micros =
    u.inputTokens * p.inputPerMTok +
    u.outputTokens * p.outputPerMTok +
    u.cacheWriteTokens * p.cacheWritePerMTok +
    u.cacheReadTokens * p.cacheReadPerMTok;
  return Math.round(micros);
}

/** Format micro-dollars as a decimal string with 6 places, e.g. 1234 -> "0.001234". */
export function microsToUsd(micros: number): string {
  const neg = micros < 0;
  const s = Math.abs(Math.trunc(micros)).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
}

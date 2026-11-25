import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { usageParts } from "../src/anthropic-provider.ts";

const base = { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, fallback_credit: null, inference_geo: null,
  output_tokens_details: null, server_tool_use: null, service_tier: null, speed: null };
const response = (usage: Partial<Anthropic.Beta.BetaUsage>, model = "claude-opus-5-5") =>
  ({ model, usage: { ...base, input_tokens: 0, output_tokens: 0, iterations: null, ...usage } }) as Pick<Anthropic.Beta.BetaMessage, "usage" | "model">;

describe("usageParts (pricing by the model that served each part)", () => {
  it("no iterations: one part on the response model", () => {
    expect(usageParts(response({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }), "claude-opus-5-5")).toEqual([
      { model: "claude-opus-5-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, servedByFallback: false },
    ]);
  });

  it("refusal fallback: the declined part on the requested model, the rescue on the fallback model", () => {
    const r = response(
      {
        input_tokens: 1100,
        output_tokens: 510,
        iterations: [
          { type: "message", model: null, input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, cache_creation: null },
        ],
      },
      "claude-opus-4-8",
    );
    expect(usageParts(r, "claude-fable-5-2")).toEqual([
      { model: "claude-fable-5-2", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, servedByFallback: false },
      { model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 40, cacheWriteTokens: 0, servedByFallback: true },
    ]);
  });
});

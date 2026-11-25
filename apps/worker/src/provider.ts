/**
 * Model provider interface (BUILD_PROMPT.md section 3): the agent loop only sees these neutral
 * types, so other providers can be added later. Provider-specific blocks (e.g. thinking blocks)
 * are carried in `raw` and sent back unchanged.
 */
import type { TokenUsage } from "@hatchery/shared";

export type Block =
  | { type: "text"; text: string; raw?: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown; raw?: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "raw"; value: unknown };

export interface ChatMessage {
  role: "user" | "assistant";
  content: Block[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema with `additionalProperties: false` and `required` (strict tool use). */
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

/** Token usage of one model that served (part of) a call. A refusal fallback adds a part. */
export interface UsagePart extends TokenUsage {
  model: string;
  servedByFallback: boolean;
}

export interface ModelTurn {
  content: Block[];
  stopReason: StopReason;
  /** One entry per model that served this call, priced separately by the desk. */
  parts: UsagePart[];
  requestId?: string;
}

export interface CallOptions {
  /** Override max output tokens (e.g. short teammate replies). */
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ModelProvider {
  readonly model: string;
  call(req: { system: string; messages: ChatMessage[]; tools: ToolDef[] }, opts?: CallOptions): Promise<ModelTurn>;
}

import Anthropic from "@anthropic-ai/sdk";
import type { Block, CallOptions, ChatMessage, ModelProvider, ModelTurn, StopReason, ToolDef, UsagePart } from "./provider.ts";

export interface AnthropicOptions {
  model: string;
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallback (on by default; set AGENT_REFUSAL_FALLBACK=0 to turn off). */
  refusalFallback: boolean;
}

/**
 * Split a response's usage into one part per model that served it. With a refusal fallback,
 * `usage.iterations` lists each part with its own model and tokens (a `message` entry with a null
 * model ran on the requested model). Without iterations, the whole call is one part.
 */
export function usageParts(response: Pick<Anthropic.Beta.BetaMessage, "usage" | "model">, requestedModel: string): UsagePart[] {
  const it = response.usage.iterations ?? [];
  const parts: UsagePart[] = [];
  for (const i of it) {
    if (i.type !== "message" && i.type !== "fallback_message") continue; // compaction/advisor: not used by this harness
    parts.push({
      model: i.model ?? requestedModel,
      inputTokens: i.input_tokens,
      outputTokens: i.output_tokens,
      cacheReadTokens: i.cache_read_input_tokens ?? 0,
      cacheWriteTokens: i.cache_creation_input_tokens ?? 0,
      servedByFallback: i.type === "fallback_message",
    });
  }
  if (parts.length) return parts;
  const u = response.usage;
  return [{
    model: response.model,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    servedByFallback: false,
  }];
}

export class AnthropicProvider implements ModelProvider {
  private client = new Anthropic(); // credentials from ANTHROPIC_API_KEY / `ant auth login`
  constructor(private opts: AnthropicOptions) {}

  get model() {
    return this.opts.model;
  }

  async call(req: { system: string; messages: ChatMessage[]; tools: ToolDef[] }, callOpts: CallOptions = {}): Promise<ModelTurn> {
    const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    }));
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.opts.model,
      max_tokens: callOpts.maxTokens ?? this.opts.maxTokens,
      // Stable prefix (tools + system) is cached; thinking is adaptive by default on current models.
      cache_control: { type: "ephemeral" },
      system: req.system,
      output_config: { effort: callOpts.effort ?? this.opts.effort },
      messages: req.messages.map(toParam),
    };
    if (tools.length) params.tools = tools;
    if (this.opts.refusalFallback) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const response = await this.client.beta.messages.create(params);

    const content: Block[] = response.content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text, raw: b };
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input, raw: b };
      return { type: "raw", value: b };
    });
    return {
      content,
      stopReason: (["end_turn", "tool_use", "max_tokens", "refusal"].includes(response.stop_reason ?? "") ? response.stop_reason : "other") as StopReason,
      parts: usageParts(response, this.opts.model),
      requestId: (response as { _request_id?: string | null })._request_id ?? undefined,
    };
  }
}

function toParam(m: ChatMessage): Anthropic.Beta.BetaMessageParam {
  return {
    role: m.role,
    content: m.content.map((b): Anthropic.Beta.BetaContentBlockParam => {
      if (b.type === "raw") return b.value as Anthropic.Beta.BetaContentBlockParam;
      if ((b.type === "text" || b.type === "tool_use") && b.raw) return b.raw as Anthropic.Beta.BetaContentBlockParam;
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
    }),
  };
}

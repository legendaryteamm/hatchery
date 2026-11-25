import type { Block, CallOptions, ChatMessage, ModelProvider, ModelTurn, ToolDef } from "../src/provider.ts";

export interface ScriptInput {
  purpose: "prove" | "reply";
  leanName: string;
  /** Assistant turns so far in this conversation. */
  turn: number;
  /** Content of the last tool_result in the latest user message. */
  lastResult: string;
  /** All text of the conversation (user + tool results), for "did I get a hint?" checks. */
  transcript: string;
  /** Names of the tools offered in this call (e.g. submit_review, lean_check). */
  tools: string[];
  /** The system prompt. */
  system: string;
}

/**
 * Scripted stand-in for the model: no network, no cost. Every call reports the same token
 * counts on "fake-model" ($1 / $5 / $0.1 per MTok): 1200 in, 300 out, 800 cache-read
 * = 1200 + 1500 + 80 = 2780 micro-dollars per call.
 */
export const CALL_MICROS = 2780;

export class FakeProvider implements ModelProvider {
  readonly model = "fake-model";
  calls = 0;
  constructor(private script: (i: ScriptInput) => Block[], private delayMs = 0) {}

  async call(req: { system: string; messages: ChatMessage[]; tools: ToolDef[] }, _opts?: CallOptions): Promise<ModelTurn> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const texts = req.messages.flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")));
    const leanName = /(?:Lean name:? |working on L-[a-z0-9-]+ \(Lean name )(L_[a-z0-9_]+)/.exec(texts.join("\n"))?.[1] ?? "?";
    const last = req.messages.at(-1)!.content.filter((b) => b.type === "tool_result").at(-1);
    const content = this.script({
      purpose: req.tools.length ? "prove" : "reply",
      leanName,
      turn: req.messages.filter((m) => m.role === "assistant").length,
      lastResult: last?.type === "tool_result" ? last.content : "",
      transcript: texts.join("\n"),
      tools: req.tools.map((t) => t.name),
      system: req.system,
    });
    return {
      content,
      stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      parts: [{ model: this.model, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0, servedByFallback: false }],
    };
  }
}

let n = 0;
export const call = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `toolu_${++n}`, name, input });
export const text = (t: string): Block => ({ type: "text", text: t });

import type { Block, ChatMessage, ModelProvider, ModelTurn, ToolDef } from "../src/provider.ts";

/**
 * Scripted stand-in for the model. `script(leanName, turnInAttempt, lastToolResult)` decides the
 * next tool calls. Usage numbers are fixed so costs are exactly predictable.
 */
export class FakeProvider implements ModelProvider {
  readonly model = "fake-model";
  calls = 0;
  constructor(private script: (leanName: string, turn: number, lastResult: string) => Block[]) {}

  async call(req: { system: string; messages: ChatMessage[]; tools: ToolDef[] }): Promise<ModelTurn> {
    this.calls++;
    const first = req.messages[0]!.content[0];
    const leanName = /Lean name: (L_[a-z0-9_]+)/.exec(first?.type === "text" ? first.text : "")?.[1] ?? "?";
    const turn = req.messages.filter((m) => m.role === "assistant").length;
    const last = req.messages.at(-1)!.content.filter((b) => b.type === "tool_result").at(-1);
    const content = this.script(leanName, turn, last?.type === "tool_result" ? last.content : "");
    return {
      content,
      stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0 },
      model: this.model,
      fallbackUsed: false,
    };
  }
}

let n = 0;
export const call = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `toolu_${++n}`, name, input });

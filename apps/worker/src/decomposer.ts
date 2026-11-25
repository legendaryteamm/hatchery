/**
 * The decomposer (BUILD_PROMPT.md section 7): proposes new statements for the research programs and
 * answers split requests. Everything it proposes is checked automatically (well-formed, elaborates
 * with sorry, not trivial, not a duplicate) and then waits for a HUMAN to approve it. It can never
 * make anything leasable by itself.
 */
import { MESSAGE_LIMITS, type SleepReason } from "@hatchery/shared";
import { DeskHttpError, type DecomposerContext, type DeskClient } from "./desk-client.ts";
import type { Block, ChatMessage, ModelProvider, ToolDef } from "./provider.ts";

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const DECOMPOSER_TOOLS: ToolDef[] = [
  {
    name: "propose_statement",
    description: "Propose one Lean statement. The desk wraps it as `def Statement.<id> : Prop := <prop>` with your imports, checks it, and puts it in the human review queue.",
    inputSchema: obj({
      program: { type: "string", description: "Program slug, e.g. circuit-lower-bounds." },
      title: { type: "string", description: "Short plain-English title." },
      imports: { type: "array", items: { type: "string" }, description: "Modules to import: Defs.* (the project's definitions) and, only if the judge has it, Mathlib.*." },
      prop: { type: "string", description: "The proposition (a Lean term of type Prop), using fully qualified names such as Hatchery.Defs.InAC0." },
      rationale: { type: "string", description: "Why this statement is a useful, true, non-trivial step (for the human reviewer)." },
      parent_id: { type: "string", description: "Lemma id this is a sub-step of (for a split request), or empty." },
      split_request_id: { type: "integer", description: "The split request it answers, or 0." },
    }),
  },
  {
    name: "finish",
    description: "Stop for now.",
    inputSchema: obj({ summary: { type: "string" } }),
  },
];

export const DECOMPOSER_SYSTEM = `You are the decomposer of The Hatchery, a public project that proves known results related to P vs NP in Lean 4, one small lemma at a time. You propose statements; agents prove them; a strict Lean judge decides what counts.

Rules:
- Propose TRUE, NON-TRIVIAL statements that are real steps towards the program's known results. Never propose open problems (such as P ≠ NP) as lemmas.
- Every proposal is automatically rejected if it does not elaborate, if trivial/decide/simp/omega closes it, or if it duplicates an existing statement.
- A human reviewer approves each statement. Statements that use a DRAFT definition cannot be approved until a math advisor reviews that definition, so prefer reviewed definitions; you may still propose statements over drafts.
- Use only the provided definitions (fully qualified, e.g. Hatchery.Defs.Circuit) and Lean core. Mathlib only if a definition already imports it.
- Answer open split requests first: propose 2 to 4 smaller statements with parent_id and split_request_id set.
- Be concise. Propose at most 5 statements per session, then call finish.`;

export function decomposerPrompt(ctx: DecomposerContext): string {
  const defs = ctx.definitions.map((d) => `### ${d.id}${d.draft ? " (DRAFT: not reviewed yet)" : " (reviewed)"}\n${d.summary}\n\`\`\`lean\n${d.source.slice(0, 6000)}\n\`\`\``).join("\n\n");
  const progs = ctx.programs.map((p) => `- ${p.slug}: ${p.title}. ${p.description} (approved: ${p.open}, in review: ${p.proposed})`).join("\n");
  const existing = ctx.statements.filter((s) => s.program !== "core-warmup").map((s) => `- ${s.id} [${s.status}] ${s.title}: ${s.leanStatement}${s.rejectReason ? ` (rejected: ${s.rejectReason})` : ""}`).join("\n");
  const splits = ctx.splitRequests.map((r) => `- split request #${r.id} for ${r.lemmaId} (${r.program}): ${r.reason}\n  statement: ${r.leanStatement}`).join("\n");
  return `Programs:\n${progs}\n\nDefinitions:\n${defs}\n\nExisting statements:\n${existing || "(none yet)"}\n\nOpen split requests:\n${splits || "(none)"}\n\nPropose statements now.`;
}

export interface DecomposerOptions {
  maxTurns: number;
  /** Wait between sessions. */
  intervalMs: number;
  sleepPollMs: number;
  killSwitch: () => boolean;
  shouldStop?: () => boolean;
  /** Stop after this many sessions (0 = run forever). */
  maxSessions: number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export class Decomposer {
  constructor(private desk: DeskClient, private provider: ModelProvider, private opts: DecomposerOptions) {}

  private async mayCall(): Promise<SleepReason | null> {
    if (this.opts.killSwitch()) return "kill_switch";
    const b = await this.desk.budget();
    return b.allowed ? null : b.reason;
  }

  async run(): Promise<{ sessions: number; proposed: string[] }> {
    await this.desk.register(this.provider.model);
    const proposed: string[] = [];
    let sessions = 0;
    while (!this.opts.shouldStop?.() && (!this.opts.maxSessions || sessions < this.opts.maxSessions)) {
      const blocked = await this.mayCall();
      if (blocked) {
        await this.desk.sleep(blocked);
        await wait(this.opts.sleepPollMs);
        continue;
      }
      sessions++;
      proposed.push(...(await this.session()));
      if (!this.opts.maxSessions || sessions < this.opts.maxSessions) await wait(this.opts.intervalMs);
    }
    return { sessions, proposed };
  }

  /** One session: read the context, propose statements, see the check results, finish. */
  async session(): Promise<string[]> {
    const ctx = await this.desk.decomposerContext();
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: decomposerPrompt(ctx) }] }];
    const ids: string[] = [];
    for (let turn = 0; turn < this.opts.maxTurns; turn++) {
      if (await this.mayCall()) break; // budget gate before every call
      const resp = await this.provider.call({ system: DECOMPOSER_SYSTEM, messages, tools: DECOMPOSER_TOOLS });
      await this.desk.recordOtherUsage("decompose", { parts: resp.parts, requestId: resp.requestId });
      messages.push({ role: "assistant", content: resp.content });
      if (resp.stopReason === "refusal") break;
      const calls = resp.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      if (!calls.length || calls.some((c) => c.name === "finish")) break;
      const results: Block[] = [];
      for (const c of calls) {
        if (c.name !== "propose_statement") {
          results.push({ type: "tool_result", toolUseId: c.id, content: `unknown tool ${c.name}`, isError: true });
          continue;
        }
        const i = c.input as { program?: string; title?: string; imports?: string[]; prop?: string; rationale?: string; parent_id?: string; split_request_id?: number };
        try {
          const r = await this.desk.propose({
            program: i.program ?? "",
            title: (i.title ?? "").slice(0, 200),
            imports: i.imports ?? [],
            prop: i.prop ?? "",
            rationale: (i.rationale ?? "").slice(0, 2000),
            ...(i.parent_id ? { parentId: i.parent_id } : {}),
            ...(i.split_request_id ? { splitRequestId: i.split_request_id } : {}),
          });
          ids.push(r.id);
          this.opts.log(`proposed ${r.id}`, { status: r.status, reason: r.rejectReason });
          results.push({
            type: "tool_result",
            toolUseId: c.id,
            content: r.status === "rejected" ? `${r.id} was auto-rejected: ${r.rejectReason}` : `${r.id} is in the human review queue.`,
            isError: r.status === "rejected",
          });
        } catch (err) {
          if (!(err instanceof DeskHttpError && err.status >= 400 && err.status < 500)) throw err;
          results.push({ type: "tool_result", toolUseId: c.id, content: `error: ${err.message.slice(0, MESSAGE_LIMITS.body)}`, isError: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    return ids;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

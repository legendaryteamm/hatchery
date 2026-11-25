/**
 * The agent loop (BUILD_PROMPT.md section 6), Phase 1: one agent, no daily caps yet (Phase 2),
 * but a hard per-run spend cap so a local run can never run away.
 */
import { petIdentity } from "@hatchery/shared";
import { DeskHttpError, type DeskClient, type LeaseContext } from "./desk-client.ts";
import { systemPrompt, taskMessage } from "./prompt.ts";
import type { Block, ChatMessage, ModelProvider } from "./provider.ts";
import { runTool, TOOLS } from "./tools.ts";

export interface AgentOptions {
  maxTurns: number;
  /** Stop the run once recorded spend since start reaches this (USD). */
  maxRunUsd: number;
  /** Stop after this many leases (0 = no limit). */
  maxLemmas: number;
  /** Stop when the desk has nothing to lease (otherwise sleep and retry). */
  exitWhenIdle: boolean;
  idleSleepMs: number;
  killSwitch: () => boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

type AttemptOutcome = { result: "checked" } | { result: "failed"; notes: string } | { result: "stopped"; reason: string };

export class Agent {
  private startedAt = new Date();
  private name: string;

  constructor(private desk: DeskClient, private provider: ModelProvider, private opts: AgentOptions) {
    this.name = petIdentity(desk.agentId).displayName;
  }

  async run(): Promise<{ leased: number; checked: string[]; stopReason: string }> {
    await this.desk.register(this.provider.model);
    const checked: string[] = [];
    let leased = 0;
    for (;;) {
      const stop = await this.stopReason();
      if (stop) return { leased, checked, stopReason: stop };
      if (this.opts.maxLemmas && leased >= this.opts.maxLemmas) return { leased, checked, stopReason: "max lemmas reached" };
      const ctx = await this.desk.lease();
      if (!ctx) {
        if (this.opts.exitWhenIdle) return { leased, checked, stopReason: "nothing to lease" };
        await new Promise((r) => setTimeout(r, this.opts.idleSleepMs));
        continue;
      }
      leased++;
      this.opts.log(`leased ${ctx.lemmaId}`, { title: ctx.title });
      const outcome = await this.workOnLemma(ctx);
      if (outcome === "checked") checked.push(ctx.lemmaId);
      if (outcome === "stopped") return { leased, checked, stopReason: (await this.stopReason()) ?? "stopped" };
    }
  }

  private async stopReason(): Promise<string | null> {
    if (this.opts.killSwitch()) return "kill switch";
    const spent = await this.desk.spentSince(this.startedAt);
    if (spent >= this.opts.maxRunUsd) return `run spend cap reached ($${spent.toFixed(6)} >= $${this.opts.maxRunUsd})`;
    return null;
  }

  private async workOnLemma(ctx: LeaseContext): Promise<"checked" | "released" | "stopped"> {
    const ownNotes: string[] = [];
    for (let n = ctx.myFailedAttempts + 1; n <= ctx.maxAttemptsPerLemma; n++) {
      const attemptId = await this.desk.startAttempt(ctx.lemmaId);
      const out = await this.attempt(ctx, attemptId, n, ownNotes);
      if (out.result === "checked") {
        this.opts.log(`CHECKED ${ctx.lemmaId}`);
        return "checked";
      }
      if (out.result === "stopped") {
        await this.desk.release(ctx.lemmaId, `stopped: ${out.reason}`, false).catch(() => {});
        return "stopped";
      }
      ownNotes.push(out.notes);
      this.opts.log(`attempt ${n} on ${ctx.lemmaId} failed`, { notes: out.notes.slice(0, 200) });
    }
    await this.desk.release(ctx.lemmaId, `Gave up after ${ctx.maxAttemptsPerLemma} attempts.\n${ownNotes.map((x, i) => `${i + 1}. ${x}`).join("\n")}`, true);
    this.opts.log(`abandoned ${ctx.lemmaId}`);
    return "released";
  }

  private async attempt(ctx: LeaseContext, attemptId: number, attemptNo: number, ownNotes: string[]): Promise<AttemptOutcome> {
    const system = systemPrompt({ name: this.name });
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: taskMessage(ctx, attemptNo, ownNotes) }] }];
    let lastChecked: string | null = null;
    let lastErrors = "";
    for (let turn = 0; turn < this.opts.maxTurns; turn++) {
      const stop = await this.stopReason();
      if (stop) {
        await this.desk.finish(attemptId, "failed", `stopped: ${stop}`, null);
        return { result: "stopped", reason: stop };
      }
      try {
        await this.desk.heartbeat(ctx.lemmaId);
      } catch (err) {
        if (err instanceof DeskHttpError && err.status === 409) return { result: "stopped", reason: "lease lost" };
        throw err;
      }
      const resp = await this.provider.call({ system, messages, tools: TOOLS });
      await this.desk.recordUsage(attemptId, { model: resp.model, requestId: resp.requestId, fallbackUsed: resp.fallbackUsed, ...resp.usage });
      messages.push({ role: "assistant", content: resp.content });

      if (resp.stopReason === "refusal") {
        await this.desk.finish(attemptId, "failed", "the model declined this request", null);
        return { result: "failed", notes: "model declined" };
      }
      const calls = resp.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      if (!calls.length) {
        messages.push({ role: "user", content: [{ type: "text", text: "Continue: use lean_check on a complete file, then submit_proof once it passes." }] });
        continue;
      }
      // Run every call; a submission is handled last because it ends the attempt.
      const results: Block[] = [];
      let submission: Extract<Block, { type: "tool_use" }> | null = null;
      for (const c of calls) {
        if (c.name === "submit_proof") {
          submission ??= c;
          if (submission !== c) results.push({ type: "tool_result", toolUseId: c.id, content: "only one submission per attempt", isError: true });
          continue;
        }
        const out = await runTool(this.desk, attemptId, c.name, c.input);
        if (out.kind === "result") {
          results.push({ type: "tool_result", toolUseId: c.id, content: out.content, isError: out.isError });
          if (out.checkedSource !== undefined) {
            lastChecked = out.checkedSource;
            lastErrors = out.lastErrors ?? "";
          }
        }
      }
      if (submission) {
        const out = await runTool(this.desk, attemptId, "submit_proof", submission.input);
        if (out.kind === "submitted") {
          if (out.verdict.verdict === "pass") return { result: "checked" };
          const notes = `${(submission.input as { notes?: string }).notes ?? ""} | judge: ${out.verdict.reasons.map((r) => r.code).join(", ")}`;
          return { result: "failed", notes };
        }
        // The desk refused the submission itself (e.g. importing an unchecked lemma): attempt is over.
        return { result: "failed", notes: `submission refused: ${out.content.slice(0, 300)}` };
      }
      messages.push({ role: "user", content: results });
    }
    // Turn limit: submit the last checked file if there is one (section 6: "submit final file").
    if (lastChecked !== null) {
      const v = await this.desk.submit(attemptId, lastChecked, `turn limit reached; last lean_check: ${lastErrors.slice(0, 300) || "pass"}`);
      return v.verdict === "pass" ? { result: "checked" } : { result: "failed", notes: `turn limit; ${v.reasons.map((r) => r.code).join(", ")}` };
    }
    await this.desk.finish(attemptId, "failed", "turn limit reached without a complete file", null);
    return { result: "failed", notes: "turn limit reached without a complete file" };
  }
}

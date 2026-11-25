/**
 * The agent loop (BUILD_PROMPT.md sections 6 and 6b).
 *
 * Before EVERY model call (proving or replying) the agent asks the desk whether it may spend:
 * kill switch, pantry, global cap, its own cap. If not, it pauses the attempt, releases its
 * lemma, reports "sleeping" once, and polls until it is allowed again.
 */
import { petIdentity, type SleepReason } from "@hatchery/shared";
import { DeskHttpError, type DeskClient, type LeaseContext, type Reply } from "./desk-client.ts";
import { handoffNote, parseReply, REPLY_SYSTEM, replyPrompt, repliesText, systemPrompt, taskMessage } from "./prompt.ts";
import type { Block, ChatMessage, ModelProvider } from "./provider.ts";
import { runTool, TOOLS } from "./tools.ts";

export interface AgentOptions {
  maxTurns: number;
  /** Optional local safety stop: end the run once its recorded spend reaches this (USD). 0 = off. */
  maxRunUsd: number;
  /** Stop after this many leases (0 = no limit). */
  maxLemmas: number;
  /** Stop when the desk has nothing to lease (otherwise wait and retry, answering teammates). */
  exitWhenIdle: boolean;
  idleSleepMs: number;
  /** While sleeping (cap / pantry / kill switch), poll the desk this often. */
  sleepPollMs: number;
  /** After asking a question, wait up to this long for an answer before the next attempt. */
  replyWaitMs: number;
  replyMaxTokens: number;
  /** The worker's own kill switch (KILL_SWITCH=1 in its environment). */
  killSwitch: () => boolean;
  /** Test hook / graceful shutdown: stop at the next loop iteration. */
  shouldStop?: () => boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Only lease lemmas of this program (e.g. "definition-sanity"); default: any. */
  program?: string;
}

type AttemptOutcome =
  | { result: "checked" }
  | { result: "failed"; notes: string; asked: boolean }
  | { result: "paused"; reason: SleepReason }
  | { result: "stopped"; reason: string }
  | { result: "judge_down" }
  | { result: "lost" };

type LemmaOutcome = "checked" | "released" | "paused" | "stopped" | "lost";

/** The worker's own run cap (WORKER_MAX_RUN_USD) ends the run; it is not a desk sleep reason. */
class RunCapReached extends Error {}

class Paused extends Error {
  constructor(readonly reason: SleepReason) {
    super(`paused: ${reason}`);
  }
}

export class Agent {
  private startedAt = new Date();
  readonly name: string;
  private camp = "none yet";
  private stopMessage = "";
  private lastChecked: string | null = null;
  private lastErrors = "";

  constructor(private desk: DeskClient, private provider: ModelProvider, private opts: AgentOptions) {
    this.name = petIdentity(desk.agentId).displayName;
  }

  private stopRequested() {
    return this.opts.shouldStop?.() ?? false;
  }

  /** The budget gate: null = may call a model now. Throws RunCapReached when the local run cap is hit. */
  private async mayCall(): Promise<SleepReason | null> {
    if (this.opts.killSwitch()) return "kill_switch";
    if (this.opts.maxRunUsd > 0) {
      const spent = await this.desk.spentSince(this.startedAt);
      if (spent >= this.opts.maxRunUsd) throw new RunCapReached(`run spend cap reached ($${spent.toFixed(6)} >= $${this.opts.maxRunUsd})`);
    }
    const b = await this.desk.budget();
    return b.allowed ? null : b.reason;
  }

  async run(): Promise<{ leased: number; checked: string[]; stopReason: string }> {
    await this.desk.register(this.provider.model);
    const checked: string[] = [];
    let leased = 0;
    for (;;) {
      if (this.stopRequested()) return { leased, checked, stopReason: "stop requested" };
      if (this.opts.maxLemmas && leased >= this.opts.maxLemmas) return { leased, checked, stopReason: "max lemmas reached" };

      let blocked: SleepReason | null;
      try {
        blocked = await this.mayCall();
      } catch (err) {
        if (err instanceof RunCapReached) return { leased, checked, stopReason: err.message };
        throw err;
      }
      if (blocked) {
        await this.sleep(blocked);
        continue;
      }
      await this.answerInbox();

      let ctx: LeaseContext | null;
      try {
        ctx = await this.desk.lease(this.opts.program);
      } catch (err) {
        if (err instanceof DeskHttpError && err.status === 429) continue; // became blocked meanwhile: next iteration sleeps
        if (err instanceof DeskHttpError && err.status === 503) {
          this.opts.log("desk refuses work (judge unavailable or stale)", { error: err.message });
          await wait(this.opts.idleSleepMs);
          continue;
        }
        throw err;
      }
      if (!ctx) {
        if (this.opts.exitWhenIdle) return { leased, checked, stopReason: "nothing to lease" };
        await wait(this.opts.idleSleepMs);
        continue;
      }
      leased++;
      this.camp = ctx.program;
      this.opts.log(`leased ${ctx.lemmaId}`, { title: ctx.title, viaHandoff: ctx.offeredToMe });
      const outcome = await this.workOnLemma(ctx);
      if (outcome === "checked") checked.push(ctx.lemmaId);
      if (outcome === "stopped") return { leased, checked, stopReason: this.stopMessage };
    }
  }

  private async sleep(reason: SleepReason) {
    await this.desk.sleep(reason);
    this.opts.log("sleeping", { reason });
    await wait(this.opts.sleepPollMs);
  }

  /** Answer questions routed to this agent: one short model call each (section 6b). */
  private async answerInbox(): Promise<void> {
    const inbox = await this.desk.inbox();
    for (const q of inbox) {
      const can = await this.desk.canReply();
      if (!can.ok || (await this.mayCall())) return;
      const turn = await this.provider.call(
        { system: REPLY_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: replyPrompt(q) }] }], tools: [] },
        { maxTokens: this.opts.replyMaxTokens, effort: "low" },
      );
      const text = turn.content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
      const r = turn.stopReason === "refusal" ? { kind: "reply" as const, body: "I can't help with this one.", short: "can't help" } : parseReply(text);
      try {
        await this.desk.reply(q.questionId, { ...r, parts: turn.parts, requestId: turn.requestId });
        this.opts.log(`replied to ${q.fromName}`, { questionId: q.questionId, short: r.short });
      } catch (err) {
        if (!(err instanceof DeskHttpError && [404, 409, 410, 429].includes(err.status))) throw err;
      }
    }
  }

  private async workOnLemma(ctx: LeaseContext): Promise<LemmaOutcome> {
    const ownNotes: string[] = [];
    this.lastChecked = null;
    this.lastErrors = "";
    let asked = false;
    for (let n = ctx.myFailedAttempts + 1; n <= ctx.maxAttemptsPerLemma; n++) {
      if (asked) await this.waitForReply(ctx);
      let attemptId: number;
      try {
        attemptId = await this.desk.startAttempt(ctx.lemmaId);
      } catch (err) {
        if (err instanceof DeskHttpError && err.status === 409) return "lost";
        throw err;
      }
      const out = await this.attempt(ctx, attemptId, n, ownNotes);
      if (out.result === "checked") {
        this.opts.log(`CHECKED ${ctx.lemmaId}`);
        return "checked";
      }
      if (out.result === "judge_down") {
        // Not the agent's failure: give the lemma back, wait, and carry on with the run.
        await this.desk.release(ctx.lemmaId, "judge unavailable (infrastructure error)", false).catch(() => {});
        this.opts.log(`judge unavailable on ${ctx.lemmaId}; released, will retry later`);
        await wait(this.opts.idleSleepMs);
        return "lost";
      }
      if (out.result === "lost") {
        this.opts.log(`lease on ${ctx.lemmaId} lost; moving on`);
        return "lost";
      }
      if (out.result === "paused") {
        await this.desk.release(ctx.lemmaId, `paused: ${out.reason}`, false).catch(() => {});
        return "paused";
      }
      if (out.result === "stopped") {
        this.stopMessage = out.reason;
        await this.desk.release(ctx.lemmaId, `stopped: ${out.reason}`, false).catch(() => {});
        return "stopped";
      }
      asked ||= out.asked;
      ownNotes.push(out.notes);
      this.opts.log(`attempt ${n} on ${ctx.lemmaId} failed`, { notes: out.notes.slice(0, 200) });
    }
    const h = handoffNote(ctx, ownNotes, this.lastErrors, this.lastChecked);
    const r = await this.desk
      .release(ctx.lemmaId, `Gave up after ${ctx.maxAttemptsPerLemma} attempts.\n${ownNotes.map((x, i) => `${i + 1}. ${x}`).join("\n")}`, true, h)
      .catch((err) => {
        if (err instanceof DeskHttpError && err.status === 409) return null;
        throw err;
      });
    this.opts.log(`abandoned ${ctx.lemmaId}`, { handedTo: r?.offeredTo ?? null });
    return "released";
  }

  /** Don't burn tokens on a new attempt while a teammate is answering (bounded wait). */
  private async waitForReply(ctx: LeaseContext): Promise<void> {
    const until = Date.now() + this.opts.replyWaitMs;
    while (Date.now() < until && !this.stopRequested()) {
      if (!(await this.desk.awaitingReply(ctx.lemmaId))) return;
      await this.desk.heartbeat(ctx.lemmaId).catch(() => {});
      await wait(Math.min(500, this.opts.idleSleepMs || 500));
    }
  }

  private async attempt(ctx: LeaseContext, attemptId: number, attemptNo: number, ownNotes: string[]): Promise<AttemptOutcome> {
    const colony = await this.desk.colony().catch(() => null);
    const system = systemPrompt({ name: this.name, camp: this.camp }, colony);
    const firstReplies = await this.desk.takeReplies(ctx.lemmaId, attemptId);
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: taskMessage(ctx, attemptNo, ownNotes, firstReplies) }] }];
    let asked = false;
    try {
      for (let turn = 0; turn < this.opts.maxTurns; turn++) {
        await this.beforeModelCall(ctx, attemptId, messages, turn > 0);
        const resp = await this.provider.call({ system, messages, tools: TOOLS });
        try {
          await this.desk.recordUsage(attemptId, { parts: resp.parts, requestId: resp.requestId });
        } catch (err) {
          if (!(err instanceof DeskHttpError && err.status === 409)) throw err;
        }
        messages.push({ role: "assistant", content: resp.content });

        if (resp.stopReason === "refusal") {
          await this.desk.finish(attemptId, "failed", "the model declined this request", null);
          return { result: "failed", notes: "model declined", asked };
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
            if (submission) results.push({ type: "tool_result", toolUseId: c.id, content: "only one submission per attempt", isError: true });
            submission ??= c;
            continue;
          }
          const out = await runTool(this.desk, attemptId, c.name, c.input);
          if (out.kind === "result") {
            results.push({ type: "tool_result", toolUseId: c.id, content: out.content, isError: out.isError });
            if (out.checkedSource !== undefined) {
              this.lastChecked = out.checkedSource;
              this.lastErrors = out.lastErrors ?? "";
            }
            asked ||= out.asked ?? false;
          }
        }
        if (submission) {
          const out = await runTool(this.desk, attemptId, "submit_proof", submission.input);
          if (out.kind === "submitted") {
            if (out.verdict.verdict === "pass") return { result: "checked" };
            const notes = `${(submission.input as { notes?: string }).notes ?? ""} | judge: ${out.verdict.reasons.map((r) => r.code).join(", ")}`;
            return { result: "failed", notes, asked };
          }
          // The desk refused the submission itself (e.g. importing an unchecked lemma): attempt is over.
          return { result: "failed", notes: `submission refused: ${out.content.slice(0, 300)}`, asked };
        }
        messages.push({ role: "user", content: results });
      }
      // Turn limit: submit the last checked file if there is one (section 6: "submit final file").
      if (this.lastChecked !== null) {
        const v = await this.desk.submit(attemptId, this.lastChecked, `turn limit reached; last lean_check: ${this.lastErrors.slice(0, 300) || "pass"}`);
        return v.verdict === "pass" ? { result: "checked" } : { result: "failed", notes: `turn limit; ${v.reasons.map((r) => r.code).join(", ")}`, asked };
      }
      await this.desk.finish(attemptId, "failed", "turn limit reached without a complete file", null);
      return { result: "failed", notes: "turn limit reached without a complete file", asked };
    } catch (err) {
      if (err instanceof Paused) {
        await this.desk.finish(attemptId, "timeout", `paused: ${err.reason}`, null).catch(() => {});
        return { result: "paused", reason: err.reason };
      }
      if (err instanceof RunCapReached) {
        await this.desk.finish(attemptId, "timeout", `stopped: ${err.message}`, null).catch(() => {});
        return { result: "stopped", reason: err.message };
      }
      if (err instanceof DeskHttpError && err.status === 409) return { result: "lost" };
      if (err instanceof DeskHttpError && err.status === 503 && err.reason === "judge_unavailable") {
        await this.desk.finish(attemptId, "timeout", "judge unavailable (infrastructure error)", null).catch(() => {});
        return { result: "judge_down" };
      }
      throw err;
    }
  }

  /** Budget gate, teammate inbox, heartbeat, and delivery of teammates' answers before each call. */
  private async beforeModelCall(ctx: LeaseContext, attemptId: number, messages: ChatMessage[], deliver: boolean): Promise<void> {
    const blocked = await this.mayCall();
    if (blocked) throw new Paused(blocked);
    await this.answerInbox();
    const stillBlocked = await this.mayCall(); // the replies may have used the last of the cap
    if (stillBlocked) throw new Paused(stillBlocked);
    await this.desk.heartbeat(ctx.lemmaId); // 409 => lease lost (expired or recovered by the desk)
    if (!deliver) return;
    const replies: Reply[] = await this.desk.takeReplies(ctx.lemmaId, attemptId);
    if (replies.length) {
      const last = messages.at(-1)!;
      last.content.push({ type: "text", text: `Answers from teammates to your question:\n${repliesText(replies)}` });
    }
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

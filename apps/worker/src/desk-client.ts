import type { JudgeVerdict, SleepReason } from "@hatchery/shared";
import type { UsagePart } from "./provider.ts";

/** Mirrors apps/desk LeaseContext (kept structural to avoid a runtime dependency on the desk). */
export interface LeaseContext {
  lemmaId: string;
  leanName: string;
  title: string;
  program: string;
  statementSource: string;
  leanStatement: string;
  expiresAt: string;
  previousNotes: { agentId: string; result: string | null; notes: string; judgeErrors: string | null; at: string }[];
  checkedLemmas: { id: string; leanName: string; leanStatement: string }[];
  myFailedAttempts: number;
  maxAttemptsPerLemma: number;
  handoffNote: string | null;
  offeredToMe: boolean;
}

export interface Budget {
  allowed: boolean;
  reason: SleepReason | null;
  agentSpentUsd: string;
  perAgentCapUsd: string;
}

export interface InboxQuestion {
  questionId: number;
  fromAgent: string;
  fromName: string;
  lemmaId: string;
  leanName: string;
  leanStatement: string;
  question: string;
  myCheckedProofs: { lemmaId: string; source: string }[];
}

export interface Reply {
  id: number;
  fromAgent: string;
  fromName: string;
  kind: string;
  body: string;
  questionId: number | null;
}

export interface Colony {
  agents: { id: string; name: string; program: string | null; lemmaId: string | null; status: string }[];
  recentlyChecked: { id: string; agentId: string | null; at: string | null }[];
}

export interface DecomposerContext {
  programs: { slug: string; title: string; description: string; idPrefix: string; open: number; proposed: number }[];
  definitions: { id: string; title: string; summary: string; draft: boolean; source: string }[];
  statements: { id: string; title: string; leanStatement: string; status: string; program: string; rejectReason: string | null }[];
  splitRequests: { id: number; lemmaId: string; reason: string; leanStatement: string; program: string }[];
}

export interface Proposal {
  program: string;
  title: string;
  imports: string[];
  prop: string;
  rationale: string;
  parentId?: string;
  splitRequestId?: number;
}

export interface ProposalResult {
  id: string;
  status: string;
  rejectReason: string | null;
}

/** Mirrors apps/desk ReviewTask (src/ai-review.ts). */
export type ReviewTask =
  | { kind: "definition"; roundId: number; definition: { id: string; title: string; summary: string; source: string; imports: { id: string; source: string }[]; requiresMathlib: boolean }; flags: string[] }
  | { kind: "statement"; roundId: number; statement: { id: string; title: string; leanStatement: string; source: string; rationale: string; program: { slug: string; title: string; description: string }; definitions: { id: string; summary: string }[] }; flags: string[] }
  | { kind: "adversary"; roundId: number; definition: { id: string; source: string; imports: { id: string; source: string }[] }; goals: { index: number; lemmaId: string; goal: string }[]; budgetUsd: number; spentUsd: string; minChecks: number; checks: number };

export class DeskHttpError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) {
    super(message);
  }
}

export interface DeskTimeouts {
  /** Ordinary desk requests. */
  requestMs: number;
  /** Requests that run the judge (lean_check, submit): two sandbox stages plus queueing. */
  judgeMs: number;
}
export const DEFAULT_DESK_TIMEOUTS: DeskTimeouts = { requestMs: 60_000, judgeMs: 15 * 60_000 };

export class DeskClient {
  constructor(
    private baseUrl: string,
    private token: string,
    readonly agentId: string,
    private timeouts: DeskTimeouts = DEFAULT_DESK_TIMEOUTS,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeouts.requestMs): Promise<T | null> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs), // never wait forever on the desk
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      let reason: string | undefined;
      try {
        const j = JSON.parse(text) as { error?: string; reason?: string };
        msg = j.error ?? text;
        reason = j.reason;
      } catch {}
      throw new DeskHttpError(res.status, msg.slice(0, 1000), reason);
    }
    return JSON.parse(text) as T;
  }
  private q(extra: Record<string, string | number> = {}) {
    return new URLSearchParams({ agentId: this.agentId, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString();
  }

  register(model: string) {
    return this.req("POST", "/internal/agents/register", { agentId: this.agentId, model });
  }
  async budget(): Promise<Budget> {
    return (await this.req<Budget>("GET", `/internal/budget?${this.q()}`))!;
  }
  sleep(reason: SleepReason) {
    return this.req("POST", "/internal/sleep", { agentId: this.agentId, reason });
  }
  async colony(): Promise<Colony> {
    return (await this.req<Colony>("GET", `/internal/colony?${this.q()}`))!;
  }
  lease(program?: string) {
    return this.req<LeaseContext>("POST", "/internal/lease", { agentId: this.agentId, program });
  }
  heartbeat(lemmaId: string) {
    return this.req("POST", "/internal/lease/heartbeat", { agentId: this.agentId, lemmaId });
  }
  release(lemmaId: string, notes: string, abandon: boolean, handoff?: { body: string; short: string; note: string }) {
    return this.req<{ offeredTo: string | null }>("POST", "/internal/lease/release", { agentId: this.agentId, lemmaId, notes, abandon, handoff });
  }
  async startAttempt(lemmaId: string): Promise<number> {
    return (await this.req<{ attemptId: number }>("POST", "/internal/attempts", { agentId: this.agentId, lemmaId }))!.attemptId;
  }
  recordUsage(attemptId: number, call: { parts: UsagePart[]; requestId?: string }) {
    return this.req<{ costUsd: string; attemptCostUsd: string }>("POST", `/internal/attempts/${attemptId}/usage`, { agentId: this.agentId, purpose: "prove", ...call });
  }
  async check(attemptId: number, source: string): Promise<JudgeVerdict> {
    return (await this.req<JudgeVerdict>("POST", `/internal/attempts/${attemptId}/check`, { agentId: this.agentId, source }, this.timeouts.judgeMs))!;
  }
  /** Submit; a judge infrastructure error (503) is retried a few times and is never the agent's failure. */
  async submit(attemptId: number, source: string, notes: string, retries = 3, backoffMs = 2000): Promise<JudgeVerdict> {
    for (let i = 0; ; i++) {
      try {
        return (await this.req<JudgeVerdict>("POST", `/internal/attempts/${attemptId}/submit`, { agentId: this.agentId, source, notes }, this.timeouts.judgeMs))!;
      } catch (err) {
        if (!(err instanceof DeskHttpError && err.status === 503 && err.reason === "judge_unavailable") || i >= retries) throw err;
        await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
  }
  finish(attemptId: number, result: "failed" | "timeout", notes: string, judgeErrors: string | null) {
    return this.req("POST", `/internal/attempts/${attemptId}/finish`, { agentId: this.agentId, result, notes, judgeErrors });
  }
  async ask(attemptId: number, body: string, short: string): Promise<{ questionId: number; routedTo: string[] }> {
    return (await this.req<{ questionId: number; routedTo: string[] }>("POST", `/internal/attempts/${attemptId}/ask`, { agentId: this.agentId, body, short }))!;
  }
  async inbox(): Promise<InboxQuestion[]> {
    return (await this.req<InboxQuestion[]>("GET", `/internal/inbox?${this.q()}`))!;
  }
  async canReply(): Promise<{ ok: boolean; reason?: string }> {
    return (await this.req<{ ok: boolean; reason?: string }>("GET", `/internal/can-reply?${this.q()}`))!;
  }
  reply(questionId: number, r: { kind: "reply" | "hint"; body: string; short: string; parts: UsagePart[]; requestId?: string }) {
    return this.req<{ messageId: number; costUsd: string }>("POST", `/internal/questions/${questionId}/reply`, { agentId: this.agentId, ...r });
  }
  async takeReplies(lemmaId: string, attemptId: number | null): Promise<Reply[]> {
    return (await this.req<Reply[]>("POST", "/internal/replies/take", { agentId: this.agentId, lemmaId, ...(attemptId ? { attemptId } : {}) }))!;
  }
  async awaitingReply(lemmaId: string): Promise<boolean> {
    return (await this.req<{ awaiting: boolean }>("GET", `/internal/awaiting-reply?${this.q({ lemmaId })}`))!.awaiting;
  }
  async spentSince(since: Date): Promise<number> {
    const r = await this.req<{ spentUsd: string }>("GET", `/internal/spent?${this.q({ since: since.toISOString() })}`);
    return Number(r!.spentUsd);
  }
  async readFile(path: string): Promise<string> {
    return (await this.req<{ content: string }>("GET", `/internal/files?${this.q({ path })}`))!.content;
  }
  async search(q: string): Promise<string> {
    return (await this.req<{ results: string }>("GET", `/internal/search?${this.q({ q })}`))!.results;
  }
  async requestSplit(attemptId: number, reason: string): Promise<{ splitRequestId: number }> {
    return (await this.req<{ splitRequestId: number }>("POST", `/internal/attempts/${attemptId}/split`, { agentId: this.agentId, reason }))!;
  }
  async decomposerContext(program?: string): Promise<DecomposerContext> {
    return (await this.req<DecomposerContext>("GET", `/internal/decomposer/context?${this.q(program ? { program } : {})}`))!;
  }
  async propose(p: Proposal): Promise<ProposalResult> {
    return (await this.req<ProposalResult>("POST", "/internal/proposals", { agentId: this.agentId, ...p }, this.timeouts.judgeMs))!;
  }
  recordOtherUsage(purpose: "decompose" | "review", call: { parts: UsagePart[]; requestId?: string }) {
    return this.req("POST", "/internal/usage", { agentId: this.agentId, purpose, ...call });
  }
  // ---------------------------------------------------------------- AI review (reviewer and adversary agents)
  async reviewTask(model: string): Promise<ReviewTask | null> {
    return this.req<ReviewTask>("GET", `/internal/review/task?${this.q({ model })}`);
  }
  async reviewVerdict(roundId: number, v: { model: string; agree: boolean; summary: string; reasoning: string; details: Record<string, unknown>; parts: UsagePart[]; requestId?: string }): Promise<{ roundStatus: string }> {
    return (await this.req<{ roundStatus: string }>("POST", `/internal/review/rounds/${roundId}/verdict`, { agentId: this.agentId, ...v }))!;
  }
  async adversaryUsage(roundId: number, call: { parts: UsagePart[]; requestId?: string }): Promise<{ spentUsd: string; budgetLeft: boolean }> {
    return (await this.req<{ spentUsd: string; budgetLeft: boolean }>("POST", `/internal/review/rounds/${roundId}/adversary/usage`, { agentId: this.agentId, ...call }))!;
  }
  async adversaryCheck(roundId: number, goalIndex: number, source: string): Promise<{ verdict: JudgeVerdict; roundStatus: string }> {
    return (await this.req<{ verdict: JudgeVerdict; roundStatus: string }>("POST", `/internal/review/rounds/${roundId}/adversary/check`, { agentId: this.agentId, goalIndex, source }, this.timeouts.judgeMs))!;
  }
  async adversaryDone(roundId: number, notes: string): Promise<{ roundStatus: string }> {
    return (await this.req<{ roundStatus: string }>("POST", `/internal/review/rounds/${roundId}/adversary/done`, { agentId: this.agentId, notes }))!;
  }

  async searchChecked(q: string): Promise<unknown[]> {
    return (await this.req<unknown[]>("GET", `/internal/checked?${this.q({ q })}`))!;
  }
}

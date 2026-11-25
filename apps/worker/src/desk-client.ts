import type { JudgeVerdict, TokenUsage } from "@hatchery/shared";

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
}

export class DeskHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class DeskClient {
  constructor(private baseUrl: string, private token: string, readonly agentId: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new DeskHttpError(res.status, msg.slice(0, 1000));
    }
    return JSON.parse(text) as T;
  }

  register(model: string) {
    return this.req("POST", "/internal/agents/register", { agentId: this.agentId, model });
  }
  lease(program?: string) {
    return this.req<LeaseContext>("POST", "/internal/lease", { agentId: this.agentId, program });
  }
  heartbeat(lemmaId: string) {
    return this.req("POST", "/internal/lease/heartbeat", { agentId: this.agentId, lemmaId });
  }
  release(lemmaId: string, notes: string, abandon: boolean) {
    return this.req("POST", "/internal/lease/release", { agentId: this.agentId, lemmaId, notes, abandon });
  }
  async startAttempt(lemmaId: string): Promise<number> {
    return (await this.req<{ attemptId: number }>("POST", "/internal/attempts", { agentId: this.agentId, lemmaId }))!.attemptId;
  }
  recordUsage(attemptId: number, u: TokenUsage & { model: string; requestId?: string; fallbackUsed?: boolean }) {
    return this.req<{ costUsd: string; attemptCostUsd: string }>("POST", `/internal/attempts/${attemptId}/usage`, { agentId: this.agentId, purpose: "prove", ...u });
  }
  async check(attemptId: number, source: string): Promise<JudgeVerdict> {
    return (await this.req<JudgeVerdict>("POST", `/internal/attempts/${attemptId}/check`, { agentId: this.agentId, source }))!;
  }
  async submit(attemptId: number, source: string, notes: string): Promise<JudgeVerdict> {
    return (await this.req<JudgeVerdict>("POST", `/internal/attempts/${attemptId}/submit`, { agentId: this.agentId, source, notes }))!;
  }
  finish(attemptId: number, result: "failed" | "timeout", notes: string, judgeErrors: string | null) {
    return this.req("POST", `/internal/attempts/${attemptId}/finish`, { agentId: this.agentId, result, notes, judgeErrors });
  }
  async spentSince(since: Date): Promise<number> {
    const r = await this.req<{ spentUsd: string }>("GET", `/internal/spent?agentId=${this.agentId}&since=${encodeURIComponent(since.toISOString())}`);
    return Number(r!.spentUsd);
  }
  async readFile(path: string): Promise<string> {
    return (await this.req<{ content: string }>("GET", `/internal/files?path=${encodeURIComponent(path)}`))!.content;
  }
  async search(q: string): Promise<string> {
    return (await this.req<{ results: string }>("GET", `/internal/search?q=${encodeURIComponent(q)}`))!.results;
  }
}

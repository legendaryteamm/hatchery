import {
  JudgeVerdictSchema,
  StatementCheckResultSchema,
  type JudgeRequestInput,
  type JudgeVerdict,
  type StatementCheckResult,
} from "@hatchery/shared";

export interface JudgeInfo {
  flavor: "full" | "lite" | "unknown";
  trustedSha: string;
  leanVersion: string;
}

/** What the desk needs from the judge. HTTP in production; in-process in tests. */
export interface JudgeClient {
  check(req: JudgeRequestInput): Promise<JudgeVerdict>;
  info(): Promise<JudgeInfo>;
  search(query: string): Promise<string>;
  statementCheck(req: { lemmaId: string; source: string }): Promise<StatementCheckResult>;
}

export class HttpJudgeClient implements JudgeClient {
  constructor(private baseUrl: string, private token?: string) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async check(req: JudgeRequestInput): Promise<JudgeVerdict> {
    // Retry only "queue full" (503); a verdict is never retried.
    for (let i = 0; ; i++) {
      const res = await fetch(`${this.baseUrl}/check`, { method: "POST", headers: this.headers(), body: JSON.stringify(req) });
      if (res.status === 503 && i < 30) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!res.ok) throw new Error(`judge returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return JudgeVerdictSchema.parse(await res.json());
    }
  }

  async info(): Promise<JudgeInfo> {
    const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers() });
    const body = (await res.json()) as Partial<JudgeInfo> & { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) throw new Error(`judge unhealthy: ${body.error ?? res.status}`);
    return { flavor: body.flavor ?? "unknown", trustedSha: body.trustedSha ?? "", leanVersion: body.leanVersion ?? "" };
  }

  async statementCheck(req: { lemmaId: string; source: string }): Promise<StatementCheckResult> {
    for (let i = 0; ; i++) {
      const res = await fetch(`${this.baseUrl}/statement-check`, { method: "POST", headers: this.headers(), body: JSON.stringify(req) });
      if (res.status === 503 && i < 30) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!res.ok) throw new Error(`judge returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return StatementCheckResultSchema.parse(await res.json());
    }
  }

  async search(query: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/search?q=${encodeURIComponent(query)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`judge search failed: ${res.status}`);
    return ((await res.json()) as { results: string }).results;
  }
}

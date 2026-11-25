/**
 * Outside contributors (BUILD_PROMPT.md section 10).
 *
 *   Sign-in   GitHub OAuth (read-only: the public profile, no scopes). LOCAL ONLY: a dev login with
 *             any name (DEV_LOGIN=1, refused unless the site runs on localhost).
 *   Agents    A signed-in person creates an API token for their own agent (shown once, stored hashed).
 *   Leases    One lemma per GitHub handle; a heartbeat at least every 45 min (+15 min grace); 6 h at
 *             most. Outsiders spend nothing from the pantry; only the kill switch stops them.
 *   Proofs    A pull request that adds lean/Proofs/<L>.lean. CI judges it with the same runner image;
 *             the trusted contrib-merge workflow reports it here (CONTRIB_TOKEN), the desk judges it
 *             again with its own judge, and only then may the bot merge it.
 *
 * Prompt-injection hygiene: nothing an outsider sends (notes, PR text) is ever stored where an agent
 * reads it, or allowed to change budgets, statements or approvals. Their proofs are Lean source,
 * judged in the sandbox like any other.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { lemmaIdToLeanName, type JudgeVerdict } from "@hatchery/shared";
import { apiTokens, contributions, contributors, contributorSessions, leases, lemmas, statements } from "./db/schema.ts";
import { DeskError, emit, type Desk } from "./service.ts";

export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const agentIdFor = (login: string) => `gh-${login.toLowerCase()}`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const sha256 = hash;
const token = (prefix: string) => `${prefix}${randomBytes(24).toString("base64url")}`;

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface ExternalLease {
  lemmaId: string;
  leanName: string;
  title: string;
  program: string;
  statementPath: string;
  statementSource: string;
  proofPath: string;
  theorem: string;
  expiresAt: string;
  mustEndBy: string;
  heartbeatEverySeconds: number;
  previousAttempts: { result: string; judgeErrors: string | null; at: string }[];
}

export type SubmissionResult = { result: "pass" | "fail" | "refused"; reason: string; lemmaId: string; reasons?: string[] };

export class Contributors {
  constructor(
    private desk: Desk,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private get cfg() {
    return this.desk.config;
  }
  private get db() {
    return this.desk.db;
  }

  // ------------------------------------------------------------------ sign-in

  oauthEnabled(): boolean {
    return Boolean(this.cfg.GITHUB_CLIENT_ID && this.cfg.GITHUB_CLIENT_SECRET);
  }

  callbackUrl(): string {
    return `${this.cfg.PUBLIC_SITE_URL.replace(/\/$/, "")}/api/auth/github/callback`;
  }

  /** GitHub's consent page. No scopes: we only read the public login and id. */
  authorizeUrl(state: string): string {
    const q = new URLSearchParams({ client_id: this.cfg.GITHUB_CLIENT_ID!, redirect_uri: this.callbackUrl(), state, allow_signup: "true" });
    return `${this.cfg.GITHUB_OAUTH_URL}/login/oauth/authorize?${q}`;
  }

  /** Code -> GitHub login and id. The GitHub access token is used once and never stored. */
  async exchange(code: string): Promise<{ login: string; githubId: string }> {
    const r = await this.fetchFn(`${this.cfg.GITHUB_OAUTH_URL}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.cfg.GITHUB_CLIENT_ID, client_secret: this.cfg.GITHUB_CLIENT_SECRET, code, redirect_uri: this.callbackUrl() }),
      signal: AbortSignal.timeout(15_000),
    });
    const t = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!r.ok || !t.access_token) throw new DeskError(502, `GitHub sign-in failed${t.error ? `: ${t.error}` : ""}`);
    const u = await this.fetchFn(`${this.cfg.GITHUB_API_URL}/user`, {
      headers: { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "hatchery-desk" },
      signal: AbortSignal.timeout(15_000),
    });
    const user = (await u.json().catch(() => ({}))) as { login?: string; id?: number };
    if (!u.ok || typeof user.login !== "string" || !GITHUB_LOGIN.test(user.login) || typeof user.id !== "number") throw new DeskError(502, "GitHub did not return a user");
    return { login: user.login.toLowerCase(), githubId: String(user.id) };
  }

  /** Create (or find) the contributor and open a session. */
  async signIn(login: string, githubId: string | null, dev: boolean): Promise<{ token: string; expiresAt: Date; login: string }> {
    const l = login.toLowerCase();
    if (!GITHUB_LOGIN.test(l)) throw new DeskError(400, "not a valid GitHub login");
    const now = this.desk.now();
    const [existing] = await this.db.select().from(contributors).where(eq(contributors.login, l));
    if (existing?.blockedAt) throw new DeskError(403, "this account is blocked from contributing");
    if (existing && !existing.dev && dev) throw new DeskError(403, "this name belongs to a GitHub account; the dev login cannot use it");
    if (existing && existing.githubId && githubId && existing.githubId !== githubId) {
      // The login was renamed and taken by someone else on GitHub: never merge two people.
      throw new DeskError(409, "this GitHub login now belongs to a different account; ask a maintainer");
    }
    await this.db
      .insert(contributors)
      .values({ login: l, githubId, dev, lastSeenAt: now })
      .onConflictDoUpdate({ target: contributors.login, set: { lastSeenAt: now, ...(githubId ? { githubId } : {}) } });
    const t = token("hs_");
    const expiresAt = new Date(now.getTime() + this.cfg.CONTRIBUTOR_SESSION_DAYS * 86_400_000);
    await this.db.insert(contributorSessions).values({ tokenHash: hash(t), login: l, expiresAt });
    return { token: t, expiresAt, login: l };
  }

  async fromSession(t: string | undefined): Promise<string | null> {
    if (!t) return null;
    const [row] = await this.db
      .select({ login: contributors.login })
      .from(contributorSessions)
      .innerJoin(contributors, eq(contributors.login, contributorSessions.login))
      .where(and(eq(contributorSessions.tokenHash, hash(t)), gt(contributorSessions.expiresAt, this.desk.now()), isNull(contributors.blockedAt)));
    return row?.login ?? null;
  }

  async endSession(t: string): Promise<void> {
    await this.db.delete(contributorSessions).where(eq(contributorSessions.tokenHash, hash(t)));
  }

  async fromApiToken(t: string | undefined): Promise<string | null> {
    if (!t?.startsWith("hx_")) return null;
    const [row] = await this.db
      .select({ id: apiTokens.id, login: contributors.login })
      .from(apiTokens)
      .innerJoin(contributors, eq(contributors.login, apiTokens.login))
      .where(and(eq(apiTokens.tokenHash, hash(t)), isNull(apiTokens.revokedAt), isNull(contributors.blockedAt)));
    if (!row) return null;
    await this.db.update(apiTokens).set({ lastUsedAt: this.desk.now() }).where(eq(apiTokens.id, row.id));
    return row.login;
  }

  async createToken(login: string, label: string): Promise<{ id: number; token: string; label: string }> {
    const active = await this.db.select().from(apiTokens).where(and(eq(apiTokens.login, login), isNull(apiTokens.revokedAt)));
    if (active.length >= this.cfg.MAX_API_TOKENS_PER_CONTRIBUTOR) throw new DeskError(409, `at most ${this.cfg.MAX_API_TOKENS_PER_CONTRIBUTOR} active tokens; revoke one first`);
    const t = token("hx_");
    const [row] = await this.db.insert(apiTokens).values({ login, tokenHash: hash(t), label: label.slice(0, 60) }).returning();
    return { id: row!.id, token: t, label: row!.label };
  }

  async listTokens(login: string) {
    const rows = await this.db.select().from(apiTokens).where(eq(apiTokens.login, login)).orderBy(desc(apiTokens.id));
    return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revoked: !!r.revokedAt }));
  }

  async revokeToken(login: string, id: number): Promise<void> {
    await this.db.update(apiTokens).set({ revokedAt: this.desk.now() }).where(and(eq(apiTokens.id, id), eq(apiTokens.login, login), isNull(apiTokens.revokedAt)));
  }

  isAdmin(login: string): boolean {
    return this.cfg.ADMIN_GITHUB_HANDLES.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean).includes(login.toLowerCase());
  }

  /** Block an account: sessions end, tokens stop working, its lease is released. */
  async block(login: string): Promise<void> {
    const l = login.toLowerCase();
    const now = this.desk.now();
    await this.db.update(contributors).set({ blockedAt: now }).where(eq(contributors.login, l));
    await this.db.delete(contributorSessions).where(eq(contributorSessions.login, l));
    await this.db.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.login, l), isNull(apiTokens.revokedAt)));
    const held = await this.myLease(l);
    if (held) await this.desk.release(agentIdFor(l), held.lemmaId, "", false);
  }

  // ------------------------------------------------------------------ leases

  /** Outsiders prove from the repository, so only statements whose file is there (same text) can be leased. */
  private async inRepo(): Promise<(lemmaId: string) => boolean> {
    const approved = await this.db.select({ id: statements.id, leanName: statements.leanName, source: statements.source }).from(statements).where(eq(statements.status, "approved"));
    const ok = new Set<string>();
    for (const s of approved) {
      const f = join(this.desk.repo.dir, "Statements", `${s.leanName}.lean`);
      if (existsSync(f) && readFileSync(f, "utf8") === s.source) ok.add(s.id);
    }
    return (id) => ok.has(id);
  }

  private mustEndBy(createdAt: Date): Date {
    return new Date(createdAt.getTime() + this.cfg.EXTERNAL_LEASE_MAX_HOURS * 3_600_000);
  }

  private nextExpiry(now: Date, createdAt: Date): Date {
    const byHeartbeat = now.getTime() + (this.cfg.EXTERNAL_HEARTBEAT_SECONDS + this.cfg.EXTERNAL_HEARTBEAT_GRACE_SECONDS) * 1000;
    return new Date(Math.min(byHeartbeat, this.mustEndBy(createdAt).getTime()));
  }

  async lease(login: string, lemmaId?: string): Promise<ExternalLease | null> {
    const agentId = agentIdFor(login);
    await this.desk.expireLeases();
    const n = (await this.db.execute<{ n: number }>(sql`select count(*)::int as n from leases where holder like 'gh-%'`))[0]!.n;
    const mine = await this.myLease(login);
    if (mine) throw new DeskError(409, `you already hold ${mine.lemmaId}; release it first (one lemma per GitHub handle)`);
    if (n >= this.cfg.MAX_EXTERNAL_LEASES) throw new DeskError(429, "all slots for outside contributors are taken right now; try again later");
    await this.desk.registerAgent(agentId, "outside contributor (own tools)", "external");
    const now = this.desk.now();
    const ctx = await this.desk.lease(agentId, undefined, { lemmaId, external: { expiresAt: this.nextExpiry(now, now) }, eligible: await this.inRepo() });
    if (!ctx) return null;
    return {
      lemmaId: ctx.lemmaId,
      leanName: ctx.leanName,
      title: ctx.title,
      program: ctx.program,
      statementPath: `lean/Statements/${ctx.leanName}.lean`,
      statementSource: ctx.statementSource,
      proofPath: `lean/Proofs/${ctx.leanName}.lean`,
      theorem: `theorem Proof.${ctx.leanName} : Statement.${ctx.leanName} := by ...`,
      expiresAt: ctx.expiresAt,
      mustEndBy: this.mustEndBy(now).toISOString(),
      heartbeatEverySeconds: this.cfg.EXTERNAL_HEARTBEAT_SECONDS,
      previousAttempts: ctx.previousNotes.map((p) => ({ result: p.result ?? "", judgeErrors: p.judgeErrors, at: p.at })),
    };
  }

  async myLease(login: string) {
    const [l] = await this.db.select().from(leases).where(eq(leases.holder, agentIdFor(login)));
    return l && l.expiresAt > this.desk.now() ? l : null;
  }

  async heartbeat(login: string, lemmaId: string): Promise<{ expiresAt: string; mustEndBy: string }> {
    const l = await this.myLease(login);
    if (!l || l.lemmaId !== lemmaId) throw new DeskError(409, `you hold no active lease on ${lemmaId}`);
    const now = this.desk.now();
    if (now >= this.mustEndBy(l.createdAt)) throw new DeskError(409, `the lease on ${lemmaId} reached its ${this.cfg.EXTERNAL_LEASE_MAX_HOURS} h limit`);
    const expiresAt = this.nextExpiry(now, l.createdAt);
    await this.db.update(leases).set({ lastHeartbeat: now, expiresAt }).where(eq(leases.lemmaId, lemmaId));
    return { expiresAt: expiresAt.toISOString(), mustEndBy: this.mustEndBy(l.createdAt).toISOString() };
  }

  /** Give the lemma back. Outsiders' notes are not stored: agents never read text from outside. */
  async release(login: string, lemmaId: string): Promise<{ ok: true }> {
    await this.desk.release(agentIdFor(login), lemmaId, "", false);
    return { ok: true };
  }

  // ------------------------------------------------------------------ pull requests (called by CI)

  /**
   * A pull request adds `source` as the proof of `lemmaId`. The desk judges it with its own judge.
   * Idempotent per (PR, head commit). Accepted only from a signed-in contributor who holds the lease,
   * or for a lemma nobody holds (then it is leased to them now).
   */
  async submission(s: { login: string; prNumber: number; headSha: string; lemmaId: string; source: string }): Promise<SubmissionResult> {
    const login = s.login.toLowerCase();
    const [done] = await this.db.select().from(contributions).where(and(eq(contributions.prNumber, s.prNumber), eq(contributions.headSha, s.headSha)));
    if (done) return { result: done.result as SubmissionResult["result"], reason: done.reason, lemmaId: done.lemmaId };
    const record = async (result: SubmissionResult["result"], reason: string, attemptId: number | null = null, reasons?: string[]) => {
      await this.db
        .insert(contributions)
        .values({ login, prNumber: s.prNumber, headSha: s.headSha, lemmaId: s.lemmaId, sourceSha256: sha256(s.source), result, reason, attemptId })
        .onConflictDoNothing();
      return { result, reason, lemmaId: s.lemmaId, ...(reasons ? { reasons } : {}) };
    };

    const [person] = await this.db.select().from(contributors).where(eq(contributors.login, login));
    if (!person) return record("refused", `@${login} has not signed in yet: sign in at ${this.cfg.PUBLIC_SITE_URL}/join and lease the lemma first`);
    if (person.blockedAt) return record("refused", `@${login} is blocked from contributing`);
    const [lemma] = await this.db.select().from(lemmas).where(eq(lemmas.id, s.lemmaId));
    if (!lemma) return record("refused", `${s.lemmaId} is not a lemma of this project`);
    if (lemma.status === "checked") return record("refused", `${s.lemmaId} is already checked`);

    const agentId = agentIdFor(login);
    await this.desk.expireLeases();
    const [lease] = await this.db.select().from(leases).where(eq(leases.lemmaId, s.lemmaId));
    if (lease && lease.holder !== agentId) return record("refused", `${s.lemmaId} is leased by someone else right now; lease an open lemma at ${this.cfg.PUBLIC_SITE_URL}/join`);
    if (!lease) {
      try {
        const got = await this.lease(login, s.lemmaId);
        if (!got) return record("refused", `${s.lemmaId} is not open for outside contributors (not approved, waiting for review, needs Mathlib, or its statement is not in the repository)`);
      } catch (err) {
        if (err instanceof DeskError && err.status !== 503) return record("refused", err.message);
        throw err;
      }
    }

    let attemptId: number;
    try {
      attemptId = await this.desk.startAttempt(agentId, s.lemmaId);
    } catch (err) {
      if (err instanceof DeskError) return record("refused", `${err.message} (another pull request of yours is being checked; try again in a few minutes)`);
      throw err;
    }
    let verdict: JudgeVerdict;
    try {
      verdict = await this.desk.submit(attemptId, agentId, s.source, `pull request #${s.prNumber}`, { viaPr: s.prNumber });
    } catch (err) {
      if (err instanceof DeskError && err.status === 400) return record("fail", err.message, attemptId, ["dependency_error"]);
      // The judge was unavailable: nothing was decided. Close the attempt so the CI can simply retry.
      await this.desk.endAttempt(attemptId, agentId, "timeout", `pull request #${s.prNumber}: judge unavailable`, null).catch(() => {});
      throw err;
    }
    if (verdict.verdict === "pass") return record("pass", "the desk's Lean judge accepted the proof", attemptId);
    return record("fail", verdict.reasons.map((r) => `${r.code}: ${r.message}`).join("\n").slice(0, 2000), attemptId, verdict.reasons.map((r) => r.code));
  }

  /** The bot merged the pull request: the proof's pinned commit is the merge commit. */
  async merged(m: { prNumber: number; headSha: string; commit: string }): Promise<{ lemmaId: string }> {
    const [c] = await this.db.select().from(contributions).where(and(eq(contributions.prNumber, m.prNumber), eq(contributions.headSha, m.headSha), eq(contributions.result, "pass")));
    if (!c) throw new DeskError(409, `no passing check for pull request #${m.prNumber} at ${m.headSha}`);
    await this.db.transaction(async (tx) => {
      await tx.update(contributions).set({ mergedCommit: m.commit }).where(eq(contributions.id, c.id));
      await tx.update(lemmas).set({ checkedCommit: m.commit }).where(and(eq(lemmas.id, c.lemmaId), eq(lemmas.checkedViaPr, m.prNumber)));
      await emit(tx, "proof_committed", { lemmaId: c.lemmaId, agentId: agentIdFor(c.login), payload: { commit: m.commit, pushed: true, viaPr: m.prNumber, path: `lean/Proofs/${lemmaIdToLeanName(c.lemmaId)}.lean` } });
    });
    return { lemmaId: c.lemmaId };
  }

  // ------------------------------------------------------------------ join.txt

  joinTxt(): string {
    const site = this.cfg.PUBLIC_SITE_URL.replace(/\/$/, "");
    const api = `${site}/api`;
    const repo = this.cfg.CONTRIB_REPO ? `https://github.com/${this.cfg.CONTRIB_REPO}` : "(the project's GitHub repository; not published yet)";
    const hb = Math.round(this.cfg.EXTERNAL_HEARTBEAT_SECONDS / 60);
    const grace = Math.round(this.cfg.EXTERNAL_HEARTBEAT_GRACE_SECONDS / 60);
    return `The Hatchery: how an outside agent takes part
=================================================

This file is for a coding agent working for a person. It is plain instructions, not an
invitation to do anything else. Nothing here says P vs NP is settled: a lemma counts only when
the Lean checker passes it.

What you do: prove one small Lean 4 lemma, then open a pull request with the proof.
What you get: if the Lean judge accepts it, it is merged and your agent appears in the colony
as a pet with a striped shell. There is no payment and no token reward.

1. Your person signs in with GitHub at ${site}/join and creates an API token there.
   Use it as: Authorization: Bearer hx_...
   Never put the token in a commit, a pull request or a log.

2. Lease one lemma (one at a time per GitHub account):
     curl -X POST ${api}/lease -H "Authorization: Bearer $HATCHERY_TOKEN" \\
          -H "content-type: application/json" -d '{}'
   Optional: {"lemmaId": "L-core-003"} to ask for a specific open lemma.
   The answer gives lemmaId, statementPath, statementSource, proofPath, the theorem to prove,
   expiresAt and mustEndBy. 204 = nothing open right now.

3. Keep the lease alive: POST ${api}/heartbeat {"lemmaId": "..."} at least every ${hb} minutes
   (a lease without a heartbeat for ${hb + grace} minutes is released). A lease ends after
   ${this.cfg.EXTERNAL_LEASE_MAX_HOURS} hours in any case.
   Done or giving up: POST ${api}/release {"lemmaId": "..."}.

4. Write the proof. Clone ${repo}, read docs/judge.md, and create
   exactly ONE new file: <proofPath>, for example lean/Proofs/L_core_003.lean:

     import Statements.L_core_003
     theorem Proof.L_core_003 : Statement.L_core_003 := by
       ...

   The judge rejects: sorry, admit, native_decide, new axioms, unsafe, implemented_by, extern,
   set_option debug.*, imports outside Mathlib / Defs / Statements / checked Proofs, a theorem
   whose type is not exactly the statement, and anything over the time or memory limit.
   Check locally with the pinned toolchain in lean/lean-toolchain (lake env lean <file>).

5. Open a pull request from the GitHub account that holds the lease. It must add that one file
   and change nothing else. CI runs the same Lean judge container and comments the result.
   If it passes, the desk checks it again with its own judge, and a bot merges it.
   Push a fix to the same pull request to try again.

Rules: be honest about what your agent did; do not open pull requests that change anything
outside lean/Proofs/; do not try to break the sandbox. Accounts that abuse the service are blocked.
Live status: ${site}/feed   Open lemmas: ${site}/programs   Rate limits apply to every endpoint.
`;
  }
}

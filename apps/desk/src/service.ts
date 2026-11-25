/**
 * Desk core: leases, attempts, spend, submissions and re-checks.
 * Every state change writes exactly one `events` row in the same transaction.
 */
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  costMicroUsd,
  lemmaIdToLeanName,
  microsToUsd,
  petIdentity,
  priceTable,
  PRICES_AS_OF,
  type EventType,
  type JudgeVerdict,
  type ProofDep,
  type TokenUsage,
} from "@hatchery/shared";
import type { DeskConfig } from "./config.ts";
import type { Db, Tx } from "./db/client.ts";
import { agents, attempts, events, leases, lemmas, modelCalls, programs, statements } from "./db/schema.ts";
import type { JudgeClient, JudgeInfo } from "./judge-client.ts";
import { sha256, type LeanRepo } from "./lean-repo.ts";

export class DeskError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Programs known to the desk. Phase 3 adds the research programs from section 7. */
export const PROGRAMS = [
  {
    slug: "core-warmup",
    title: "Core warm-up",
    description:
      "Known, easy facts provable in core Lean. They calibrate the pipeline (agents, judge, costs). They are not research progress on P vs NP.",
  },
] as const;

type DbOrTx = Db | Tx;

export async function emit(
  db: DbOrTx,
  type: EventType,
  e: { agentId?: string | null; lemmaId?: string | null; payload?: Record<string, unknown> } = {},
): Promise<void> {
  await db.insert(events).values({ type, agentId: e.agentId ?? null, lemmaId: e.lemmaId ?? null, payload: e.payload ?? {} });
}

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

const PROOF_IMPORT_RE = /^[ \t]*import[ \t]+Proofs\.(L_[A-Za-z0-9_]+)\s*$/gm;

export class Desk {
  private judgeInfoCache: { info: JudgeInfo; at: number } | null = null;

  constructor(
    readonly db: Db,
    readonly judge: JudgeClient,
    readonly repo: LeanRepo,
    readonly config: DeskConfig,
    private now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- judge freshness / gates

  async judgeInfo(force = false): Promise<JudgeInfo> {
    if (!force && this.judgeInfoCache && Date.now() - this.judgeInfoCache.at < 60_000) return this.judgeInfoCache.info;
    const info = await this.judge.info();
    this.judgeInfoCache = { info, at: Date.now() };
    return info;
  }

  /** Fail closed when the judge image was built from different statements/defs than this checkout. */
  async assertJudgeFresh(): Promise<JudgeInfo> {
    const mine = this.repo.trustedSha();
    let info = await this.judgeInfo();
    if (info.trustedSha !== mine) info = await this.judgeInfo(true); // the image may just have been rebuilt
    if (info.trustedSha !== mine) {
      throw new DeskError(503, `judge runner image is stale (image ${info.trustedSha.slice(0, 12)}, checkout ${mine.slice(0, 12)}): rebuild the runner image`);
    }
    return info;
  }

  async mathlibAllowed(): Promise<boolean> {
    if (!this.config.MATHLIB_LEMMAS_ENABLED) return false;
    return (await this.judgeInfo()).flavor === "full";
  }

  // ---------------------------------------------------------------- statements

  /** Sync trusted statement files into the DB (approved: they are committed by a maintainer). */
  async syncStatements(): Promise<{ added: string[]; changed: string[] }> {
    const files = this.repo.statementFiles();
    const added: string[] = [];
    const changed: string[] = [];
    await this.db.transaction(async (tx) => {
      for (const p of PROGRAMS) {
        await tx.insert(programs).values(p).onConflictDoUpdate({ target: programs.slug, set: { title: p.title, description: p.description } });
      }
      const progRows = await tx.select().from(programs);
      for (const f of files) {
        const prog = progRows.find((p) => p.slug === f.program);
        if (!prog) throw new Error(`statement ${f.id}: unknown program "${f.program}"`);
        const [existing] = await tx.select().from(statements).where(eq(statements.id, f.id));
        const values = {
          programId: prog.id,
          leanName: f.leanName,
          title: f.title,
          leanStatement: f.leanStatement,
          dependsOn: f.dependsOn,
          requiresMathlib: f.requiresMathlib,
          fileSha256: f.fileSha256,
        };
        if (!existing) {
          await tx.insert(statements).values({ id: f.id, ...values, status: "approved", proposedBy: "repo", approvedBy: "repo" });
          await tx.insert(lemmas).values({ id: f.id, status: "open" });
          added.push(f.id);
          await emit(tx, "statement_synced", { lemmaId: f.id, payload: { change: "added" } });
        } else if (existing.fileSha256 !== f.fileSha256) {
          await tx.update(statements).set(values).where(eq(statements.id, f.id));
          changed.push(f.id);
          await emit(tx, "statement_synced", { lemmaId: f.id, payload: { change: "changed", from: existing.fileSha256, to: f.fileSha256 } });
        }
      }
    });
    return { added, changed };
  }

  // ---------------------------------------------------------------- agents

  async registerAgent(id: string, model: string, kind: "internal" | "external" = "internal") {
    const pet = petIdentity(id);
    const [row] = await this.db
      .insert(agents)
      .values({ id, model, kind, displayName: pet.displayName, species: pet.species, shellColor: pet.shellColor })
      .onConflictDoNothing()
      .returning();
    if (row) {
      await emit(this.db, "agent_registered", { agentId: id, payload: { model, kind } });
      return row;
    }
    await this.db.update(agents).set({ model }).where(eq(agents.id, id));
    const [existing] = await this.db.select().from(agents).where(eq(agents.id, id));
    return existing!;
  }

  // ---------------------------------------------------------------- leases

  async expireLeases(): Promise<string[]> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const expired = await tx.select().from(leases).where(lt(leases.expiresAt, now)).for("update", { skipLocked: true });
      for (const l of expired) {
        await tx.delete(leases).where(eq(leases.lemmaId, l.lemmaId));
        await tx.update(lemmas).set({ status: "open" }).where(and(eq(lemmas.id, l.lemmaId), eq(lemmas.status, "leased")));
        await tx
          .update(attempts)
          .set({ result: "timeout", endedAt: now, notes: "lease expired" })
          .where(and(eq(attempts.lemmaId, l.lemmaId), eq(attempts.agentId, l.holder), isNull(attempts.endedAt)));
        await emit(tx, "lease_expired", { agentId: l.holder, lemmaId: l.lemmaId });
      }
      return expired.map((l) => l.lemmaId);
    });
  }

  async lease(agentId: string, programSlug?: string): Promise<LeaseContext | null> {
    await this.assertJudgeFresh();
    await this.expireLeases();
    const mathlib = await this.mathlibAllowed();
    const max = this.config.AGENT_MAX_ATTEMPTS_PER_LEMMA;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.config.LEASE_TTL_MINUTES * 60_000);
    const lemmaId = await this.db.transaction(async (tx) => {
      const held = await tx.select().from(leases).where(eq(leases.holder, agentId));
      if (held.length) throw new DeskError(409, `agent already holds a lease on ${held[0]!.lemmaId}`);
      const rows = await tx.execute<{ id: string }>(sql`
        select l.id from lemmas l
        join statements s on s.id = l.id
        join programs p on p.id = s.program_id
        where l.status = 'open' and s.status = 'approved' and p.status = 'active'
          and (${mathlib} or not s.requires_mathlib)
          and (${programSlug ?? null}::text is null or p.slug = ${programSlug ?? null})
          and not exists (select 1 from events e where e.type = 'abandoned_by_agent' and e.agent_id = ${agentId} and e.lemma_id = l.id)
          and (select count(*) from attempts a where a.lemma_id = l.id and a.agent_id = ${agentId} and a.result is not null and a.result <> 'checked') < ${max}
        order by (select count(*) from attempts a where a.lemma_id = l.id) asc, l.id asc
        limit 1
        for update of l skip locked`);
      const id = rows[0]?.id;
      if (!id) return null;
      await tx.update(lemmas).set({ status: "leased" }).where(eq(lemmas.id, id));
      await tx.insert(leases).values({ lemmaId: id, holder: agentId, expiresAt, lastHeartbeat: now });
      await emit(tx, "leased", { agentId, lemmaId: id, payload: { expiresAt: expiresAt.toISOString() } });
      return id;
    });
    return lemmaId ? this.leaseContext(agentId, lemmaId, expiresAt) : null;
  }

  async leaseContext(agentId: string, lemmaId: string, expiresAt: Date): Promise<LeaseContext> {
    const [st] = await this.db
      .select({ s: statements, programSlug: programs.slug })
      .from(statements)
      .innerJoin(programs, eq(programs.id, statements.programId))
      .where(eq(statements.id, lemmaId));
    if (!st) throw new DeskError(404, `no statement ${lemmaId}`);
    const prev = await this.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.lemmaId, lemmaId), sql`${attempts.result} is not null and ${attempts.result} <> 'checked'`))
      .orderBy(desc(attempts.id))
      .limit(8);
    const checked = await this.db
      .select({ id: statements.id, leanName: statements.leanName, leanStatement: statements.leanStatement })
      .from(lemmas)
      .innerJoin(statements, eq(statements.id, lemmas.id))
      .where(eq(lemmas.status, "checked"))
      .orderBy(asc(lemmas.id))
      .limit(50);
    return {
      lemmaId,
      leanName: st.s.leanName,
      title: st.s.title,
      program: st.programSlug,
      statementSource: this.repo.read(`Statements/${st.s.leanName}.lean`),
      leanStatement: st.s.leanStatement,
      expiresAt: expiresAt.toISOString(),
      previousNotes: prev.map((a) => ({
        agentId: a.agentId,
        result: a.result,
        notes: a.notes ?? "",
        judgeErrors: a.judgeErrors,
        at: (a.endedAt ?? a.startedAt).toISOString(),
      })),
      checkedLemmas: checked,
      myFailedAttempts: prev.filter((a) => a.agentId === agentId).length,
      maxAttemptsPerLemma: this.config.AGENT_MAX_ATTEMPTS_PER_LEMMA,
    };
  }

  private async requireLease(db: DbOrTx, agentId: string, lemmaId: string) {
    const [l] = await db.select().from(leases).where(and(eq(leases.lemmaId, lemmaId), eq(leases.holder, agentId)));
    if (!l || l.expiresAt < this.now()) throw new DeskError(409, `agent ${agentId} holds no active lease on ${lemmaId}`);
    return l;
  }

  async heartbeat(agentId: string, lemmaId: string): Promise<{ expiresAt: string }> {
    await this.requireLease(this.db, agentId, lemmaId);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.config.LEASE_TTL_MINUTES * 60_000);
    await this.db.update(leases).set({ lastHeartbeat: now, expiresAt }).where(eq(leases.lemmaId, lemmaId));
    return { expiresAt: expiresAt.toISOString() };
  }

  /** Give a lemma back. `abandon` = this agent gives up after its max attempts (with notes). */
  async release(agentId: string, lemmaId: string, notes: string, abandon: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.requireLease(tx, agentId, lemmaId);
      await tx.delete(leases).where(eq(leases.lemmaId, lemmaId));
      const counted = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from attempts where lemma_id = ${lemmaId} and result is not null and result <> 'checked'`,
      );
      const n = Number(counted[0]?.n ?? 0);
      const globallyAbandoned = n >= this.config.LEMMA_ABANDON_AFTER_ATTEMPTS;
      await tx.update(lemmas).set({ status: globallyAbandoned ? "abandoned" : "open" }).where(eq(lemmas.id, lemmaId));
      await emit(tx, abandon ? "abandoned_by_agent" : "released", {
        agentId,
        lemmaId,
        payload: { notes: notes.slice(0, 2000), failedAttemptsTotal: n, lemmaAbandoned: globallyAbandoned },
      });
    });
  }

  // ---------------------------------------------------------------- attempts and spend

  async startAttempt(agentId: string, lemmaId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await this.requireLease(tx, agentId, lemmaId);
      const open = await tx.select().from(attempts).where(and(eq(attempts.agentId, agentId), isNull(attempts.endedAt)));
      if (open.length) throw new DeskError(409, `agent has an open attempt ${open[0]!.id}`);
      const [a] = await tx.insert(attempts).values({ agentId, lemmaId, startedAt: this.now() }).returning();
      await emit(tx, "attempt_started", { agentId, lemmaId, payload: { attemptId: a!.id } });
      return a!.id;
    });
  }

  private async openAttempt(db: DbOrTx, attemptId: number, agentId: string) {
    const [a] = await db.select().from(attempts).where(eq(attempts.id, attemptId));
    if (!a || a.agentId !== agentId) throw new DeskError(404, `no attempt ${attemptId} for ${agentId}`);
    if (a.endedAt) throw new DeskError(409, `attempt ${attemptId} already ended`);
    return a;
  }

  /** Record one model call from real token counts. Cost is computed here, from the price table. */
  async recordUsage(
    attemptId: number | null,
    agentId: string,
    u: TokenUsage & { model: string; purpose: string; requestId?: string; fallbackUsed?: boolean },
  ): Promise<{ costUsd: string; attemptCostUsd: string | null }> {
    let micros: number;
    try {
      micros = costMicroUsd(u.model, u, priceTable());
    } catch (err) {
      throw new DeskError(400, (err as Error).message);
    }
    const cost = microsToUsd(micros);
    return this.db.transaction(async (tx) => {
      let lemmaId: string | null = null;
      if (attemptId !== null) {
        const a = await this.openAttempt(tx, attemptId, agentId);
        lemmaId = a.lemmaId;
        await tx
          .update(attempts)
          .set({
            tokensIn: sql`${attempts.tokensIn} + ${u.inputTokens}`,
            tokensOut: sql`${attempts.tokensOut} + ${u.outputTokens}`,
            cacheReadTokens: sql`${attempts.cacheReadTokens} + ${u.cacheReadTokens}`,
            cacheWriteTokens: sql`${attempts.cacheWriteTokens} + ${u.cacheWriteTokens}`,
            costUsd: sql`${attempts.costUsd} + ${cost}::numeric`,
            turns: sql`${attempts.turns} + 1`,
          })
          .where(eq(attempts.id, attemptId));
      }
      await tx.insert(modelCalls).values({
        agentId,
        attemptId,
        purpose: u.purpose,
        model: u.model,
        tokensIn: u.inputTokens,
        tokensOut: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: cost,
        priceAsOf: PRICES_AS_OF,
        requestId: u.requestId ?? null,
        ts: this.now(),
      });
      await emit(tx, "model_call", {
        agentId,
        lemmaId,
        payload: { attemptId, model: u.model, purpose: u.purpose, tokensIn: u.inputTokens, tokensOut: u.outputTokens, costUsd: cost, fallbackUsed: u.fallbackUsed ?? false },
      });
      const [a] = attemptId === null ? [] : await tx.select({ c: attempts.costUsd }).from(attempts).where(eq(attempts.id, attemptId));
      return { costUsd: cost, attemptCostUsd: a?.c ?? null };
    });
  }

  /** Total model spend recorded for an agent since a time (used by the worker's run cap). */
  async spentSince(agentId: string, since: Date): Promise<string> {
    const [r] = await this.db.execute<{ s: string }>(
      sql`select coalesce(sum(cost_usd), 0)::numeric(14,6)::text as s from model_calls where agent_id = ${agentId} and ts >= ${since.toISOString()}::timestamptz`,
    );
    return r?.s ?? "0.000000";
  }

  // ---------------------------------------------------------------- proofs and dependencies

  /**
   * Checked proofs a source imports, as the closure the judge needs (dependency order).
   * Only lemmas with status "checked" may be imported, at the exact source they were checked with.
   */
  async resolveDeps(source: string, selfId: string): Promise<{ deps: ProofDep[]; direct: string[] }> {
    const direct = [...source.matchAll(PROOF_IMPORT_RE)].map((m) => m[1]!.replaceAll("_", "-"));
    const order: ProofDep[] = [];
    const seen = new Set<string>();
    const visit = async (id: string, path: string[]): Promise<void> => {
      if (id === selfId || path.includes(id)) throw new DeskError(400, `circular proof import: ${[...path, id].join(" -> ")}`);
      if (seen.has(id)) return;
      const [l] = await this.db.select().from(lemmas).where(eq(lemmas.id, id));
      if (!l || l.status !== "checked" || !l.checkedSource) {
        throw new DeskError(400, `import Proofs.${lemmaIdToLeanName(id)}: only lemmas with status "checked" can be imported (${id} is ${l?.status ?? "unknown"})`);
      }
      for (const d of l.proofImports) await visit(d, [...path, id]);
      seen.add(id);
      order.push({ lemmaId: id, source: l.checkedSource });
    };
    for (const id of direct) await visit(id, []);
    return { deps: order, direct };
  }

  /**
   * Fingerprint of everything a checked proof's validity depends on. If any input changes,
   * the lemma (and, transitively, every proof importing it) is marked for re-check.
   */
  async fingerprint(lemmaId: string, directImports: string[], memo = new Map<string, string>()): Promise<string> {
    const deps: string[] = [];
    for (const d of [...directImports].sort()) {
      const [l] = await this.db.select().from(lemmas).where(eq(lemmas.id, d));
      const depFp = memo.get(d) ?? (await this.fingerprint(d, l?.proofImports ?? [], memo));
      deps.push(`${d}:${l?.checkedSourceSha256 ?? "none"}:${depFp}`);
    }
    const fp = sha256(
      JSON.stringify({
        env: this.repo.envHash(),
        defs: this.repo.defsHash(),
        statement: this.repo.statementFileSha(lemmaIdToLeanName(lemmaId)) ?? "missing",
        deps,
      }),
    );
    memo.set(lemmaId, fp);
    return fp;
  }

  private async runJudge(lemmaId: string, source: string): Promise<{ verdict: JudgeVerdict; direct: string[] }> {
    const info = await this.assertJudgeFresh();
    const [st] = await this.db.select().from(statements).where(eq(statements.id, lemmaId));
    if (st?.requiresMathlib && info.flavor !== "full") throw new DeskError(503, `${lemmaId} needs Mathlib but the judge runs the ${info.flavor} image`);
    const { deps, direct } = await this.resolveDeps(source, lemmaId);
    return { verdict: await this.judge.check({ lemmaId, source, deps }), direct };
  }

  /** The worker's lean_check tool: full judge run, no status change. */
  async localCheck(attemptId: number, agentId: string, source: string): Promise<JudgeVerdict> {
    const a = await this.openAttempt(this.db, attemptId, agentId);
    await this.requireLease(this.db, agentId, a.lemmaId);
    let verdict: JudgeVerdict;
    try {
      verdict = (await this.runJudge(a.lemmaId, source)).verdict;
    } catch (err) {
      if (err instanceof DeskError && err.status === 400) {
        await emit(this.db, "local_check", { agentId, lemmaId: a.lemmaId, payload: { attemptId, ok: false, reasons: ["dependency_error"] } });
      }
      throw err;
    }
    await emit(this.db, "local_check", {
      agentId,
      lemmaId: a.lemmaId,
      payload: { attemptId, ok: verdict.verdict === "pass", reasons: verdict.reasons.map((r) => r.code) },
    });
    return verdict;
  }

  /** Official submission. Ends the attempt; on pass the lemma becomes "checked". */
  async submit(attemptId: number, agentId: string, source: string, notes: string): Promise<JudgeVerdict> {
    const a = await this.openAttempt(this.db, attemptId, agentId);
    await this.requireLease(this.db, agentId, a.lemmaId);
    await emit(this.db, "submitted", { agentId, lemmaId: a.lemmaId, payload: { attemptId, sourceSha256: sha256(source) } });
    let verdict: JudgeVerdict;
    let direct: string[];
    try {
      ({ verdict, direct } = await this.runJudge(a.lemmaId, source));
    } catch (err) {
      if (!(err instanceof DeskError && err.status === 400)) throw err;
      await this.endAttempt(attemptId, agentId, "failed", notes, err.message, source);
      await emit(this.db, "judge_rejected", { agentId, lemmaId: a.lemmaId, payload: { attemptId, reasons: ["dependency_error"] } });
      throw err;
    }
    const now = this.now();
    if (verdict.verdict === "pass") {
      const fp = await this.fingerprint(a.lemmaId, direct);
      await this.db.transaction(async (tx) => {
        await tx
          .update(lemmas)
          .set({
            status: "checked",
            checkedAt: now,
            checkedByAgent: agentId,
            checkedSource: source,
            checkedSourceSha256: sha256(source),
            checkedCommit: this.repo.gitCommit(this.config.GIT_COMMIT),
            checkedFingerprint: fp,
            checkedProofPath: `lean/Proofs/${lemmaIdToLeanName(a.lemmaId)}.lean`,
            proofImports: direct,
            checkedVerdict: verdict,
          })
          .where(eq(lemmas.id, a.lemmaId));
        await tx
          .update(attempts)
          .set({ result: "checked", endedAt: now, notes: notes.slice(0, 2000), submittedSource: source })
          .where(eq(attempts.id, attemptId));
        await tx.delete(leases).where(eq(leases.lemmaId, a.lemmaId));
        await emit(tx, "checked", {
          agentId,
          lemmaId: a.lemmaId,
          payload: { attemptId, axioms: verdict.axioms, checkers: verdict.checkers, reused: direct },
        });
      });
    } else {
      const errors = verdict.reasons.map((r) => `${r.code}: ${r.message}`).join("\n").slice(0, 4000);
      await this.endAttempt(attemptId, agentId, "failed", notes, errors, source);
      await emit(this.db, "judge_rejected", {
        agentId,
        lemmaId: a.lemmaId,
        payload: { attemptId, reasons: verdict.reasons.map((r) => r.code), stage: verdict.stage },
      });
    }
    return verdict;
  }

  async endAttempt(
    attemptId: number,
    agentId: string,
    result: "failed" | "timeout",
    notes: string,
    judgeErrors: string | null,
    source: string | null = null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const a = await this.openAttempt(tx, attemptId, agentId);
      await tx
        .update(attempts)
        .set({ result, endedAt: this.now(), notes: notes.slice(0, 2000), judgeErrors, submittedSource: source })
        .where(eq(attempts.id, attemptId));
      await emit(tx, "attempt_finished", { agentId, lemmaId: a.lemmaId, payload: { attemptId, result } });
    });
  }

  // ---------------------------------------------------------------- re-checks

  /** Mark checked lemmas whose fingerprint changed (statement, defs, toolchain or a dependency). */
  async recheckScan(): Promise<string[]> {
    const checked = await this.db.select().from(lemmas).where(eq(lemmas.status, "checked"));
    const memo = new Map<string, string>();
    const marked: string[] = [];
    for (const l of checked) {
      const fp = await this.fingerprint(l.id, l.proofImports, memo);
      if (fp !== l.checkedFingerprint) marked.push(l.id);
    }
    // Dependents of anything already awaiting a re-check are re-checked too.
    const pending = new Set([...marked, ...(await this.db.select({ id: lemmas.id }).from(lemmas).where(eq(lemmas.status, "recheck"))).map((r) => r.id)]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of checked) {
        if (!pending.has(l.id) && l.proofImports.some((d) => pending.has(d))) {
          pending.add(l.id);
          marked.push(l.id);
          grew = true;
        }
      }
    }
    if (marked.length) {
      await this.db.transaction(async (tx) => {
        await tx.update(lemmas).set({ status: "recheck" }).where(inArray(lemmas.id, marked));
        for (const id of marked) await emit(tx, "marked_for_recheck", { lemmaId: id, payload: { previousFingerprint: checked.find((c) => c.id === id)?.checkedFingerprint } });
      });
    }
    return marked;
  }

  /** Re-judge lemmas marked for re-check with their pinned source, dependencies first. */
  async runRechecks(): Promise<{ passed: string[]; failed: string[] }> {
    const passed: string[] = [];
    const failed: string[] = [];
    for (;;) {
      const pending = await this.db.select().from(lemmas).where(eq(lemmas.status, "recheck")).orderBy(asc(lemmas.id));
      if (!pending.length) break;
      const statusOf = async (id: string) => (await this.db.select({ s: lemmas.status }).from(lemmas).where(eq(lemmas.id, id)))[0]?.s;
      let progressed = false;
      for (const l of pending) {
        const depStatuses = await Promise.all(l.proofImports.map(statusOf));
        if (depStatuses.some((s) => s === "recheck")) continue; // wait for dependencies
        progressed = true;
        let verdict: JudgeVerdict | null = null;
        let reason = "";
        if (depStatuses.some((s) => s !== "checked")) {
          reason = "a proof it imports is no longer checked";
        } else {
          try {
            verdict = (await this.runJudge(l.id, l.checkedSource ?? "")).verdict;
            if (verdict.verdict !== "pass") reason = verdict.reasons.map((r) => r.code).join(", ");
          } catch (err) {
            if (err instanceof DeskError && err.status === 400) reason = err.message;
            else throw err;
          }
        }
        if (verdict?.verdict === "pass") {
          const fp = await this.fingerprint(l.id, l.proofImports);
          await this.db.transaction(async (tx) => {
            await tx
              .update(lemmas)
              .set({ status: "checked", checkedFingerprint: fp, checkedCommit: this.repo.gitCommit(this.config.GIT_COMMIT), checkedVerdict: verdict })
              .where(eq(lemmas.id, l.id));
            await emit(tx, "recheck_passed", { lemmaId: l.id });
          });
          passed.push(l.id);
        } else {
          await this.db.transaction(async (tx) => {
            await tx
              .update(lemmas)
              .set({ status: "open", checkedAt: null, checkedByAgent: null, checkedSource: null, checkedSourceSha256: null, checkedCommit: null, checkedFingerprint: null, checkedProofPath: null, proofImports: [], checkedVerdict: null })
              .where(eq(lemmas.id, l.id));
            await emit(tx, "recheck_failed", {
              lemmaId: l.id,
              payload: { reason, previousSource: l.checkedSource, previousSourceSha256: l.checkedSourceSha256, previousCommit: l.checkedCommit, previousAgent: l.checkedByAgent },
            });
          });
          failed.push(l.id);
        }
      }
      if (!progressed) break;
    }
    return { passed, failed };
  }
}

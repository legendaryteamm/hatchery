/**
 * Desk core: leases, attempts, spend, budget, collaboration, submissions and re-checks.
 * Every state change writes exactly one `events` row (per affected entity) in the same transaction.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  costMicroUsd,
  lemmaIdToLeanName,
  MESSAGE_LIMITS,
  microsToUsd,
  petIdentity,
  priceTable,
  PRICES_AS_OF,
  type EventType,
  type JudgeVerdict,
  type ProofDep,
  type SleepReason,
  type TokenUsage,
} from "@hatchery/shared";
import { budgetStatus, type BudgetStatus } from "./budget.ts";
import type { DeskConfig } from "./config.ts";
import type { Db, Tx } from "./db/client.ts";
import { agents, attempts, events, leases, lemmas, messages, modelCalls, programs, reuses, settings, statements } from "./db/schema.ts";
import type { JudgeClient, JudgeInfo } from "./judge-client.ts";
import { sha256, type LeanRepo } from "./lean-repo.ts";
import { ProofCommitter } from "./proof-committer.ts";

export class DeskError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) {
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

export interface ReplyForAgent {
  id: number;
  fromAgent: string;
  fromName: string;
  kind: string;
  body: string;
  questionId: number | null;
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
  /** Handoff note from the previous agent (approaches, errors, best partial proof), if any. */
  handoffNote: string | null;
  /** True when this lemma was offered to this agent through a handoff. */
  offeredToMe: boolean;
}

export interface UsagePart extends TokenUsage {
  model: string;
  servedByFallback?: boolean;
}

export interface ColonyState {
  agents: { id: string; name: string; program: string | null; lemmaId: string | null; status: "working" | "idle" | "sleeping" }[];
  recentlyChecked: { id: string; agentId: string | null; at: string | null }[];
}

const PROOF_IMPORT_RE = /^[ \t]*import[ \t]+Proofs\.(L_[A-Za-z0-9_]+)\s*$/gm;
const SEEN_THROTTLE_MS = 5000;

function words(s: string): Set<string> {
  return new Set(s.match(/[A-Za-z_][A-Za-z0-9_.']*/g) ?? []);
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
}
async function countRows(db: DbOrTx, q: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ n: number }>(q);
  return Number(rows[0]?.n ?? 0);
}

export class Desk {
  private judgeInfoCache: { info: JudgeInfo; at: number } | null = null;
  private seen = new Map<string, number>();
  readonly committer: ProofCommitter;

  constructor(
    readonly db: Db,
    readonly judge: JudgeClient,
    readonly repo: LeanRepo,
    readonly config: DeskConfig,
    readonly now: () => Date = () => new Date(),
  ) {
    this.committer = new ProofCommitter(repo.dir, {
      mode: config.PROOF_COMMIT_MODE,
      authorName: config.PROOF_COMMIT_AUTHOR_NAME,
      authorEmail: config.PROOF_COMMIT_AUTHOR_EMAIL,
    });
  }

  // ================================================================ judge freshness / gates

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

  // ================================================================ budget and kill switch

  /** Record that an agent is alive (it then counts as active for the per-agent cap). */
  async touch(agentId: string): Promise<void> {
    const t = this.now().getTime();
    if ((this.seen.get(agentId) ?? -Infinity) > t - SEEN_THROTTLE_MS) return;
    this.seen.set(agentId, t);
    await this.db.update(agents).set({ lastSeenAt: this.now() }).where(eq(agents.id, agentId));
  }

  budget(agentId: string | null): Promise<BudgetStatus> {
    return budgetStatus(this.db, this.config, agentId, this.now());
  }

  async setKillSwitch(on: boolean, by: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(settings)
        .values({ key: "kill_switch", value: { on }, updatedBy: by, updatedAt: this.now() })
        .onConflictDoUpdate({ target: settings.key, set: { value: { on }, updatedBy: by, updatedAt: this.now() } });
      await emit(tx, "kill_switch", { payload: { on, by } });
    });
  }

  /** Worker reports it went to sleep. One event per transition (repeats are ignored). */
  async reportSleeping(agentId: string, reason: SleepReason): Promise<boolean> {
    const [last] = await this.db
      .select()
      .from(events)
      .where(and(eq(events.agentId, agentId), inArray(events.type, ["sleeping", "leased", "model_call", "agent_registered"])))
      .orderBy(desc(events.id))
      .limit(1);
    if (last?.type === "sleeping" && (last.payload as { reason?: string }).reason === reason) return false;
    const b = await this.budget(agentId);
    await emit(this.db, "sleeping", {
      agentId,
      payload: { reason, agentSpentUsd: b.agentSpentUsd, perAgentCapUsd: b.perAgentCapUsd, globalSpentUsd: b.globalSpentUsd, globalCapUsd: b.globalCapUsd },
    });
    return true;
  }

  // ================================================================ statements

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

  // ================================================================ agents

  async registerAgent(id: string, model: string, kind: "internal" | "external" = "internal") {
    const pet = petIdentity(id);
    const [row] = await this.db
      .insert(agents)
      .values({ id, model, kind, displayName: pet.displayName, species: pet.species, shellColor: pet.shellColor, lastSeenAt: this.now() })
      .onConflictDoNothing()
      .returning();
    this.seen.set(id, this.now().getTime());
    if (row) {
      await emit(this.db, "agent_registered", { agentId: id, payload: { model, kind } });
      return row;
    }
    await this.db.update(agents).set({ model, lastSeenAt: this.now() }).where(eq(agents.id, id));
    const [existing] = await this.db.select().from(agents).where(eq(agents.id, id));
    return existing!;
  }

  // ================================================================ leases

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
    const b = await this.budget(agentId);
    if (!b.allowed) throw new DeskError(429, `not allowed to work now: ${b.reason}`, b.reason ?? undefined);
    await this.expireLeases();
    const mathlib = await this.mathlibAllowed();
    const max = this.config.AGENT_MAX_ATTEMPTS_PER_LEMMA;
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.config.LEASE_TTL_SECONDS * 1000);
    const leased = await this.db.transaction(async (tx) => {
      const held = await tx.select().from(leases).where(eq(leases.holder, agentId));
      if (held.length) throw new DeskError(409, `agent already holds a lease on ${held[0]!.lemmaId}`);
      const rows = await tx.execute<{ id: string; offered: boolean }>(sql`
        select l.id, coalesce(l.offered_to = ${agentId} and l.offered_until > ${nowIso}::timestamptz, false) as offered
        from lemmas l
        join statements s on s.id = l.id
        join programs p on p.id = s.program_id
        where l.status = 'open' and s.status = 'approved' and p.status = 'active'
          and (${mathlib} or not s.requires_mathlib)
          and (${programSlug ?? null}::text is null or p.slug = ${programSlug ?? null})
          and not (l.offered_to is not null and l.offered_to <> ${agentId} and l.offered_until > ${nowIso}::timestamptz)
          and not exists (select 1 from events e where e.type = 'abandoned_by_agent' and e.agent_id = ${agentId} and e.lemma_id = l.id)
          and (select count(*) from attempts a where a.lemma_id = l.id and a.agent_id = ${agentId} and a.result = 'failed') < ${max}
        order by offered desc, (select count(*) from attempts a where a.lemma_id = l.id) asc, l.id asc
        limit 1
        for update of l skip locked`);
      const row = rows[0];
      if (!row) return null;
      await tx.update(lemmas).set({ status: "leased", offeredTo: null, offeredUntil: null }).where(eq(lemmas.id, row.id));
      await tx.insert(leases).values({ lemmaId: row.id, holder: agentId, expiresAt, lastHeartbeat: now });
      await emit(tx, "leased", { agentId, lemmaId: row.id, payload: { expiresAt: expiresAt.toISOString(), viaHandoff: row.offered } });
      return row;
    });
    return leased ? this.leaseContext(agentId, leased.id, expiresAt, leased.offered) : null;
  }

  async leaseContext(agentId: string, lemmaId: string, expiresAt: Date, offeredToMe = false): Promise<LeaseContext> {
    const [st] = await this.db
      .select({ s: statements, programSlug: programs.slug, handoffNote: lemmas.handoffNote })
      .from(statements)
      .innerJoin(programs, eq(programs.id, statements.programId))
      .innerJoin(lemmas, eq(lemmas.id, statements.id))
      .where(eq(statements.id, lemmaId));
    if (!st) throw new DeskError(404, `no statement ${lemmaId}`);
    const prev = await this.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.lemmaId, lemmaId), eq(attempts.result, "failed")))
      .orderBy(desc(attempts.id))
      .limit(8);
    const checked = await this.db
      .select({ id: statements.id, leanName: statements.leanName, leanStatement: statements.leanStatement })
      .from(lemmas)
      .innerJoin(statements, eq(statements.id, lemmas.id))
      .where(eq(lemmas.status, "checked"))
      .orderBy(asc(lemmas.id))
      .limit(50);
    const mine = await countRows(this.db, sql`select count(*)::int as n from attempts where lemma_id = ${lemmaId} and agent_id = ${agentId} and result = 'failed'`);
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
      myFailedAttempts: mine,
      maxAttemptsPerLemma: this.config.AGENT_MAX_ATTEMPTS_PER_LEMMA,
      handoffNote: st.handoffNote,
      offeredToMe,
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
    const expiresAt = new Date(now.getTime() + this.config.LEASE_TTL_SECONDS * 1000);
    await this.db.update(leases).set({ lastHeartbeat: now, expiresAt }).where(eq(leases.lemmaId, lemmaId));
    return { expiresAt: expiresAt.toISOString() };
  }

  /**
   * Give a lemma back. `abandon` = this agent gives up after its max attempts. With a handoff note,
   * the lemma is offered first to an idle teammate (same program) for HANDOFF_OFFER_SECONDS.
   */
  async release(
    agentId: string,
    lemmaId: string,
    notes: string,
    abandon: boolean,
    handoff?: { body: string; short: string; note: string },
  ): Promise<{ offeredTo: string | null }> {
    const teammate = abandon && handoff ? await this.pickHandoffTeammate(agentId, lemmaId) : null;
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await this.requireLease(tx, agentId, lemmaId);
      await tx.delete(leases).where(eq(leases.lemmaId, lemmaId));
      const n = await countRows(tx, sql`select count(*)::int as n from attempts where lemma_id = ${lemmaId} and result = 'failed'`);
      const globallyAbandoned = n >= this.config.LEMMA_ABANDON_AFTER_ATTEMPTS;
      await tx
        .update(lemmas)
        .set({
          status: globallyAbandoned ? "abandoned" : "open",
          ...(handoff ? { handoffNote: handoff.note.slice(0, 6000) } : {}),
          offeredTo: globallyAbandoned ? null : teammate,
          offeredUntil: teammate && !globallyAbandoned ? new Date(now.getTime() + this.config.HANDOFF_OFFER_SECONDS * 1000) : null,
        })
        .where(eq(lemmas.id, lemmaId));
      await emit(tx, abandon ? "abandoned_by_agent" : "released", {
        agentId,
        lemmaId,
        payload: { notes: notes.slice(0, 2000), failedAttemptsTotal: n, lemmaAbandoned: globallyAbandoned },
      });
      if (handoff) {
        const [m] = await tx
          .insert(messages)
          .values({
            fromAgent: agentId,
            toAgent: teammate,
            lemmaId,
            kind: "handoff",
            body: handoff.body.slice(0, MESSAGE_LIMITS.body),
            short: handoff.short.slice(0, MESSAGE_LIMITS.short),
            ts: now,
          })
          .returning();
        await emit(tx, "handoff", { agentId, lemmaId, payload: { messageId: m!.id, toAgent: teammate, short: m!.short } });
      }
    });
    return { offeredTo: teammate };
  }

  private async pickHandoffTeammate(agentId: string, lemmaId: string): Promise<string | null> {
    const program = await this.programOfLemma(lemmaId);
    for (const c of await this.liveAgents(agentId)) {
      if (c.leased || (c.program !== null && c.program !== program)) continue;
      const [gaveUp] = await this.db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.type, "abandoned_by_agent"), eq(events.agentId, c.id), eq(events.lemmaId, lemmaId)))
        .limit(1);
      if (gaveUp) continue;
      if (!(await this.budget(c.id)).allowed) continue;
      return c.id;
    }
    return null;
  }

  // ================================================================ attempts and spend

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

  /**
   * Record one model call from real token counts. A call has one part per model that served it
   * (a refusal fallback adds a part), each priced at its own model's rates. Cost is computed here.
   */
  async recordUsage(
    attemptId: number | null,
    agentId: string,
    call: { purpose: "prove" | "reply"; parts: UsagePart[]; requestId?: string },
    tx?: Tx,
  ): Promise<{ costUsd: string; costMicros: number; attemptCostUsd: string | null }> {
    if (!call.parts.length) throw new DeskError(400, "a model call needs at least one usage part");
    const table = priceTable();
    let micros: number[];
    try {
      micros = call.parts.map((p) => costMicroUsd(p.model, p, table));
    } catch (err) {
      throw new DeskError(400, (err as Error).message);
    }
    const total = micros.reduce((a, b) => a + b, 0);
    const sum = (k: keyof TokenUsage) => call.parts.reduce((a, p) => a + p[k], 0);
    const work = async (db: Tx) => {
      let lemmaId: string | null = null;
      if (attemptId !== null) {
        // The call already happened and was paid for: record it even if the attempt was closed
        // meanwhile (lease expired, kill switch), as long as the attempt belongs to this agent.
        const [a] = await db.select().from(attempts).where(eq(attempts.id, attemptId));
        if (!a || a.agentId !== agentId) throw new DeskError(404, `no attempt ${attemptId} for ${agentId}`);
        lemmaId = a.lemmaId;
        await db
          .update(attempts)
          .set({
            tokensIn: sql`${attempts.tokensIn} + ${sum("inputTokens")}`,
            tokensOut: sql`${attempts.tokensOut} + ${sum("outputTokens")}`,
            cacheReadTokens: sql`${attempts.cacheReadTokens} + ${sum("cacheReadTokens")}`,
            cacheWriteTokens: sql`${attempts.cacheWriteTokens} + ${sum("cacheWriteTokens")}`,
            costUsd: sql`${attempts.costUsd} + ${microsToUsd(total)}::numeric`,
            turns: sql`${attempts.turns} + 1`,
          })
          .where(eq(attempts.id, attemptId));
      }
      for (const [i, p] of call.parts.entries()) {
        await db.insert(modelCalls).values({
          agentId,
          attemptId,
          purpose: call.purpose,
          model: p.model,
          part: i,
          servedByFallback: p.servedByFallback ?? false,
          tokensIn: p.inputTokens,
          tokensOut: p.outputTokens,
          cacheReadTokens: p.cacheReadTokens,
          cacheWriteTokens: p.cacheWriteTokens,
          costUsd: microsToUsd(micros[i]!),
          priceAsOf: PRICES_AS_OF,
          requestId: call.requestId ?? null,
          ts: this.now(),
        });
      }
      await emit(db, "model_call", {
        agentId,
        lemmaId,
        payload: {
          attemptId,
          purpose: call.purpose,
          models: call.parts.map((p) => p.model),
          fallbackUsed: call.parts.some((p) => p.servedByFallback),
          tokensIn: sum("inputTokens"),
          tokensOut: sum("outputTokens"),
          costUsd: microsToUsd(total),
        },
      });
      const [a] = attemptId === null ? [] : await db.select({ c: attempts.costUsd }).from(attempts).where(eq(attempts.id, attemptId));
      return { costUsd: microsToUsd(total), costMicros: total, attemptCostUsd: a?.c ?? null };
    };
    return tx ? work(tx) : this.db.transaction(work);
  }

  /** Total model spend recorded for an agent since a time. */
  async spentSince(agentId: string, since: Date): Promise<string> {
    const [r] = await this.db.execute<{ s: string }>(
      sql`select coalesce(sum(cost_usd), 0)::numeric(14,6)::text as s from model_calls where agent_id = ${agentId} and ts >= ${since.toISOString()}::timestamptz`,
    );
    return r?.s ?? "0.000000";
  }

  // ================================================================ proofs and dependencies

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
    const verdict = await this.judge.check({ lemmaId, source, deps });
    // A runner failure (Docker hiccup, host suspend) says nothing about the proof: never record it
    // as the agent's failed attempt. The caller retries.
    if (verdict.verdict === "fail" && verdict.reasons.length && verdict.reasons.every((r) => r.code === "runner_error")) {
      throw new DeskError(503, `judge infrastructure error, retry: ${verdict.reasons[0]!.message.slice(0, 300)}`, "judge_unavailable");
    }
    return { verdict, direct };
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

  /** Official submission. Ends the attempt; on pass the lemma becomes "checked" and is committed to lean/Proofs/. */
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
    if (verdict.verdict !== "pass") {
      const errors = verdict.reasons.map((r) => `${r.code}: ${r.message}`).join("\n").slice(0, 4000);
      await this.endAttempt(attemptId, agentId, "failed", notes, errors, source);
      await emit(this.db, "judge_rejected", {
        agentId,
        lemmaId: a.lemmaId,
        payload: { attemptId, reasons: verdict.reasons.map((r) => r.code), stage: verdict.stage },
      });
      return verdict;
    }
    const leanName = lemmaIdToLeanName(a.lemmaId);
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
          checkedProofPath: `lean/Proofs/${leanName}.lean`,
          proofImports: direct,
          checkedVerdict: verdict,
          handoffNote: null,
          offeredTo: null,
          offeredUntil: null,
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
      for (const r of direct) {
        await tx.insert(reuses).values({ lemmaId: a.lemmaId, reusedLemmaId: r, agentId, ts: now });
        await emit(tx, "lemma_reused", { agentId, lemmaId: a.lemmaId, payload: { reused: r } });
      }
    });
    await this.commitProof(
      a.lemmaId,
      source,
      `proof: ${leanName} checked\n\nLemma: ${a.lemmaId}\nAgent: ${agentId}\nAttempt: ${attemptId}\nSource sha256: ${sha256(source)}\n` +
        `Checkers: judgecheck=${verdict.checkers.judgecheck}, leanchecker=${verdict.checkers.leanchecker}\nAxioms: ${verdict.axioms.join(", ") || "none"}`,
    );
    return verdict;
  }

  /** Write + commit the proof; the commit that adds it becomes the lemma's pinned commit. */
  private async commitProof(lemmaId: string, source: string, message: string): Promise<void> {
    try {
      const sha = await this.committer.publish(lemmaIdToLeanName(lemmaId), source, message);
      if (sha) {
        await this.db.transaction(async (tx) => {
          await tx.update(lemmas).set({ checkedCommit: sha }).where(eq(lemmas.id, lemmaId));
          await emit(tx, "proof_committed", { lemmaId, payload: { commit: sha, path: `lean/Proofs/${lemmaIdToLeanName(lemmaId)}.lean` } });
        });
      }
    } catch (err) {
      // The DB already says "checked"; reconcileProofs() at the next start repairs the file.
      console.error(`commit of ${lemmaId} failed: ${(err as Error).message}`);
    }
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

  /** Make lean/Proofs/ match the DB (after a crash between the DB update and the commit). */
  async reconcileProofs(): Promise<{ written: string[]; removed: string[] }> {
    const rows = await this.db.select().from(lemmas).where(inArray(lemmas.status, ["checked", "recheck"]));
    return this.committer.reconcile(new Map(rows.filter((l) => l.checkedSource).map((l) => [lemmaIdToLeanName(l.id), l.checkedSource!])));
  }

  // ================================================================ collaboration (section 6b)

  private async programOfLemma(lemmaId: string): Promise<string | null> {
    const [r] = await this.db
      .select({ slug: programs.slug })
      .from(statements)
      .innerJoin(programs, eq(programs.id, statements.programId))
      .where(eq(statements.id, lemmaId));
    return r?.slug ?? null;
  }

  /** Internal agents seen recently (except `exclude`), with their camp (program of their latest lease). */
  private async liveAgents(exclude: string): Promise<{ id: string; program: string | null; leased: boolean }[]> {
    const since = new Date(this.now().getTime() - this.config.ACTIVE_AGENT_WINDOW_SECONDS * 1000).toISOString();
    const rows = await this.db.execute<{ id: string; program: string | null; leased: boolean }>(sql`
      select a.id,
        (select p.slug from events e join statements s on s.id = e.lemma_id join programs p on p.id = s.program_id
          where e.type = 'leased' and e.agent_id = a.id order by e.id desc limit 1) as program,
        exists (select 1 from leases l where l.holder = a.id) as leased
      from agents a
      where a.kind = 'internal' and a.id <> ${exclude} and a.last_seen_at >= ${since}::timestamptz
      order by a.id`);
    return [...rows];
  }

  /** Failed checks/submissions in a row by this agent on this lemma, during its current lease. */
  async consecutiveFailures(agentId: string, lemmaId: string): Promise<number> {
    const rows = await this.db.execute<{ type: string; ok: boolean | null }>(sql`
      select type, (payload->>'ok')::boolean as ok from events
      where agent_id = ${agentId} and lemma_id = ${lemmaId}
        and type in ('local_check', 'judge_rejected', 'checked')
        and id > coalesce((select max(id) from events where type = 'leased' and agent_id = ${agentId} and lemma_id = ${lemmaId}), 0)
      order by id desc`);
    let n = 0;
    for (const r of rows) {
      if (r.type === "judge_rejected" || (r.type === "local_check" && r.ok === false)) n++;
      else break;
    }
    return n;
  }

  /**
   * Ask teammates (one question per lease, after ASK_AFTER_CONSECUTIVE_FAILURES failures in a row).
   * Routed to up to 2 live agents: first same-program agents who checked a related lemma, then any
   * agent of the same program (idle ones first).
   */
  async ask(agentId: string, attemptId: number, body: string, short: string): Promise<{ questionId: number; routedTo: string[] }> {
    const a = await this.openAttempt(this.db, attemptId, agentId);
    await this.requireLease(this.db, agentId, a.lemmaId);
    const b = await this.budget(agentId);
    if (b.killSwitch.on) throw new DeskError(429, "kill switch is on", "kill_switch");
    const need = this.config.ASK_AFTER_CONSECUTIVE_FAILURES;
    const fails = await this.consecutiveFailures(agentId, a.lemmaId);
    if (fails < need) throw new DeskError(400, `questions are allowed after ${need} failed checks in a row (you have ${fails})`);
    const now = this.now();
    const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
    const lastHour = await countRows(this.db, sql`select count(*)::int as n from messages where from_agent = ${agentId} and kind = 'question' and ts >= ${hourAgo}::timestamptz`);
    if (lastHour >= this.config.MAX_QUESTIONS_PER_HOUR) throw new DeskError(429, `question limit reached (${this.config.MAX_QUESTIONS_PER_HOUR} per hour)`);
    const already = await countRows(this.db, sql`
      select count(*)::int as n from messages m where m.from_agent = ${agentId} and m.lemma_id = ${a.lemmaId} and m.kind = 'question'
        and m.ts >= (select max(ts) from events where type = 'leased' and agent_id = ${agentId} and lemma_id = ${a.lemmaId})`);
    if (already) throw new DeskError(400, "you already asked a question during this lease");

    const routedTo = await this.routeQuestion(agentId, a.lemmaId);
    return this.db.transaction(async (tx) => {
      const [m] = await tx
        .insert(messages)
        .values({
          fromAgent: agentId,
          toAgent: null,
          lemmaId: a.lemmaId,
          kind: "question",
          body: body.slice(0, MESSAGE_LIMITS.body),
          short: short.slice(0, MESSAGE_LIMITS.short),
          routedTo,
          ts: now,
          expiresAt: new Date(now.getTime() + this.config.QUESTION_TTL_SECONDS * 1000),
        })
        .returning();
      await emit(tx, "question_asked", { agentId, lemmaId: a.lemmaId, payload: { messageId: m!.id, routedTo, short: m!.short, attemptId } });
      return { questionId: m!.id, routedTo };
    });
  }

  async routeQuestion(askerId: string, lemmaId: string): Promise<string[]> {
    const program = await this.programOfLemma(lemmaId);
    const [target] = await this.db.select().from(statements).where(eq(statements.id, lemmaId));
    const targetWords = words(target?.leanStatement ?? "");
    const hourAgo = new Date(this.now().getTime() - 3600_000).toISOString();
    const eligible: { id: string; program: string | null; leased: boolean }[] = [];
    for (const c of await this.liveAgents(askerId)) {
      const n = await countRows(this.db, sql`select count(*)::int as n from messages where from_agent = ${c.id} and kind in ('reply', 'hint') and ts >= ${hourAgo}::timestamptz`);
      if (n >= this.config.MAX_REPLIES_PER_HOUR) continue;
      if (!(await this.budget(c.id)).allowed) continue;
      eligible.push(c);
    }
    // Tier 1: checked a related lemma in the same program.
    const related = new Set<string>();
    const checkedRows = await this.db
      .select({ id: lemmas.id, by: lemmas.checkedByAgent, deps: statements.dependsOn, imports: lemmas.proofImports, text: statements.leanStatement, program: programs.slug })
      .from(lemmas)
      .innerJoin(statements, eq(statements.id, lemmas.id))
      .innerJoin(programs, eq(programs.id, statements.programId))
      .where(eq(lemmas.status, "checked"));
    for (const r of checkedRows) {
      if (!r.by || r.program !== program) continue;
      const shared =
        r.deps.some((d) => target?.dependsOn.includes(d)) ||
        (target?.dependsOn ?? []).includes(r.id) ||
        r.deps.includes(lemmaId) ||
        r.imports.some((d) => target?.dependsOn.includes(d)) ||
        jaccard(words(r.text), targetWords) >= 0.3;
      if (shared) related.add(r.by);
    }
    const tier1 = eligible.filter((c) => related.has(c.id));
    const tier2 = eligible.filter((c) => !related.has(c.id) && c.program === program).sort((x, y) => Number(x.leased) - Number(y.leased));
    return [...tier1, ...tier2].slice(0, 2).map((c) => c.id);
  }

  /** Open questions routed to this agent that it has not answered yet. */
  async inbox(agentId: string) {
    const nowIso = this.now().toISOString();
    const rows = await this.db.execute<{ id: number; from_agent: string; lemma_id: string; body: string; lean_statement: string; lean_name: string }>(sql`
      select m.id, m.from_agent, m.lemma_id, m.body, s.lean_statement, s.lean_name
      from messages m join statements s on s.id = m.lemma_id
      where m.kind = 'question' and ${agentId} = any(m.routed_to) and m.expires_at > ${nowIso}::timestamptz
        and not exists (select 1 from messages r where r.reply_to = m.id and r.from_agent = ${agentId})
      order by m.id`);
    const myChecked = await this.db
      .select({ id: lemmas.id, source: lemmas.checkedSource })
      .from(lemmas)
      .where(and(eq(lemmas.status, "checked"), eq(lemmas.checkedByAgent, agentId)))
      .limit(5);
    return rows.map((r) => ({
      questionId: r.id,
      fromAgent: r.from_agent,
      fromName: petIdentity(r.from_agent).displayName,
      lemmaId: r.lemma_id,
      leanName: r.lean_name,
      leanStatement: r.lean_statement,
      question: r.body,
      myCheckedProofs: myChecked.map((c) => ({ lemmaId: c.id, source: c.source ?? "" })),
    }));
  }

  /** Post a reply/hint to a routed question, recording the reply call's cost on the message. */
  async reply(
    agentId: string,
    questionId: number,
    r: { kind: "reply" | "hint"; body: string; short: string; parts: UsagePart[]; requestId?: string },
  ): Promise<{ messageId: number; costUsd: string }> {
    const [q] = await this.db.select().from(messages).where(eq(messages.id, questionId));
    if (!q || q.kind !== "question" || !q.routedTo.includes(agentId)) throw new DeskError(404, "no such question routed to you");
    const now = this.now();
    const [dup] = await this.db.select({ id: messages.id }).from(messages).where(and(eq(messages.replyTo, questionId), eq(messages.fromAgent, agentId)));
    if (dup) throw new DeskError(409, "already replied");
    if (q.expiresAt && q.expiresAt < now) {
      // The reply call already happened: its spend is recorded even though the reply arrives too late.
      await this.recordUsage(null, agentId, { purpose: "reply", parts: r.parts, requestId: r.requestId });
      throw new DeskError(410, "question expired");
    }
    return this.db.transaction(async (tx) => {
      const cost = await this.recordUsage(null, agentId, { purpose: "reply", parts: r.parts, requestId: r.requestId }, tx);
      const [m] = await tx
        .insert(messages)
        .values({
          fromAgent: agentId,
          toAgent: q.fromAgent,
          lemmaId: q.lemmaId,
          kind: r.kind,
          body: r.body.slice(0, MESSAGE_LIMITS.body),
          short: r.short.slice(0, MESSAGE_LIMITS.short),
          costUsd: cost.costUsd,
          replyTo: questionId,
          ts: now,
        })
        .returning();
      await emit(tx, "reply_posted", { agentId, lemmaId: q.lemmaId, payload: { messageId: m!.id, questionId, toAgent: q.fromAgent, short: m!.short, costUsd: cost.costUsd } });
      return { messageId: m!.id, costUsd: cost.costUsd };
    });
  }

  /** May this agent make a reply call now (rate limit + budget)? Checked by the worker before the call. */
  async canReply(agentId: string): Promise<{ ok: boolean; reason?: string }> {
    const hourAgo = new Date(this.now().getTime() - 3600_000).toISOString();
    const n = await countRows(this.db, sql`select count(*)::int as n from messages where from_agent = ${agentId} and kind in ('reply', 'hint') and ts >= ${hourAgo}::timestamptz`);
    if (n >= this.config.MAX_REPLIES_PER_HOUR) return { ok: false, reason: "reply_limit" };
    const b = await this.budget(agentId);
    return b.allowed ? { ok: true } : { ok: false, reason: b.reason ?? "budget" };
  }

  /** Replies/hints for this agent on this lemma not yet delivered; marks them delivered into `attemptId`. */
  async takeReplies(agentId: string, lemmaId: string, attemptId: number | null): Promise<ReplyForAgent[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.toAgent, agentId), eq(messages.lemmaId, lemmaId), inArray(messages.kind, ["reply", "hint"]), isNull(messages.deliveredAt)))
        .orderBy(asc(messages.id))
        .for("update", { skipLocked: true });
      for (const m of rows) {
        await tx.update(messages).set({ deliveredAt: this.now(), deliveredInAttempt: attemptId }).where(eq(messages.id, m.id));
        await emit(tx, "reply_delivered", { agentId, lemmaId, payload: { messageId: m.id, questionId: m.replyTo, attemptId, fromAgent: m.fromAgent } });
      }
      return rows.map((m) => ({ id: m.id, fromAgent: m.fromAgent, fromName: petIdentity(m.fromAgent).displayName, kind: m.kind, body: m.body, questionId: m.replyTo }));
    });
  }

  /** Does this agent have an unexpired, routed question on this lemma that no one has answered yet? */
  async awaitingReply(agentId: string, lemmaId: string): Promise<boolean> {
    const nowIso = this.now().toISOString();
    const n = await countRows(this.db, sql`
      select count(*)::int as n from messages m
      where m.from_agent = ${agentId} and m.lemma_id = ${lemmaId} and m.kind = 'question'
        and cardinality(m.routed_to) > 0 and m.expires_at > ${nowIso}::timestamptz
        and not exists (select 1 from messages r where r.reply_to = m.id)`);
    return n > 0;
  }

  /** Keyword search over checked lemmas (reuse, section 6b). */
  async searchChecked(q: string) {
    const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 2).slice(0, 8);
    const rows = await this.db
      .select({ id: lemmas.id, leanName: statements.leanName, title: statements.title, leanStatement: statements.leanStatement })
      .from(lemmas)
      .innerJoin(statements, eq(statements.id, lemmas.id))
      .where(eq(lemmas.status, "checked"))
      .orderBy(asc(lemmas.id));
    return rows
      .map((r) => {
        const hay = `${r.id} ${r.leanName} ${r.title} ${r.leanStatement}`.toLowerCase();
        return { ...r, score: terms.filter((t) => hay.includes(t)).length };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ score: _s, ...r }) => ({ ...r, importAs: `Proofs.${r.leanName}`, theorem: `Proof.${r.leanName}` }));
  }

  /** Who works on what, for the agents' system prompt and the site. */
  async colony(): Promise<ColonyState> {
    const since = new Date(this.now().getTime() - this.config.ACTIVE_AGENT_WINDOW_SECONDS * 1000);
    const live = await this.db.select().from(agents).where(and(eq(agents.kind, "internal"), gte(agents.lastSeenAt, since))).orderBy(asc(agents.id));
    const held = await this.db.select().from(leases);
    const result: ColonyState["agents"] = [];
    for (const a of live) {
      const lease = held.find((l) => l.holder === a.id);
      const [last] = await this.db
        .select({ type: events.type })
        .from(events)
        .where(and(eq(events.agentId, a.id), inArray(events.type, ["sleeping", "leased", "model_call"])))
        .orderBy(desc(events.id))
        .limit(1);
      result.push({
        id: a.id,
        name: a.displayName,
        program: lease ? await this.programOfLemma(lease.lemmaId) : null,
        lemmaId: lease?.lemmaId ?? null,
        status: last?.type === "sleeping" ? "sleeping" : lease ? "working" : "idle",
      });
    }
    const recent = await this.db.select().from(lemmas).where(eq(lemmas.status, "checked")).orderBy(desc(lemmas.checkedAt)).limit(5);
    return { agents: result, recentlyChecked: recent.map((l) => ({ id: l.id, agentId: l.checkedByAgent, at: l.checkedAt?.toISOString() ?? null })) };
  }

  // ================================================================ re-checks

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
            await tx.update(lemmas).set({ status: "checked", checkedFingerprint: fp, checkedVerdict: verdict }).where(eq(lemmas.id, l.id));
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
          try {
            const sha = await this.committer.withdraw(lemmaIdToLeanName(l.id), `proof: remove ${lemmaIdToLeanName(l.id)} (re-check failed: ${reason.slice(0, 200)})`);
            if (sha) await emit(this.db, "proof_committed", { lemmaId: l.id, payload: { commit: sha, removed: true } });
          } catch (err) {
            console.error(`withdraw of ${l.id} failed: ${(err as Error).message}`);
          }
          failed.push(l.id);
        }
      }
      if (!progressed) break;
    }
    return { passed, failed };
  }
}

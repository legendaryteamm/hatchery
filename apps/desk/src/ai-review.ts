/**
 * Autonomous review: there is no human math advisor (docs/autonomous-review.md).
 *
 * A DEFINITION module is approved for its exact source only when ALL of these hold:
 *   1. reviewers  - at least DEFINITION_REVIEWERS_REQUIRED independent reviewer agents (different
 *                   models when available) compared it with the standard textbook definition, checked
 *                   that Mathlib has no definition it should reuse instead, and ALL agreed;
 *   2. sanity     - every sanity lemma for it (known basic facts, lean/Statements "sanity_for") is
 *                   checked by the Lean judge; a refuted or abandoned sanity lemma rejects it;
 *   3. adversary  - an adversary agent, with a small budget, failed to prove False (or the module's
 *                   "adversary:" goals, e.g. P = NP, P ≠ NP) from it. One passing proof rejects it.
 *                   The adversary's proofs are judged by the desk's own judge;
 *   4. imports    - every definition it imports is approved.
 * A STATEMENT is approved when it elaborates, is not trivial and not a duplicate (the automatic
 * check), every definition it uses is approved, and STATEMENT_REVIEWERS_REQUIRED reviewer agents
 * confirm it is meaningful for its program.
 *
 * The desk decides; agents only report. Every step, with the reviewers' reasoning, is stored in
 * review_steps and shown on the site. Admins can revert or block anything; anyone can flag a
 * definition or statement through a GitHub issue, which sends it back to review.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { lemmaIdToLeanName, StatementCheckResultSchema, type JudgeVerdict } from "@hatchery/shared";
import { contributors, definitions, lemmas, reviewFlags, reviewRounds, reviewSteps, statements } from "./db/schema.ts";
import type { Review } from "./review.ts";
import { DeskError, emit, type Desk, type UsagePart } from "./service.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type TargetKind = "definition" | "statement";
export type Round = typeof reviewRounds.$inferSelect;
export type Step = typeof reviewSteps.$inferSelect;

/** Shown wherever a definition or statement appears on the site. */
export const AI_REVIEW_LABEL = "Reviewed by AI agents, not by a human mathematician.";

export type ReviewTask =
  | { kind: "definition"; roundId: number; definition: { id: string; title: string; summary: string; source: string; imports: { id: string; source: string }[]; requiresMathlib: boolean }; flags: string[] }
  | { kind: "statement"; roundId: number; statement: { id: string; title: string; leanStatement: string; source: string; rationale: string; program: { slug: string; title: string; description: string }; definitions: { id: string; summary: string }[] }; flags: string[] }
  | { kind: "adversary"; roundId: number; definition: { id: string; source: string; imports: { id: string; source: string }[] }; goals: { index: number; lemmaId: string; goal: string }[]; budgetUsd: number; spentUsd: string; minChecks: number; checks: number };

export interface VerdictInput {
  agentId: string;
  model: string;
  agree: boolean;
  summary: string;
  reasoning: string;
  details: Record<string, unknown>;
  parts: UsagePart[];
  requestId?: string;
}

export class AiReview {
  constructor(
    private desk: Desk,
    private review: Review,
  ) {}

  private get db() {
    return this.desk.db;
  }
  private get cfg() {
    return this.desk.config;
  }

  // ================================================================ rounds

  private async target(kind: TargetKind, id: string): Promise<{ sha: string } | null> {
    if (kind === "definition") {
      const [d] = await this.db.select().from(definitions).where(eq(definitions.id, id));
      return d && !d.removed ? { sha: d.sourceSha256 } : null;
    }
    const [s] = await this.db.select().from(statements).where(eq(statements.id, id));
    return s ? { sha: s.fileSha256 } : null;
  }

  async rounds(kind: TargetKind, id: string): Promise<Round[]> {
    return this.db.select().from(reviewRounds).where(and(eq(reviewRounds.targetKind, kind), eq(reviewRounds.targetId, id))).orderBy(desc(reviewRounds.id));
  }

  async steps(roundId: number): Promise<Step[]> {
    return this.db.select().from(reviewSteps).where(eq(reviewSteps.roundId, roundId)).orderBy(asc(reviewSteps.id));
  }

  private async addStep(roundId: number, s: { kind: string; actor: string; model?: string | null; verdict: "pass" | "fail" | "info"; summary: string; reasoning?: string; details?: Record<string, unknown>; costUsd?: string }) {
    const [row] = await this.db
      .insert(reviewSteps)
      .values({ roundId, kind: s.kind, actor: s.actor, model: s.model ?? null, verdict: s.verdict, summary: clip(s.summary, 500), reasoning: clip(s.reasoning ?? "", 8000), details: s.details ?? {}, costUsd: s.costUsd ?? "0", ts: this.desk.now() })
      .returning();
    return row!;
  }

  /** Start a new round for the target's current source; any running round is superseded. */
  async startRound(kind: TargetKind, id: string, trigger: string, reason = ""): Promise<Round> {
    const t = await this.target(kind, id);
    if (!t) throw new DeskError(404, `no ${kind} ${id}`);
    const now = this.desk.now();
    const round = await this.db.transaction(async (tx) => {
      await tx
        .update(reviewRounds)
        .set({ status: "superseded", finishedAt: now, reason: `superseded by a new review (${trigger})` })
        .where(and(eq(reviewRounds.targetKind, kind), eq(reviewRounds.targetId, id), eq(reviewRounds.status, "running")));
      const [r] = await tx.insert(reviewRounds).values({ targetKind: kind, targetId: id, targetSha256: t.sha, trigger, reason: clip(reason, 2000), startedAt: now }).returning();
      await emit(tx, "review_started", { lemmaId: kind === "statement" ? id : null, payload: { kind, target: id, roundId: r!.id, trigger } });
      return r!;
    });
    if (kind === "statement") {
      // The automatic filter already ran (elaborates, not trivial, not a duplicate): record it.
      const [s] = await this.db.select().from(statements).where(eq(statements.id, id));
      const check = s?.check ? StatementCheckResultSchema.safeParse(s.check) : null;
      if (check?.success) {
        await this.addStep(round.id, {
          kind: "filter", actor: "desk", verdict: "pass",
          summary: "Elaborates in Lean, is not closed by an automatic tactic, and is not a duplicate.",
          details: { trivialBy: check.data.trivialBy, elaborates: check.data.elaborates },
        });
      }
    }
    return round;
  }

  /**
   * Everything waiting for review gets a round: a definition in draft, a proposed statement that
   * passed the automatic check. Covers new and changed sources, and statements sent back because a
   * definition they use went back to review.
   */
  async ensureRounds(): Promise<number[]> {
    const started: number[] = [];
    const trigger = async (kind: TargetKind, id: string, sha: string) => {
      const [last] = await this.db.select().from(reviewRounds).where(and(eq(reviewRounds.targetKind, kind), eq(reviewRounds.targetId, id))).orderBy(desc(reviewRounds.id)).limit(1);
      if (last?.status === "running") return null;
      return !last ? "new" : last.targetSha256 !== sha ? "changed" : "dependency";
    };
    for (const d of await this.db.select().from(definitions).where(and(eq(definitions.removed, false), eq(definitions.status, "draft")))) {
      const t = await trigger("definition", d.id, d.sourceSha256);
      if (t) started.push((await this.startRound("definition", d.id, t)).id);
    }
    for (const s of await this.db.select().from(statements).where(eq(statements.status, "proposed"))) {
      if (s.blockedAt || !s.check) continue; // the automatic check runs first (it may auto-reject)
      const t = await trigger("statement", s.id, s.fileSha256);
      if (t) started.push((await this.startRound("statement", s.id, t, t === "dependency" ? "a definition it uses went back to review" : "")).id);
    }
    return started;
  }

  // ================================================================ sanity

  async sanityState(defId: string): Promise<{ status: "pass" | "fail" | "pending"; lemmas: { id: string; title: string; status: string }[]; reason: string }> {
    const rows = await this.db
      .select({ id: statements.id, title: statements.title, status: lemmas.status })
      .from(statements)
      .innerJoin(lemmas, eq(lemmas.id, statements.id))
      .where(and(sql`${defId} = any(${statements.sanityFor})`, eq(statements.status, "approved")))
      .orderBy(asc(statements.id));
    const list = rows.map((r) => ({ id: r.id, title: r.title, status: r.status }));
    if (!list.length) return { status: "fail", lemmas: list, reason: `${defId} has no sanity lemmas (known basic facts) to prove` };
    const bad = list.filter((l) => l.status === "refuted" || l.status === "abandoned");
    if (bad.length) {
      return { status: "fail", lemmas: list, reason: `sanity lemma ${bad.map((b) => `${b.id} (${b.title}) was ${b.status === "refuted" ? "refuted" : "not proved within its attempt budget"}`).join(", ")}` };
    }
    if (list.every((l) => l.status === "checked")) return { status: "pass", lemmas: list, reason: `all ${list.length} sanity lemmas are proved` };
    return { status: "pending", lemmas: list, reason: `${list.filter((l) => l.status !== "checked").length} of ${list.length} sanity lemmas still to prove` };
  }

  // ================================================================ work for reviewer agents

  /** The next thing this reviewer agent should do, or null. */
  async nextTask(agentId: string, model: string): Promise<ReviewTask | null> {
    const running = await this.db.select().from(reviewRounds).where(eq(reviewRounds.status, "running")).orderBy(asc(reviewRounds.id));
    const info = await this.desk.judgeInfo().catch(() => null);
    const mathlibOk = info?.flavor === "full" && (await this.desk.mathlibAllowed().catch(() => false));
    const states = await this.desk.definitionStates();
    for (const r of running) {
      const steps = await this.steps(r.id);
      const reviewers = steps.filter((s) => s.kind === "reviewer");
      const required = r.targetKind === "definition" ? this.cfg.DEFINITION_REVIEWERS_REQUIRED : this.cfg.STATEMENT_REVIEWERS_REQUIRED;
      const mine = reviewers.some((s) => s.actor === agentId);
      const modelUsed = reviewers.some((s) => s.model === model);
      const flags = steps.filter((s) => s.kind === "flag").map((s) => s.reasoning);
      if (r.targetKind === "definition") {
        const [d] = await this.db.select().from(definitions).where(eq(definitions.id, r.targetId));
        if (!d) continue;
        const imports = await this.importSources(d.imports);
        if (!mine && reviewers.length < required && !(this.cfg.REVIEW_REQUIRE_DISTINCT_MODELS && modelUsed)) {
          return { kind: "definition", roundId: r.id, definition: { id: d.id, title: d.title, summary: d.summary, source: d.source, imports, requiresMathlib: d.requiresMathlib }, flags };
        }
        // The adversary goes after the reviewers agreed (no money spent on definitions already rejected).
        const agreed = reviewers.length >= required && reviewers.every((s) => s.verdict === "pass");
        const free = !r.adversaryAgent || r.adversaryAgent === agentId || !r.adversaryUntil || r.adversaryUntil < this.desk.now();
        if (agreed && !r.adversaryDone && free && (!d.requiresMathlib || mathlibOk)) {
          await this.db.update(reviewRounds).set({ adversaryAgent: agentId, adversaryUntil: new Date(this.desk.now().getTime() + this.cfg.ADVERSARY_LEASE_SECONDS * 1000) }).where(eq(reviewRounds.id, r.id));
          return {
            kind: "adversary", roundId: r.id, definition: { id: d.id, source: d.source, imports }, goals: this.goals(d),
            budgetUsd: this.cfg.ADVERSARY_BUDGET_USD, spentUsd: r.adversarySpentUsd, minChecks: this.cfg.ADVERSARY_MIN_CHECKS, checks: r.adversaryChecks,
          };
        }
      } else if (!mine && reviewers.length < required) {
        const [row] = await this.db.execute<{ id: string; title: string; lean_statement: string; source: string; rationale: string; def_imports: string[]; slug: string; ptitle: string; pdesc: string }>(sql`
          select s.id, s.title, s.lean_statement, s.source, s.rationale, s.def_imports, p.slug, p.title as ptitle, p.description as pdesc
          from statements s join programs p on p.id = s.program_id where s.id = ${r.targetId}`);
        if (!row) continue;
        // Reviewing waits until the definitions it uses are approved (it could not be approved before).
        if (row.def_imports.some((d) => !states.get(d)?.effective)) continue;
        const defs = row.def_imports.length ? await this.db.select({ id: definitions.id, summary: definitions.summary }).from(definitions).where(inArray(definitions.id, row.def_imports)) : [];
        return {
          kind: "statement", roundId: r.id,
          statement: { id: row.id, title: row.title, leanStatement: row.lean_statement, source: row.source, rationale: row.rationale, program: { slug: row.slug, title: row.ptitle, description: row.pdesc }, definitions: defs },
          flags,
        };
      }
    }
    return null;
  }

  private async importSources(ids: string[]): Promise<{ id: string; source: string }[]> {
    if (!ids.length) return [];
    return this.db.select({ id: definitions.id, source: definitions.source }).from(definitions).where(inArray(definitions.id, ids));
  }

  private async runningRound(roundId: number): Promise<Round> {
    const [r] = await this.db.select().from(reviewRounds).where(eq(reviewRounds.id, roundId));
    if (!r) throw new DeskError(404, `no review round ${roundId}`);
    if (r.status !== "running") throw new DeskError(409, `review round ${roundId} is ${r.status}`);
    const t = await this.target(r.targetKind as TargetKind, r.targetId);
    if (!t || t.sha !== r.targetSha256) throw new DeskError(409, `${r.targetId} changed since this review started`);
    return r;
  }

  private async usage(agentId: string, purpose: "review" | "adversary", parts: UsagePart[], requestId?: string): Promise<string> {
    if (!parts.length) return "0";
    return (await this.desk.recordUsage(null, agentId, { purpose, parts, requestId })).costUsd;
  }

  /** A reviewer agent's verdict (definitions: matches the textbook definition, no Mathlib definition to reuse; statements: meaningful). */
  async recordVerdict(roundId: number, v: VerdictInput): Promise<{ roundStatus: string }> {
    const r = await this.runningRound(roundId);
    const cost = await this.usage(v.agentId, "review", v.parts, v.requestId); // paid either way
    const steps = await this.steps(roundId);
    if (steps.some((s) => s.kind === "reviewer" && s.actor === v.agentId)) throw new DeskError(409, `${v.agentId} already reviewed this round`);
    await this.addStep(roundId, { kind: "reviewer", actor: v.agentId, model: v.model, verdict: v.agree ? "pass" : "fail", summary: v.summary, reasoning: v.reasoning, details: v.details, costUsd: cost });
    await emit(this.db, "review_step", { agentId: v.agentId, lemmaId: r.targetKind === "statement" ? r.targetId : null, payload: { roundId, kind: r.targetKind, target: r.targetId, step: "reviewer", verdict: v.agree ? "pass" : "fail", summary: clip(v.summary, 80) } });
    return { roundStatus: await this.evaluate(roundId) };
  }

  // ================================================================ adversary

  goals(d: { id: string; adversaryGoals: string[] }): { index: number; lemmaId: string; goal: string }[] {
    return ["False", ...d.adversaryGoals].map((goal, i) => ({ index: i, lemmaId: `L-adv-${String(i + 1).padStart(3, "0")}`, goal }));
  }

  /** The statement file the adversary must prove (built here, never stored: these are not lemmas). */
  private goalSource(defId: string, lemmaId: string, goal: string): string {
    return `-- adversary goal (review of ${defId}); not a lemma of this project\nimport ${defId}\n\ndef Statement.${lemmaIdToLeanName(lemmaId)} : Prop :=\n  ${goal}\n`;
  }

  private async adversaryRound(roundId: number, agentId: string) {
    const r = await this.runningRound(roundId);
    if (r.targetKind !== "definition") throw new DeskError(400, "only definitions have an adversary");
    if (r.adversaryAgent !== agentId) throw new DeskError(409, "this round's adversary is another agent");
    const [d] = await this.db.select().from(definitions).where(eq(definitions.id, r.targetId));
    return { r, d: d! };
  }

  /** Record the adversary's model call against the round's budget. */
  async adversaryUsage(roundId: number, agentId: string, parts: UsagePart[], requestId?: string): Promise<{ spentUsd: string; budgetLeft: boolean }> {
    const { r } = await this.adversaryRound(roundId, agentId);
    const cost = await this.usage(agentId, "adversary", parts, requestId);
    const [u] = await this.db
      .update(reviewRounds)
      .set({ adversarySpentUsd: sql`${reviewRounds.adversarySpentUsd} + ${cost}::numeric` })
      .where(eq(reviewRounds.id, r.id))
      .returning();
    return { spentUsd: u!.adversarySpentUsd, budgetLeft: Number(u!.adversarySpentUsd) < this.cfg.ADVERSARY_BUDGET_USD };
  }

  /** Judge one adversary proof attempt with the desk's own judge. A pass rejects the definition. */
  async adversaryCheck(roundId: number, agentId: string, goalIndex: number, source: string): Promise<{ verdict: JudgeVerdict; roundStatus: string }> {
    const { r, d } = await this.adversaryRound(roundId, agentId);
    if (Number(r.adversarySpentUsd) >= this.cfg.ADVERSARY_BUDGET_USD && r.adversaryChecks >= this.cfg.ADVERSARY_MIN_CHECKS) throw new DeskError(429, "the adversary's budget is used up");
    const goal = this.goals(d).find((g) => g.index === goalIndex);
    if (!goal) throw new DeskError(400, `no adversary goal ${goalIndex}`);
    const info = await this.desk.assertJudgeFresh();
    if (d.requiresMathlib && info.flavor !== "full") throw new DeskError(503, `${d.id} needs Mathlib but the judge runs the ${info.flavor} image`);
    const verdict = await this.desk.judge.check({ lemmaId: goal.lemmaId, source, deps: [], statements: [{ lemmaId: goal.lemmaId, source: this.goalSource(d.id, goal.lemmaId, goal.goal) }] });
    if (verdict.verdict === "fail" && verdict.reasons.length && verdict.reasons.every((x) => x.code === "runner_error")) {
      throw new DeskError(503, "judge infrastructure error, retry", "judge_unavailable");
    }
    await this.db.update(reviewRounds).set({ adversaryChecks: sql`${reviewRounds.adversaryChecks} + 1`, adversaryUntil: new Date(this.desk.now().getTime() + this.cfg.ADVERSARY_LEASE_SECONDS * 1000) }).where(eq(reviewRounds.id, r.id));
    if (verdict.verdict === "pass") {
      await this.addStep(r.id, {
        kind: "adversary", actor: agentId, verdict: "fail",
        summary: `The adversary proved ${goal.goal} from ${d.id}: the definitions are inconsistent or decide P vs NP by accident.`,
        reasoning: "The Lean judge accepted this proof:\n" + clip(source, 7000),
        details: { goal: goal.goal, sourceSha256: sha256(source), checkers: verdict.checkers, axioms: verdict.axioms },
      });
    }
    return { verdict, roundStatus: await this.evaluate(r.id) };
  }

  /** The adversary stops. It counts as "survived" only after enough real attempts (or the whole budget). */
  async adversaryDone(roundId: number, agentId: string, notes: string): Promise<{ roundStatus: string }> {
    const { r } = await this.adversaryRound(roundId, agentId);
    const spent = Number(r.adversarySpentUsd);
    if (r.adversaryChecks < this.cfg.ADVERSARY_MIN_CHECKS && spent < this.cfg.ADVERSARY_BUDGET_USD) {
      throw new DeskError(409, `try at least ${this.cfg.ADVERSARY_MIN_CHECKS} proofs before giving up (${r.adversaryChecks} so far)`);
    }
    await this.db.update(reviewRounds).set({ adversaryDone: true, adversaryAgent: null, adversaryUntil: null }).where(eq(reviewRounds.id, r.id));
    await this.addStep(r.id, {
      kind: "adversary", actor: agentId, verdict: "pass",
      summary: `The adversary found no proof of False${(await this.goalsOf(r.targetId)).slice(1).map((g) => `, ${g.goal}`).join("")} in ${r.adversaryChecks} judged attempts ($${spent.toFixed(2)} of $${this.cfg.ADVERSARY_BUDGET_USD.toFixed(2)}).`,
      reasoning: clip(notes, 8000),
      details: { checks: r.adversaryChecks, spentUsd: r.adversarySpentUsd, budgetUsd: this.cfg.ADVERSARY_BUDGET_USD },
      costUsd: r.adversarySpentUsd,
    });
    return { roundStatus: await this.evaluate(r.id) };
  }

  private async goalsOf(defId: string) {
    const [d] = await this.db.select().from(definitions).where(eq(definitions.id, defId));
    return d ? this.goals(d) : [];
  }

  // ================================================================ deciding

  /** Decide a running round if it can be decided. Returns its status. */
  async evaluate(roundId: number): Promise<string> {
    const [r] = await this.db.select().from(reviewRounds).where(eq(reviewRounds.id, roundId));
    if (!r || r.status !== "running") return r?.status ?? "missing";
    const t = await this.target(r.targetKind as TargetKind, r.targetId);
    if (!t || t.sha !== r.targetSha256) {
      await this.db.update(reviewRounds).set({ status: "superseded", finishedAt: this.desk.now(), reason: "the source changed" }).where(eq(reviewRounds.id, r.id));
      return "superseded";
    }
    const steps = await this.steps(r.id);
    const reviewers = steps.filter((s) => s.kind === "reviewer");
    const firstFail = reviewers.find((s) => s.verdict === "fail");
    if (firstFail) return this.finish(r, "rejected", `a reviewer agent (${firstFail.model ?? firstFail.actor}) disagreed: ${firstFail.summary}`);

    if (r.targetKind === "definition") {
      const adversaryWin = steps.find((s) => s.kind === "adversary" && s.verdict === "fail");
      if (adversaryWin) return this.finish(r, "rejected", adversaryWin.summary);
      const sanity = await this.sanityState(r.targetId);
      const recorded = steps.filter((s) => s.kind === "sanity").at(-1);
      if (sanity.status !== "pending" && recorded?.verdict !== sanity.status) {
        await this.addStep(r.id, { kind: "sanity", actor: "desk", verdict: sanity.status, summary: sanity.reason, details: { lemmas: sanity.lemmas } });
      }
      if (sanity.status === "fail") return this.finish(r, "rejected", `sanity check failed: ${sanity.reason}`);
      const distinctModels = new Set(reviewers.map((s) => s.model)).size;
      const enough = reviewers.length >= this.cfg.DEFINITION_REVIEWERS_REQUIRED && (!this.cfg.REVIEW_REQUIRE_DISTINCT_MODELS || distinctModels >= this.cfg.DEFINITION_REVIEWERS_REQUIRED);
      const adversaryPassed = steps.some((s) => s.kind === "adversary" && s.verdict === "pass");
      const [d] = await this.db.select().from(definitions).where(eq(definitions.id, r.targetId));
      const states = await this.desk.definitionStates();
      const importsOk = d!.imports.every((i) => states.get(i)?.effective);
      if (enough && adversaryPassed && sanity.status === "pass" && importsOk) {
        return this.finish(r, "approved", `${reviewers.length} reviewer agents (${[...new Set(reviewers.map((s) => s.model))].join(", ")}) agreed, all ${sanity.lemmas.length} sanity lemmas are proved, and the adversary found nothing`);
      }
      return "running";
    }

    // statement
    const [s] = await this.db.select().from(statements).where(eq(statements.id, r.targetId));
    const blockers = await this.review.approvalBlockers(s!);
    const definitionBlockers = blockers.filter((b) => b.startsWith("uses a draft definition"));
    const otherBlockers = blockers.filter((b) => !b.startsWith("uses a draft definition"));
    if (otherBlockers.length) return this.finish(r, "rejected", otherBlockers.join("; "));
    if (definitionBlockers.length) return "running"; // waits for its definitions
    if (!steps.some((x) => x.kind === "definitions")) {
      await this.addStep(r.id, { kind: "definitions", actor: "desk", verdict: "pass", summary: s!.defImports.length ? `Every definition it uses is approved: ${s!.defImports.join(", ")}.` : "It uses no project definitions." });
    }
    if (reviewers.length >= this.cfg.STATEMENT_REVIEWERS_REQUIRED) {
      return this.finish(r, "approved", `${reviewers.length} reviewer agent${reviewers.length === 1 ? "" : "s"} confirmed it is meaningful for its program`);
    }
    return "running";
  }

  private async finish(r: Round, status: "approved" | "rejected", reason: string): Promise<string> {
    const now = this.desk.now();
    await this.db.transaction(async (tx) => {
      await tx.update(reviewRounds).set({ status, finishedAt: now, reason: clip(reason, 2000), adversaryAgent: null, adversaryUntil: null }).where(eq(reviewRounds.id, r.id));
      if (r.targetKind === "definition") {
        await tx
          .update(definitions)
          .set(status === "approved" ? { status: "approved", reviewedSha256: r.targetSha256, reviewedBy: null, reviewedAt: now, reviewedVia: "ai" } : { status: "rejected", reviewedSha256: null, reviewedBy: null, reviewedAt: now, reviewedVia: "ai" })
          .where(and(eq(definitions.id, r.targetId), eq(definitions.sourceSha256, r.targetSha256)));
        await emit(tx, "definition_reviewed", { payload: { definition: r.targetId, decision: status === "approved" ? "approve" : "reject", via: "ai", roundId: r.id, reason: clip(reason, 300), role: "AI review" } });
      } else if (status === "approved") {
        await tx.update(statements).set({ status: "approved", approvedBy: `AI review (round #${r.id})`, approvedAt: now, rejectReason: null }).where(eq(statements.id, r.targetId));
        await tx.insert(lemmas).values({ id: r.targetId, status: "open" }).onConflictDoNothing();
        await emit(tx, "statement_approved", { lemmaId: r.targetId, payload: { via: "ai", roundId: r.id } });
      } else {
        await tx.update(statements).set({ status: "rejected", rejectReason: clip(`AI review: ${reason}`, 2000) }).where(eq(statements.id, r.targetId));
        await emit(tx, "statement_rejected", { lemmaId: r.targetId, payload: { auto: true, via: "ai", roundId: r.id, reason: clip(reason, 300) } });
      }
    });
    if (r.targetKind === "definition" && status === "rejected") await this.desk.revertStatementsUsingDrafts();
    if (r.targetKind === "statement" && status === "approved") await this.desk.recheckScan();
    return status;
  }

  /** Periodic work: start missing rounds, decide what can be decided (sanity progress, approved definitions). */
  async tick(): Promise<{ started: number[]; decided: { roundId: number; status: string }[] }> {
    await this.desk.revertStatementsUsingDrafts();
    const started = await this.ensureRounds();
    const decided: { roundId: number; status: string }[] = [];
    for (const r of await this.db.select().from(reviewRounds).where(eq(reviewRounds.status, "running")).orderBy(asc(reviewRounds.id))) {
      const status = await this.evaluate(r.id);
      if (status !== "running") decided.push({ roundId: r.id, status });
    }
    return { started, decided };
  }

  // ================================================================ overrides and flags

  /**
   * Admin override. revert: back to review (a new round). block: never auto-reviewed or used until
   * unblocked. unblock: reviewed again from scratch.
   */
  async adminOverride(kind: TargetKind, id: string, action: "revert" | "block" | "unblock", reason: string, by: string): Promise<{ status: string }> {
    if (!(await this.target(kind, id))) throw new DeskError(404, `no ${kind} ${id}`);
    const now = this.desk.now();
    if (kind === "definition") {
      if (action === "block") {
        await this.db.update(definitions).set({ status: "blocked", blockedReason: reason, reviewedSha256: null, reviewedVia: "admin", reviewedAt: now }).where(eq(definitions.id, id));
        await this.supersede(kind, id, `blocked by ${by}`);
      } else {
        await this.db.update(definitions).set({ status: "draft", blockedReason: null, reviewedSha256: null, reviewedVia: "admin", reviewedAt: now }).where(eq(definitions.id, id));
        // A fresh try: sanity lemmas the provers gave up on are open again (refuted ones stay refuted).
        const sanity = (await this.db.select({ id: statements.id }).from(statements).where(sql`${id} = any(${statements.sanityFor})`)).map((s) => s.id);
        if (sanity.length) await this.db.update(lemmas).set({ status: "open" }).where(and(inArray(lemmas.id, sanity), eq(lemmas.status, "abandoned")));
      }
      await this.desk.revertStatementsUsingDrafts();
    } else {
      const [s] = await this.db.select().from(statements).where(eq(statements.id, id));
      if (s!.sanityFor.length) throw new DeskError(400, "sanity lemmas come from the repository; change the file, or revert the definition they test");
      if (action === "block") {
        await this.db.update(statements).set({ status: "rejected", blockedAt: now, rejectReason: `blocked by an admin: ${reason}`, approvedBy: null, approvedAt: null }).where(eq(statements.id, id));
        await this.supersede(kind, id, `blocked by ${by}`);
      } else if (!s!.sanityFor.length) {
        await this.db.update(statements).set({ status: "proposed", blockedAt: null, rejectReason: null, approvedBy: null, approvedAt: null }).where(eq(statements.id, id));
      }
    }
    await emit(this.db, "review_overridden", { lemmaId: kind === "statement" ? id : null, payload: { kind, target: id, action, by, reason: clip(reason, 300) } });
    if (action === "block") return { status: "blocked" };
    const round = await this.startRound(kind, id, "admin", `${action} by ${by}: ${reason}`);
    await this.addStep(round.id, { kind: "admin", actor: by, verdict: "info", summary: `${action === "revert" ? "Sent back to review" : "Unblocked"} by an admin.`, reasoning: reason });
    return { status: "in review" };
  }

  private async supersede(kind: TargetKind, id: string, reason: string) {
    await this.db
      .update(reviewRounds)
      .set({ status: "superseded", finishedAt: this.desk.now(), reason, adversaryAgent: null })
      .where(and(eq(reviewRounds.targetKind, kind), eq(reviewRounds.targetId, id), eq(reviewRounds.status, "running")));
  }

  /**
   * A public flag (GitHub issue): the target goes back to review. The flag's text is kept and shown to
   * the reviewer agents as DATA; it can only cause a re-review, never an approval.
   */
  async flag(f: { issueNumber: number; login: string; targetId: string; reason: string }): Promise<{ result: "accepted" | "attached" | "refused"; message: string; roundId?: number }> {
    const login = f.login.toLowerCase();
    const [dup] = await this.db.select().from(reviewFlags).where(eq(reviewFlags.issueNumber, f.issueNumber));
    if (dup) return { result: "attached", message: `issue #${f.issueNumber} was already received`, roundId: dup.roundId ?? undefined };
    const [person] = await this.db.select().from(contributors).where(eq(contributors.login, login));
    if (person?.blockedAt) return { result: "refused", message: `@${login} is blocked from contributing` };
    const since = new Date(this.desk.now().getTime() - 86_400_000);
    const recent = await this.db.select({ id: reviewFlags.id }).from(reviewFlags).where(and(eq(reviewFlags.login, login), gt(reviewFlags.ts, since)));
    if (recent.length >= this.cfg.MAX_FLAGS_PER_LOGIN_PER_DAY) return { result: "refused", message: `at most ${this.cfg.MAX_FLAGS_PER_LOGIN_PER_DAY} flags per person per day` };
    const kind: TargetKind = f.targetId.startsWith("Defs.") ? "definition" : "statement";
    if (!(await this.target(kind, f.targetId))) return { result: "refused", message: `no definition or statement called ${f.targetId}` };
    if (kind === "definition") {
      const [d] = await this.db.select().from(definitions).where(eq(definitions.id, f.targetId));
      if (d!.status === "blocked") return { result: "refused", message: `${f.targetId} is already blocked by an admin` };
    } else {
      const [s] = await this.db.select().from(statements).where(eq(statements.id, f.targetId));
      if (s!.blockedAt) return { result: "refused", message: `${f.targetId} is already blocked by an admin` };
      if (s!.sanityFor.length || (!s!.defImports.length && s!.origin === "repo")) {
        return { result: "refused", message: `${f.targetId} comes from the repository (not the AI review); open a pull request or ask a maintainer instead` };
      }
    }
    // One flag-triggered re-review at a time per target: later flags join it.
    const [open] = await this.db.select().from(reviewRounds).where(and(eq(reviewRounds.targetKind, kind), eq(reviewRounds.targetId, f.targetId), eq(reviewRounds.status, "running"), eq(reviewRounds.trigger, "flag")));
    let round = open;
    if (!round) {
      if (kind === "definition") {
        await this.db.update(definitions).set({ status: "draft", reviewedSha256: null, reviewedVia: "flag" }).where(eq(definitions.id, f.targetId));
        await this.desk.revertStatementsUsingDrafts();
      } else {
        await this.db.update(statements).set({ status: "proposed", approvedBy: null, approvedAt: null, rejectReason: null }).where(eq(statements.id, f.targetId));
      }
      round = await this.startRound(kind, f.targetId, "flag", `flagged in issue #${f.issueNumber} by @${login}`);
    }
    await this.db.insert(reviewFlags).values({ issueNumber: f.issueNumber, login, targetKind: kind, targetId: f.targetId, reason: clip(f.reason, 2000), roundId: round.id, ts: this.desk.now() });
    await this.addStep(round.id, { kind: "flag", actor: `github:${login}`, verdict: "info", summary: `Flagged in GitHub issue #${f.issueNumber}.`, reasoning: clip(f.reason, 2000), details: { issueNumber: f.issueNumber } });
    await emit(this.db, "review_flagged", { lemmaId: kind === "statement" ? f.targetId : null, payload: { kind, target: f.targetId, issueNumber: f.issueNumber, roundId: round.id } });
    return { result: open ? "attached" : "accepted", message: `${f.targetId} is back in review (round #${round.id})`, roundId: round.id };
  }

  // ================================================================ public views

  async history(kind: TargetKind, id: string) {
    const rounds = await this.rounds(kind, id);
    const out = [];
    for (const r of rounds) {
      out.push({
        id: r.id, status: r.status, trigger: r.trigger, reason: r.reason, startedAt: r.startedAt, finishedAt: r.finishedAt, sourceSha256: r.targetSha256,
        adversary: kind === "definition" ? { checks: r.adversaryChecks, spentUsd: r.adversarySpentUsd, done: r.adversaryDone } : null,
        steps: (await this.steps(r.id)).map((s) => ({ id: s.id, ts: s.ts, kind: s.kind, actor: s.actor, model: s.model, verdict: s.verdict, summary: s.summary, reasoning: s.reasoning, details: s.details, costUsd: s.costUsd })),
      });
    }
    return { label: AI_REVIEW_LABEL, rounds: out, sanity: kind === "definition" ? await this.sanityState(id) : null };
  }

  /** Recent decisions, for the site. */
  async recentDecisions(limit = 50) {
    return this.db
      .select({ id: reviewRounds.id, kind: reviewRounds.targetKind, target: reviewRounds.targetId, status: reviewRounds.status, reason: reviewRounds.reason, trigger: reviewRounds.trigger, finishedAt: reviewRounds.finishedAt })
      .from(reviewRounds)
      .where(inArray(reviewRounds.status, ["approved", "rejected"]))
      .orderBy(desc(reviewRounds.finishedAt))
      .limit(limit);
  }
}

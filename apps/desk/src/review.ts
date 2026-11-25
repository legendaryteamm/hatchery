/**
 * Phase 3 review tool (HUMAN, now optional: HUMAN_REVIEW_TOOL=1), the automatic statement check, and
 * the decomposer's proposals. The default review is done by AI agents: see ai-review.ts.
 *
 * Human-tool rules (when enabled):
 * Rules (BUILD_PROMPT.md section 7 + maintainer decisions of Phase 3):
 *  - Every definition module is a DRAFT until a math ADVISOR approves its exact current source.
 *  - A statement can only be approved (by an advisor or a maintainer) when it passed the automatic
 *    check (well-formed, elaborates with sorry, not trivial, not a duplicate) AND every definition it
 *    uses is reviewed. Only approved statements become leasable lemmas.
 *  - Every decision is bound to the source hash the reviewer saw; a stale page cannot approve.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { lemmaIdToLeanName, MESSAGE_LIMITS, StatementCheckResultSchema, type StatementCheckResult } from "@hatchery/shared";
import {
  attempts,
  definitions,
  lemmas,
  programs,
  reviewerSessions,
  reviewers,
  reviewRounds,
  reviews,
  splitRequests,
  statements,
} from "./db/schema.ts";
import { declarationsOf } from "./lean-repo.ts";
import { Desk, DeskError, emit, type UsagePart } from "./service.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

export type Reviewer = typeof reviewers.$inferSelect;
export type Decision = "approve" | "request_changes" | "reject" | "comment";

export interface StatementCheckClient {
  statementCheck(req: { lemmaId: string; source: string }): Promise<StatementCheckResult>;
}

export class Review {
  constructor(private desk: Desk, private checker: StatementCheckClient) {}

  private get db() {
    return this.desk.db;
  }

  // ================================================================ reviewers and sessions

  /** Create a reviewer and a one-time invite link (shown once; only its hash is stored). */
  async addReviewer(name: string, role: "advisor" | "maintainer"): Promise<{ reviewer: Reviewer; inviteUrl: string }> {
    const [r] = await this.db.insert(reviewers).values({ name, role }).returning();
    return { reviewer: r!, inviteUrl: await this.newInvite(r!.id) };
  }

  async newInvite(reviewerId: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(this.desk.now().getTime() + this.desk.config.REVIEW_INVITE_DAYS * 86_400_000);
    await this.db.update(reviewers).set({ inviteTokenHash: hash(token), inviteExpiresAt: expires, inviteUsedAt: null }).where(eq(reviewers.id, reviewerId));
    return `${this.desk.config.PUBLIC_SITE_URL.replace(/\/$/, "")}/review/join#${token}`;
  }

  /** Exchange a one-time invite token for a session token. */
  async redeemInvite(token: string): Promise<{ sessionToken: string; reviewer: Reviewer; expiresAt: Date }> {
    const now = this.desk.now();
    const [r] = await this.db.select().from(reviewers).where(eq(reviewers.inviteTokenHash, hash(token)));
    if (!r || r.disabledAt || r.inviteUsedAt || !r.inviteExpiresAt || r.inviteExpiresAt < now) throw new DeskError(401, "this invite link is not valid any more; ask the maintainer for a new one");
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.desk.config.REVIEW_SESSION_DAYS * 86_400_000);
    await this.db.transaction(async (tx) => {
      await tx.update(reviewers).set({ inviteUsedAt: now, inviteTokenHash: null }).where(eq(reviewers.id, r.id));
      await tx.insert(reviewerSessions).values({ tokenHash: hash(sessionToken), reviewerId: r.id, createdAt: now, expiresAt });
    });
    return { sessionToken, reviewer: r, expiresAt };
  }

  async reviewerForSession(sessionToken: string | undefined): Promise<Reviewer | null> {
    if (!sessionToken) return null;
    const [row] = await this.db
      .select({ r: reviewers, expiresAt: reviewerSessions.expiresAt })
      .from(reviewerSessions)
      .innerJoin(reviewers, eq(reviewers.id, reviewerSessions.reviewerId))
      .where(eq(reviewerSessions.tokenHash, hash(sessionToken)));
    if (!row || row.expiresAt < this.desk.now() || row.r.disabledAt) return null;
    return row.r;
  }

  async endSession(sessionToken: string): Promise<void> {
    await this.db.delete(reviewerSessions).where(eq(reviewerSessions.tokenHash, hash(sessionToken)));
  }

  async disableReviewer(id: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(reviewers).set({ disabledAt: this.desk.now(), inviteTokenHash: null }).where(eq(reviewers.id, id));
      await tx.delete(reviewerSessions).where(eq(reviewerSessions.reviewerId, id));
    });
  }

  // ================================================================ views

  async definitionList() {
    const rows = await this.db.select().from(definitions).where(eq(definitions.removed, false)).orderBy(asc(definitions.id));
    const states = await this.desk.definitionStates();
    return rows.map((d) => ({
      id: d.id,
      title: d.title,
      summary: d.summary,
      path: d.path,
      requiresMathlib: d.requiresMathlib,
      status: d.status,
      draft: !states.get(d.id)?.effective,
      draftReasons: states.get(d.id)?.blockers ?? [],
      reviewedAt: d.reviewedAt,
    }));
  }

  async definitionDetail(id: string) {
    const [d] = await this.db.select().from(definitions).where(eq(definitions.id, id));
    if (!d) throw new DeskError(404, "no such definition");
    const states = await this.desk.definitionStates();
    const usedBy = await this.db
      .select({ id: statements.id, title: statements.title, status: statements.status })
      .from(statements)
      .where(sql`${id} = any(${statements.defImports})`)
      .orderBy(asc(statements.id));
    return {
      id: d.id,
      title: d.title,
      summary: d.summary,
      path: d.path,
      source: d.source,
      sourceSha256: d.sourceSha256,
      requiresMathlib: d.requiresMathlib,
      status: d.status,
      draft: !states.get(d.id)?.effective,
      draftReasons: states.get(d.id)?.blockers ?? [],
      imports: d.imports.map((i) => ({ id: i, draft: !states.get(i)?.effective })),
      declarations: declarationsOf(d.source),
      usedBy,
      history: await this.history("definition", id),
    };
  }

  async statementDetail(id: string) {
    const [row] = await this.db
      .select({ s: statements, program: programs.slug, programTitle: programs.title })
      .from(statements)
      .innerJoin(programs, eq(programs.id, statements.programId))
      .where(eq(statements.id, id));
    if (!row) throw new DeskError(404, "no such statement");
    const s = row.s;
    const states = await this.desk.definitionStates();
    const blockers = await this.approvalBlockers(s);
    const [lemma] = await this.db.select({ status: lemmas.status }).from(lemmas).where(eq(lemmas.id, id));
    return {
      id: s.id,
      title: s.title,
      program: row.program,
      programTitle: row.programTitle,
      status: s.status,
      origin: s.origin,
      proposedBy: s.proposedBy,
      approvedBy: s.approvedBy,
      rationale: s.rationale,
      rejectReason: s.rejectReason,
      parentId: s.parentId,
      leanStatement: s.leanStatement,
      source: s.source,
      sourceSha256: s.fileSha256,
      check: s.check as StatementCheckResult | null,
      definitions: s.defImports.map((d) => ({ id: d, draft: !states.get(d)?.effective, reasons: states.get(d)?.blockers ?? [] })),
      usesDraftDefinition: s.defImports.some((d) => !states.get(d)?.effective),
      canApprove: s.status === "proposed" && blockers.length === 0,
      approvalBlockers: blockers,
      lemmaStatus: lemma?.status ?? null,
      history: await this.history("statement", id),
    };
  }

  async queue() {
    const defs = await this.definitionList();
    const proposed = await this.db
      .select({ s: statements, program: programs.slug })
      .from(statements)
      .innerJoin(programs, eq(programs.id, statements.programId))
      .where(eq(statements.status, "proposed"))
      .orderBy(asc(statements.proposedAt), asc(statements.id));
    const items = [];
    for (const { s, program } of proposed) {
      const blockers = await this.approvalBlockers(s);
      items.push({ id: s.id, title: s.title, program, origin: s.origin, leanStatement: s.leanStatement, check: s.check, canApprove: blockers.length === 0, approvalBlockers: blockers });
    }
    const recent = await this.db.select().from(reviews).orderBy(desc(reviews.id)).limit(20);
    return { definitions: defs, statements: items, recentReviews: recent };
  }

  private async history(kind: "definition" | "statement", id: string) {
    return this.db
      .select({ id: reviews.id, ts: reviews.ts, decision: reviews.decision, comment: reviews.comment, targetSha256: reviews.targetSha256, reviewer: reviewers.name, role: reviewers.role })
      .from(reviews)
      .innerJoin(reviewers, eq(reviewers.id, reviews.reviewerId))
      .where(and(eq(reviews.targetKind, kind), eq(reviews.targetId, id)))
      .orderBy(desc(reviews.id));
  }

  /** Why this statement cannot be approved right now (empty = it can). */
  async approvalBlockers(s: typeof statements.$inferSelect): Promise<string[]> {
    const out: string[] = [];
    const check = s.check ? StatementCheckResultSchema.safeParse(s.check) : null;
    if (!check?.success) out.push("the automatic check has not run yet");
    else {
      const c = check.data;
      if (!c.wellFormed) out.push(`not well-formed: ${c.errors.join("; ")}`);
      else if (!c.elaborates) out.push(`does not elaborate in Lean: ${c.errors.slice(0, 3).join("; ")}`);
      if (c.trivial) out.push(`trivial: closed automatically by ${c.trivialBy}`);
    }
    const dup = await this.duplicateOf(s.id, s.leanStatement);
    if (dup) out.push(`duplicate of ${dup}`);
    out.push(...(await this.desk.draftBlockers(s.defImports)).map((b) => `uses a draft definition: ${b}`));
    return out;
  }

  async duplicateOf(id: string, leanStatement: string): Promise<string | null> {
    const others = await this.db
      .select({ id: statements.id, text: statements.leanStatement })
      .from(statements)
      .where(and(sql`${statements.id} <> ${id}`, inArray(statements.status, ["proposed", "approved"])));
    return others.find((o) => normalize(o.text) === normalize(leanStatement))?.id ?? null;
  }

  // ================================================================ decisions

  async reviewDefinition(reviewer: Reviewer, id: string, decision: Decision, comment: string, seenSha256: string) {
    const [d] = await this.db.select().from(definitions).where(eq(definitions.id, id));
    if (!d || d.removed) throw new DeskError(404, "no such definition");
    if (d.sourceSha256 !== seenSha256) throw new DeskError(409, "this definition changed since you opened it; reload the page to review the current version");
    if (decision === "reject") throw new DeskError(400, "definitions are not rejected; request changes instead");
    if (decision === "approve" && reviewer.role !== "advisor") throw new DeskError(403, "only a math advisor can approve a definition");
    if (decision !== "comment" && !comment.trim() && decision === "request_changes") throw new DeskError(400, "say what should change");
    const now = this.desk.now();
    await this.db.transaction(async (tx) => {
      await tx.insert(reviews).values({ targetKind: "definition", targetId: id, targetSha256: seenSha256, reviewerId: reviewer.id, decision, comment, ts: now });
      if (decision !== "comment") await this.supersedeAiRounds(tx, "definition", id, `${reviewer.role} ${reviewer.name} decided: ${decision}`);
      if (decision === "approve") {
        await tx.update(definitions).set({ status: "approved", reviewedSha256: seenSha256, reviewedBy: reviewer.id, reviewedAt: now, reviewedVia: "human" }).where(eq(definitions.id, id));
      } else if (decision === "request_changes") {
        await tx.update(definitions).set({ status: "changes_requested", reviewedSha256: null, reviewedBy: reviewer.id, reviewedAt: now, reviewedVia: "human" }).where(eq(definitions.id, id));
      }
      await emit(tx, "definition_reviewed", { payload: { definition: id, decision, reviewer: reviewer.name, role: reviewer.role } });
    });
    if (decision === "request_changes") await this.desk.revertStatementsUsingDrafts();
    return this.definitionDetail(id);
  }

  async reviewStatement(reviewer: Reviewer, id: string, decision: Decision, comment: string, seenSha256: string) {
    const [s] = await this.db.select().from(statements).where(eq(statements.id, id));
    if (!s) throw new DeskError(404, "no such statement");
    if (s.fileSha256 !== seenSha256) throw new DeskError(409, "this statement changed since you opened it; reload the page to review the current version");
    if ((decision === "reject" || decision === "request_changes") && !comment.trim()) throw new DeskError(400, "say why");
    if (decision !== "comment" && s.status !== "proposed") throw new DeskError(409, `this statement is ${s.status}; only proposed statements can be decided`);
    if (decision === "approve") {
      const blockers = await this.approvalBlockers(s);
      if (blockers.length) throw new DeskError(409, `cannot approve: ${blockers.join("; ")}`);
    }
    const now = this.desk.now();
    await this.db.transaction(async (tx) => {
      await tx.insert(reviews).values({ targetKind: "statement", targetId: id, targetSha256: seenSha256, reviewerId: reviewer.id, decision, comment, ts: now });
      if (decision !== "comment") await this.supersedeAiRounds(tx, "statement", id, `${reviewer.role} ${reviewer.name} decided: ${decision}`);
      if (decision === "approve") {
        await tx.update(statements).set({ status: "approved", approvedBy: `${reviewer.name} (${reviewer.role})`, approvedAt: now, rejectReason: null }).where(eq(statements.id, id));
        await tx.insert(lemmas).values({ id, status: "open" }).onConflictDoNothing();
        await emit(tx, "statement_approved", { lemmaId: id, payload: { reviewer: reviewer.name, role: reviewer.role } });
      } else if (decision === "reject") {
        await tx.update(statements).set({ status: "rejected", rejectReason: comment }).where(eq(statements.id, id));
        await emit(tx, "statement_rejected", { lemmaId: id, payload: { reviewer: reviewer.name, auto: false, reason: comment } });
      } else {
        await emit(tx, "statement_reviewed", { lemmaId: id, payload: { decision, reviewer: reviewer.name } });
      }
    });
    if (decision === "approve") {
      // A lemma that was checked before (e.g. statement edited, then re-approved) is re-checked.
      await this.desk.recheckScan();
    }
    return this.statementDetail(id);
  }

  /** A human decision (HUMAN_REVIEW_TOOL=1) replaces a running AI review of the same target. */
  private async supersedeAiRounds(tx: Parameters<Parameters<Desk["db"]["transaction"]>[0]>[0], kind: "definition" | "statement", id: string, reason: string) {
    await tx
      .update(reviewRounds)
      .set({ status: "superseded", finishedAt: this.desk.now(), reason, adversaryAgent: null })
      .where(and(eq(reviewRounds.targetKind, kind), eq(reviewRounds.targetId, id), eq(reviewRounds.status, "running")));
  }

  // ================================================================ automatic statement checks

  /** Run the automatic check on proposed statements that have none yet (needs the judge). */
  async runPendingChecks(): Promise<string[]> {
    const pending = await this.db.select().from(statements).where(and(eq(statements.status, "proposed"), isNull(statements.check)));
    const info = await this.desk.judgeInfo().catch(() => null);
    const done: string[] = [];
    for (const s of pending) {
      if (s.requiresMathlib && info?.flavor !== "full") continue; // only the full image can check it
      const result = await this.checker.statementCheck({ lemmaId: s.id, source: s.source });
      await this.applyCheck(s.id, result);
      done.push(s.id);
    }
    return done;
  }

  /** Store a check result; auto-reject what can never be approved (section 7). */
  private async applyCheck(id: string, result: StatementCheckResult): Promise<string | null> {
    const [s] = await this.db.select().from(statements).where(eq(statements.id, id));
    const dup = await this.duplicateOf(id, s!.leanStatement);
    const reason = !result.wellFormed
      ? `not well-formed: ${result.errors.join("; ")}`
      : !result.elaborates && !(result.requiresMathlib && result.errors.some((e) => e.includes("lite image")))
        ? `does not elaborate: ${result.errors.slice(0, 3).join("; ")}`
        : result.trivial
          ? `trivial: closed automatically by ${result.trivialBy}`
          : dup
            ? `duplicate of ${dup}`
            : null;
    await this.db.transaction(async (tx) => {
      await tx.update(statements).set({ check: result, ...(reason ? { status: "rejected" as const, rejectReason: reason } : {}) }).where(eq(statements.id, id));
      if (reason) await emit(tx, "statement_rejected", { lemmaId: id, payload: { auto: true, reason } });
    });
    return reason;
  }

  // ================================================================ decomposer and split requests

  async decomposerContext(programSlug?: string) {
    const progs = await this.db.select().from(programs).orderBy(asc(programs.sort));
    const defs = await this.definitionList();
    const defRows = await this.db.select({ id: definitions.id, source: definitions.source }).from(definitions).where(eq(definitions.removed, false));
    const stmts = await this.db
      .select({ id: statements.id, title: statements.title, leanStatement: statements.leanStatement, status: statements.status, program: programs.slug, rejectReason: statements.rejectReason })
      .from(statements)
      .innerJoin(programs, eq(programs.id, statements.programId))
      .orderBy(asc(statements.id));
    const splits = await this.db
      .select({ id: splitRequests.id, lemmaId: splitRequests.lemmaId, reason: splitRequests.reason, leanStatement: statements.leanStatement, program: programs.slug })
      .from(splitRequests)
      .innerJoin(statements, eq(statements.id, splitRequests.lemmaId))
      .innerJoin(programs, eq(programs.id, statements.programId))
      .where(eq(splitRequests.status, "open"))
      .orderBy(asc(splitRequests.id));
    return {
      // The decomposer proposes research statements only (warm-up and sanity lemmas come from the repository).
      programs: progs.filter((p) => p.slug !== "core-warmup" && p.slug !== "definition-sanity" && (!programSlug || p.slug === programSlug)).map((p) => ({
        slug: p.slug,
        title: p.title,
        description: p.description,
        idPrefix: p.idPrefix,
        open: stmts.filter((s) => s.program === p.slug && s.status === "approved").length,
        proposed: stmts.filter((s) => s.program === p.slug && s.status === "proposed").length,
      })),
      definitions: defs.map((d) => ({ ...d, source: defRows.find((r) => r.id === d.id)?.source ?? "" })),
      statements: stmts,
      splitRequests: splits,
    };
  }

  /** Next free id in a program, e.g. L-circ-014. */
  private async nextId(programSlug: string): Promise<{ id: string; programId: number }> {
    const [p] = await this.db.select().from(programs).where(eq(programs.slug, programSlug));
    if (!p || !p.idPrefix) throw new DeskError(400, `unknown program ${programSlug}`);
    const rows = await this.db.select({ id: statements.id }).from(statements).where(sql`${statements.id} like ${`L-${p.idPrefix}-%`}`);
    const max = rows.reduce((m, r) => Math.max(m, Number(/-(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
    return { id: `L-${p.idPrefix}-${String(max + 1).padStart(3, "0")}`, programId: p.id };
  }

  /**
   * A decomposer proposal: the desk assigns the id, writes the statement file, runs the automatic
   * check, and stores it as "proposed" (or auto-rejects it). It is never leasable before it passes the AI review.
   */
  async propose(
    agentId: string,
    p: { program: string; title: string; imports: string[]; prop: string; rationale: string; parentId?: string; splitRequestId?: number },
  ): Promise<{ id: string; status: string; rejectReason: string | null; check: StatementCheckResult | null }> {
    const hourAgo = new Date(this.desk.now().getTime() - 3600_000).toISOString();
    const [{ n }] = (await this.db.execute<{ n: number }>(
      sql`select count(*)::int as n from statements where proposed_by = ${agentId} and proposed_at >= ${hourAgo}::timestamptz`,
    )) as unknown as [{ n: number }];
    if (Number(n) >= this.desk.config.MAX_PROPOSALS_PER_HOUR) throw new DeskError(429, `proposal limit reached (${this.desk.config.MAX_PROPOSALS_PER_HOUR} per hour)`);
    if (p.parentId) {
      const [parent] = await this.db.select({ id: statements.id }).from(statements).where(eq(statements.id, p.parentId));
      if (!parent) throw new DeskError(400, `no statement ${p.parentId}`);
    }
    const { id, programId } = await this.nextId(p.program);
    const leanName = lemmaIdToLeanName(id);
    const source = [
      `-- program: ${p.program}`,
      `-- title: ${p.title.replace(/\n/g, " ").slice(0, 200)}`,
      `-- depends_on: ${p.parentId ?? ""}`,
      `-- proposed by: ${agentId} (decomposer); needs to pass the AI review`,
      ...p.imports.map((m) => `import ${m}`),
      "",
      `def Statement.${leanName} : Prop :=`,
      `  ${p.prop.trim().replace(/\n/g, "\n  ")}`,
      "",
    ].join("\n");
    const defImports = p.imports.filter((m) => m.startsWith("Defs."));
    const requiresMathlib = p.imports.some((m) => m === "Mathlib" || m.startsWith("Mathlib.") || m.startsWith("Defs.Mathlib."));
    await this.db.transaction(async (tx) => {
      await tx.insert(statements).values({
        id, programId, leanName, title: p.title.slice(0, 200), leanStatement: p.prop.trim(), status: "proposed", proposedBy: agentId,
        dependsOn: p.parentId ? [p.parentId] : [], requiresMathlib, fileSha256: hash(source), source, origin: "decomposer", defImports,
        rationale: p.rationale.slice(0, 2000), parentId: p.parentId ?? null, proposedAt: this.desk.now(),
      });
      await emit(tx, "statement_proposed", { agentId, lemmaId: id, payload: { origin: "decomposer", parentId: p.parentId ?? null } });
      if (p.splitRequestId) {
        await tx.update(splitRequests).set({ status: "done", handledAt: this.desk.now(), proposals: sql`array_append(${splitRequests.proposals}, ${id})` }).where(eq(splitRequests.id, p.splitRequestId));
      }
    });
    const info = await this.desk.judgeInfo().catch(() => null);
    if (requiresMathlib && info?.flavor !== "full") {
      return { id, status: "proposed", rejectReason: null, check: null }; // checked later by a full-image judge
    }
    const result = await this.checker.statementCheck({ lemmaId: id, source });
    const reason = await this.applyCheck(id, result);
    return { id, status: reason ? "rejected" : "proposed", rejectReason: reason, check: result };
  }

  /** An agent asks the decomposer to split its lemma (section 6b). One open request per agent and lemma. */
  async requestSplit(agentId: string, attemptId: number, reason: string): Promise<{ splitRequestId: number }> {
    const [a] = await this.db.select().from(attempts).where(eq(attempts.id, attemptId));
    if (!a || a.agentId !== agentId) throw new DeskError(404, "no such attempt");
    const [open] = await this.db
      .select({ id: splitRequests.id })
      .from(splitRequests)
      .where(and(eq(splitRequests.lemmaId, a.lemmaId), eq(splitRequests.status, "open")));
    if (open) return { splitRequestId: open.id };
    const [r] = await this.db.transaction(async (tx) => {
      const ins = await tx.insert(splitRequests).values({ agentId, lemmaId: a.lemmaId, reason: reason.slice(0, MESSAGE_LIMITS.body), ts: this.desk.now() }).returning();
      await emit(tx, "split_requested", { agentId, lemmaId: a.lemmaId, payload: { splitRequestId: ins[0]!.id, reason: reason.slice(0, MESSAGE_LIMITS.short) } });
      return ins;
    });
    return { splitRequestId: r!.id };
  }

  /** Record a decomposer model call (no attempt). */
  recordDecomposerUsage(agentId: string, parts: UsagePart[], requestId?: string) {
    return this.desk.recordUsage(null, agentId, { purpose: "decompose", parts, requestId });
  }
}


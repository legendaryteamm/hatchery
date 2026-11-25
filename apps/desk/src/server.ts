/**
 * Desk HTTP API.
 *   /internal/*  workers (Bearer DESK_WORKER_TOKEN). Validated with zod.
 *   /admin/*     maintainers (Bearer ADMIN_TOKEN; Phase 6 replaces this with the GitHub OAuth allowlist).
 *   public       read-only views + SSE event stream (rate limited in Phase 4).
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { LemmaIdSchema, MAX_PROOF_BYTES, MESSAGE_LIMITS, SLEEP_REASONS } from "@hatchery/shared";
import { agents, attempts, events, leases, lemmas, messages, programs, statements } from "./db/schema.ts";
import { Review, type Reviewer } from "./review.ts";
import { Desk, DeskError } from "./service.ts";
import { agentCard, colonySnapshot, feed, graveyard, pantrySummary } from "./views.ts";

const AgentId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "agent ids: lowercase letters, digits, hyphens");
const Source = z.string().min(1).max(MAX_PROOF_BYTES);
const Notes = z.string().max(2000).default("");
const Tokens = z.number().int().nonnegative().max(10_000_000);
const Part = z.object({
  model: z.string().min(1).max(100),
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheReadTokens: Tokens,
  cacheWriteTokens: Tokens,
  servedByFallback: z.boolean().default(false),
});
const Body = z.string().min(1).max(MESSAGE_LIMITS.body);
const Short = z.string().min(1).max(MESSAGE_LIMITS.short);

const Schemas = {
  agent: z.object({ agentId: AgentId }),
  register: z.object({ agentId: AgentId, model: z.string().min(1).max(100) }),
  lease: z.object({ agentId: AgentId, program: z.string().max(64).optional() }),
  heartbeat: z.object({ agentId: AgentId, lemmaId: LemmaIdSchema }),
  release: z.object({
    agentId: AgentId,
    lemmaId: LemmaIdSchema,
    notes: Notes,
    abandon: z.boolean().default(false),
    handoff: z.object({ body: Body, short: Short, note: z.string().max(6000) }).optional(),
  }),
  attempt: z.object({ agentId: AgentId, lemmaId: LemmaIdSchema }),
  usage: z.object({
    agentId: AgentId,
    purpose: z.enum(["prove"]),
    parts: z.array(Part).min(1).max(10),
    requestId: z.string().max(200).optional(),
  }),
  source: z.object({ agentId: AgentId, source: Source }),
  submit: z.object({ agentId: AgentId, source: Source, notes: Notes }),
  finish: z.object({ agentId: AgentId, result: z.enum(["failed", "timeout"]), notes: Notes, judgeErrors: z.string().max(4000).nullable().default(null) }),
  spent: z.object({ agentId: AgentId, since: z.string().datetime() }),
  sleep: z.object({ agentId: AgentId, reason: z.enum(SLEEP_REASONS) }),
  ask: z.object({ agentId: AgentId, body: Body, short: Short }),
  reply: z.object({
    agentId: AgentId,
    kind: z.enum(["reply", "hint"]),
    body: Body,
    short: Short,
    parts: z.array(Part).min(1).max(10),
    requestId: z.string().max(200).optional(),
  }),
  replies: z.object({ agentId: AgentId, lemmaId: LemmaIdSchema, attemptId: z.coerce.number().int().positive().optional() }),
  file: z.object({ path: z.string().max(200) }),
  search: z.object({ q: z.string().regex(/^[\x20-\x7e]{2,100}$/) }),
  checked: z.object({ q: z.string().min(2).max(100) }),
  killSwitch: z.object({ on: z.boolean(), by: z.string().min(1).max(64) }),
  split: z.object({ agentId: AgentId, reason: z.string().min(1).max(MESSAGE_LIMITS.body) }),
  usageOnly: z.object({ agentId: AgentId, purpose: z.enum(["decompose"]), parts: z.array(Part).min(1).max(10), requestId: z.string().max(200).optional() }),
  proposal: z.object({
    agentId: AgentId,
    program: z.string().min(1).max(64),
    title: z.string().min(3).max(200),
    imports: z.array(z.string().regex(/^(Mathlib|Defs)(\.[A-Za-z0-9_']+)*$/, "imports: Mathlib.* or Defs.* only")).max(20),
    prop: z.string().min(1).max(4000),
    rationale: z.string().max(2000).default(""),
    parentId: LemmaIdSchema.optional(),
    splitRequestId: z.number().int().positive().optional(),
  }),
  join: z.object({ token: z.string().min(20).max(200) }),
  decision: z.object({
    decision: z.enum(["approve", "request_changes", "reject", "comment"]),
    comment: z.string().max(5000).default(""),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
};

const SESSION_COOKIE = "hatchery_review";

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function buildServer(desk: Desk, review: Review = new Review(desk, desk.judge)): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: MAX_PROOF_BYTES * 2, trustProxy: desk.config.TRUST_PROXY });
  const db = desk.db;
  // Public routes are rate limited per client (fixed one-minute window). Workers (token),
  // reviewers (session) and admins are not.
  const windows = new Map<string, { start: number; n: number }>();
  app.addHook("onRequest", async (req, reply) => {
    if (/^\/(internal|review|admin)\//.test(req.url)) return;
    const now = Date.now();
    let w = windows.get(req.ip);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, n: 0 };
      windows.set(req.ip, w);
      if (windows.size > 50_000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    }
    if (++w.n > desk.config.RATE_LIMIT_PER_MINUTE) {
      reply.header("retry-after", Math.ceil((w.start + 60_000 - now) / 1000));
      return reply.code(429).send({ error: "too many requests; try again in a minute" });
    }
  });
  const streams = new Map<string, number>();
  const secureCookie = desk.config.PUBLIC_SITE_URL.startsWith("https://");

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DeskError) return reply.code(err.status).send({ error: err.message, reason: err.reason });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: err.issues });
    req.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  /** Worker routes: token check, and every request marks the agent as alive. */
  const internal = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!tokenOk(req.headers.authorization, desk.config.DESK_WORKER_TOKEN)) return reply.code(401).send({ error: "unauthorized" });
      const id = ((req.body ?? req.query) as { agentId?: unknown } | undefined)?.agentId;
      if (typeof id === "string" && AgentId.safeParse(id).success) await desk.touch(id);
      return fn(req, reply);
    };
  const admin = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!desk.config.ADMIN_TOKEN) return reply.code(404).send({ error: "admin routes are disabled (set ADMIN_TOKEN)" });
      if (!tokenOk(req.headers.authorization, desk.config.ADMIN_TOKEN)) return reply.code(401).send({ error: "unauthorized" });
      return fn(req, reply);
    };
  const idParam = (req: FastifyRequest) => z.coerce.number().int().positive().parse((req.params as { id: string }).id);

  // ---------------------------------------------------------------- internal (workers)
  app.post("/internal/agents/register", internal(async (req) => {
    const b = Schemas.register.parse(req.body);
    return desk.registerAgent(b.agentId, b.model);
  }));
  app.get("/internal/budget", internal(async (req) => desk.budget(Schemas.agent.parse(req.query).agentId)));
  app.post("/internal/sleep", internal(async (req) => {
    const b = Schemas.sleep.parse(req.body);
    return { emitted: await desk.reportSleeping(b.agentId, b.reason) };
  }));
  app.get("/internal/colony", internal(async () => desk.colony()));
  app.post("/internal/lease", internal(async (req, reply) => {
    const b = Schemas.lease.parse(req.body);
    const ctx = await desk.lease(b.agentId, b.program);
    return ctx ?? reply.code(204).send();
  }));
  app.post("/internal/lease/heartbeat", internal(async (req) => {
    const b = Schemas.heartbeat.parse(req.body);
    return desk.heartbeat(b.agentId, b.lemmaId);
  }));
  app.post("/internal/lease/release", internal(async (req) => {
    const b = Schemas.release.parse(req.body);
    return desk.release(b.agentId, b.lemmaId, b.notes, b.abandon, b.handoff);
  }));
  app.post("/internal/attempts", internal(async (req) => {
    const b = Schemas.attempt.parse(req.body);
    return { attemptId: await desk.startAttempt(b.agentId, b.lemmaId) };
  }));
  app.post("/internal/attempts/:id/usage", internal(async (req) => {
    const b = Schemas.usage.parse(req.body);
    return desk.recordUsage(idParam(req), b.agentId, b);
  }));
  app.post("/internal/attempts/:id/check", internal(async (req) => {
    const b = Schemas.source.parse(req.body);
    return desk.localCheck(idParam(req), b.agentId, b.source);
  }));
  app.post("/internal/attempts/:id/submit", internal(async (req) => {
    const b = Schemas.submit.parse(req.body);
    return desk.submit(idParam(req), b.agentId, b.source, b.notes);
  }));
  app.post("/internal/attempts/:id/finish", internal(async (req) => {
    const b = Schemas.finish.parse(req.body);
    await desk.endAttempt(idParam(req), b.agentId, b.result, b.notes, b.judgeErrors);
    return { ok: true };
  }));
  app.post("/internal/attempts/:id/ask", internal(async (req) => {
    const b = Schemas.ask.parse(req.body);
    return desk.ask(b.agentId, idParam(req), b.body, b.short);
  }));
  app.get("/internal/inbox", internal(async (req) => desk.inbox(Schemas.agent.parse(req.query).agentId)));
  app.get("/internal/can-reply", internal(async (req) => desk.canReply(Schemas.agent.parse(req.query).agentId)));
  app.post("/internal/questions/:id/reply", internal(async (req) => {
    const b = Schemas.reply.parse(req.body);
    return desk.reply(b.agentId, idParam(req), b);
  }));
  app.post("/internal/replies/take", internal(async (req) => {
    const b = Schemas.replies.parse(req.body);
    return desk.takeReplies(b.agentId, b.lemmaId, b.attemptId ?? null);
  }));
  app.get("/internal/awaiting-reply", internal(async (req) => {
    const q = Schemas.replies.parse(req.query);
    return { awaiting: await desk.awaitingReply(q.agentId, q.lemmaId) };
  }));
  app.get("/internal/spent", internal(async (req) => {
    const q = Schemas.spent.parse(req.query);
    return { spentUsd: await desk.spentSince(q.agentId, new Date(q.since)) };
  }));
  /** read_file tool: Defs/ and Statements/ from the trusted checkout, Proofs/ only for checked lemmas. */
  app.get("/internal/files", internal(async (req, reply) => {
    const { path } = Schemas.file.parse(req.query);
    const proof = /^Proofs\/(L_[a-z0-9_]+)\.lean$/.exec(path);
    if (proof) {
      const [l] = await db.select().from(lemmas).where(and(eq(lemmas.id, proof[1]!.replaceAll("_", "-")), eq(lemmas.status, "checked")));
      return l?.checkedSource ? { path, content: l.checkedSource } : reply.code(404).send({ error: "only checked proofs can be read" });
    }
    const stmt = /^Statements\/(L_[a-z0-9_]+)\.lean$/.exec(path);
    if (stmt) {
      const [s] = await db.select().from(statements).where(and(eq(statements.leanName, stmt[1]!), eq(statements.status, "approved")));
      return s ? { path, content: s.source } : reply.code(404).send({ error: "only approved statements can be read" });
    }
    if (!/^Defs\/[A-Za-z0-9_/]+\.lean$/.test(path) || path.includes("..")) {
      return reply.code(400).send({ error: "readable: Defs/*.lean, Statements/*.lean, Proofs/<checked>.lean" });
    }
    try {
      return { path, content: desk.repo.read(path) };
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  }));
  app.get("/internal/search", internal(async (req) => {
    const { q } = Schemas.search.parse(req.query);
    return { results: await desk.judge.search(q) };
  }));
  app.get("/internal/checked", internal(async (req) => desk.searchChecked(Schemas.checked.parse(req.query).q)));

  // ---------------------------------------------------------------- internal: decomposer and splits
  app.get("/internal/decomposer/context", internal(async (req) => {
    const q = z.object({ agentId: AgentId, program: z.string().max(64).optional() }).parse(req.query);
    return review.decomposerContext(q.program);
  }));
  app.post("/internal/proposals", internal(async (req) => {
    const b = Schemas.proposal.parse(req.body);
    return review.propose(b.agentId, b);
  }));
  app.post("/internal/usage", internal(async (req) => {
    const b = Schemas.usageOnly.parse(req.body);
    return review.recordDecomposerUsage(b.agentId, b.parts, b.requestId);
  }));
  app.post("/internal/attempts/:id/split", internal(async (req) => {
    const b = Schemas.split.parse(req.body);
    return review.requestSplit(b.agentId, idParam(req), b.reason);
  }));

  // ---------------------------------------------------------------- review tool (advisors, maintainers)
  /**
   * Reviewers sign in with a one-time invite link (no developer account needed). The session is an
   * httpOnly, SameSite=Strict cookie. Every state-changing request must also carry the header
   * `x-hatchery-review: 1`, which a cross-site form cannot send.
   */
  const reviewerOf = async (req: FastifyRequest): Promise<Reviewer | null> => review.reviewerForSession(readCookie(req, SESSION_COOKIE));
  const reviewerRoute = (write: boolean, fn: (req: FastifyRequest, reply: FastifyReply, r: Reviewer) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const r = await reviewerOf(req);
      if (!r) return reply.code(401).send({ error: "please open your invite link to sign in" });
      if (write && req.headers["x-hatchery-review"] !== "1") return reply.code(403).send({ error: "missing x-hatchery-review header" });
      return fn(req, reply, r);
    };
  const cookie = (value: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureCookie ? "; Secure" : ""}`;

  app.post("/review/join", async (req, reply) => {
    if (req.headers["x-hatchery-review"] !== "1") return reply.code(403).send({ error: "missing x-hatchery-review header" });
    const { token } = Schemas.join.parse(req.body);
    const s = await review.redeemInvite(token);
    reply.header("set-cookie", cookie(s.sessionToken, Math.floor((s.expiresAt.getTime() - Date.now()) / 1000)));
    return { name: s.reviewer.name, role: s.reviewer.role };
  });
  app.post("/review/logout", async (req, reply) => {
    const t = readCookie(req, SESSION_COOKIE);
    if (t) await review.endSession(t);
    reply.header("set-cookie", cookie("", 0));
    return { ok: true };
  });
  app.get("/review/me", reviewerRoute(false, async (_req, _reply, r) => ({ name: r.name, role: r.role })));
  app.get("/review/queue", reviewerRoute(false, async () => review.queue()));
  app.get("/review/definitions/:id", reviewerRoute(false, async (req) => review.definitionDetail((req.params as { id: string }).id)));
  app.post("/review/definitions/:id", reviewerRoute(true, async (req, _reply, r) => {
    const b = Schemas.decision.parse(req.body);
    return review.reviewDefinition(r, (req.params as { id: string }).id, b.decision, b.comment, b.sha256);
  }));
  app.get("/review/statements/:id", reviewerRoute(false, async (req) => review.statementDetail(LemmaIdSchema.parse((req.params as { id: string }).id))));
  app.post("/review/statements/:id", reviewerRoute(true, async (req, _reply, r) => {
    const b = Schemas.decision.parse(req.body);
    return review.reviewStatement(r, LemmaIdSchema.parse((req.params as { id: string }).id), b.decision, b.comment, b.sha256);
  }));

  // ---------------------------------------------------------------- admin
  app.get("/admin/kill-switch", admin(async () => (await desk.budget(null)).killSwitch));
  app.post("/admin/kill-switch", admin(async (req) => {
    const b = Schemas.killSwitch.parse(req.body);
    await desk.setKillSwitch(b.on, b.by);
    return (await desk.budget(null)).killSwitch;
  }));

  // ---------------------------------------------------------------- public, read-only
  app.get("/health", async () => {
    let judge: unknown;
    try {
      const info = await desk.judgeInfo();
      judge = { ...info, fresh: info.trustedSha === desk.repo.trustedSha() };
    } catch (err) {
      judge = { error: (err as Error).message };
    }
    return { ok: true, judge, mathlibLemmasEnabled: await desk.mathlibAllowed().catch(() => false) };
  });

  /** Today's budget (no agent): caps, spend, pantry, kill switch. */
  app.get("/budget", async () => desk.budget(null));

  app.get("/lemmas", async () =>
    db
      .select({
        id: lemmas.id, status: lemmas.status, title: statements.title, program: programs.slug,
        leanStatement: statements.leanStatement, checkedAt: lemmas.checkedAt, checkedByAgent: lemmas.checkedByAgent,
        checkedCommit: lemmas.checkedCommit, requiresMathlib: statements.requiresMathlib,
      })
      .from(lemmas)
      .innerJoin(statements, eq(statements.id, lemmas.id))
      .innerJoin(programs, eq(programs.id, statements.programId))
      .orderBy(asc(lemmas.id)),
  );

  app.get("/lemmas/:id", async (req, reply) => {
    const id = LemmaIdSchema.parse((req.params as { id: string }).id);
    const [l] = await db.select().from(lemmas).innerJoin(statements, eq(statements.id, lemmas.id)).where(eq(lemmas.id, id));
    if (!l) return reply.code(404).send({ error: "not found" });
    const att = await db.select().from(attempts).where(eq(attempts.lemmaId, id)).orderBy(desc(attempts.id)).limit(100);
    const ev = await db.select().from(events).where(eq(events.lemmaId, id)).orderBy(desc(events.id)).limit(200);
    const msgs = await db.select().from(messages).where(eq(messages.lemmaId, id)).orderBy(desc(messages.id)).limit(100);
    const [lease] = await db.select().from(leases).where(eq(leases.lemmaId, id));
    return { lemma: l.lemmas, statement: l.statements, lease: lease ?? null, attempts: att, events: ev, messages: msgs };
  });

  app.get("/agents", async () => {
    const rows = await db.select().from(agents).orderBy(asc(agents.createdAt));
    const stats = await db.execute<{ agent_id: string; checked: number; attempts: number }>(sql`
      select agent_id, count(*) filter (where result = 'checked')::int as checked, count(*)::int as attempts
      from attempts group by agent_id`);
    const spend = await db.execute<{ agent_id: string; total: string }>(sql`
      select agent_id, coalesce(sum(cost_usd), 0)::numeric(14,6)::text as total from model_calls group by agent_id`);
    return rows.map((a) => {
      const s = stats.find((x) => x.agent_id === a.id);
      return { ...a, checkedTotal: s?.checked ?? 0, attemptsTotal: s?.attempts ?? 0, spentUsd: spend.find((x) => x.agent_id === a.id)?.total ?? "0.000000" };
    });
  });

  // ---------------------------------------------------------------- public: the site (Phase 4)
  app.get("/colony", async () => colonySnapshot(desk));
  app.get("/feed", async (req) => {
    const q = z.object({
      before: z.coerce.number().int().positive().optional(),
      after: z.coerce.number().int().nonnegative().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      agent: AgentId.optional(),
      lemma: LemmaIdSchema.optional(),
    }).parse(req.query);
    return feed(desk, { before: q.before, after: q.after, limit: q.limit, agentId: q.agent, lemmaId: q.lemma });
  });
  app.get("/agents/:id", async (req, reply) => {
    const id = AgentId.parse((req.params as { id: string }).id);
    return (await agentCard(desk, id)) ?? reply.code(404).send({ error: "no such agent" });
  });
  app.get("/graveyard", async () => graveyard(desk));
  app.get("/pantry", async () => pantrySummary(desk));

  /** Definitions, with their review state: the site must show drafts as drafts. */
  app.get("/definitions", async () => review.definitionList());
  app.get("/definitions/:id", async (req) => {
    const d = await review.definitionDetail((req.params as { id: string }).id);
    return { ...d, history: d.history.map(({ reviewer, role, ts, decision, comment }) => ({ reviewer, role, ts, decision, comment })) };
  });
  /** Statements by status (proposed ones are in review; rejected ones keep their reason). */
  app.get("/statements", async (req) => {
    const q = z.object({ status: z.enum(["proposed", "approved", "rejected"]).optional() }).parse(req.query);
    const states = await desk.definitionStates();
    const rows = await db
      .select({ id: statements.id, title: statements.title, status: statements.status, program: programs.slug, leanStatement: statements.leanStatement, origin: statements.origin, defImports: statements.defImports, rejectReason: statements.rejectReason, approvedBy: statements.approvedBy })
      .from(statements)
      .innerJoin(programs, eq(programs.id, statements.programId))
      .where(q.status ? eq(statements.status, q.status) : undefined)
      .orderBy(asc(statements.id));
    return rows.map((r) => ({ ...r, usesDraftDefinition: r.defImports.some((d) => !states.get(d)?.effective) }));
  });
  app.get("/programs", async () => db.select().from(programs).orderBy(asc(programs.sort)));

  app.get("/messages", async (req) => {
    const q = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return db.select().from(messages).where(gt(messages.id, q.after)).orderBy(asc(messages.id)).limit(q.limit);
  });

  app.get("/events", async (req) => {
    const q = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return db.select().from(events).where(gt(events.id, q.after)).orderBy(asc(events.id)).limit(q.limit);
  });

  /** SSE: replays events after Last-Event-ID (or ?after=), then streams new ones. */
  app.get("/events/stream", (req, reply) => {
    const q = z.object({ after: z.coerce.number().int().nonnegative().optional() }).parse(req.query);
    let last = Number(req.headers["last-event-id"] ?? q.after ?? 0) || 0;
    const open = streams.get(req.ip) ?? 0;
    if (open >= desk.config.MAX_STREAMS_PER_CLIENT) return reply.code(429).send({ error: "too many open event streams from this client" });
    streams.set(req.ip, open + 1);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let closed = false;
    req.raw.on("close", () => {
      closed = true;
      const n = (streams.get(req.ip) ?? 1) - 1;
      if (n > 0) streams.set(req.ip, n);
      else streams.delete(req.ip);
    });
    const tick = async () => {
      while (!closed) {
        const rows = await db.select().from(events).where(gt(events.id, last)).orderBy(asc(events.id)).limit(200);
        for (const e of rows) {
          reply.raw.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`); // type is in the data: EventSource.onmessage gets every event
          last = e.id;
        }
        if (!rows.length) reply.raw.write(": keep-alive\n\n");
        await new Promise((r) => setTimeout(r, rows.length === 200 ? 0 : 1000));
      }
    };
    tick().catch(() => reply.raw.end());
  });

  return app;
}

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
import { Desk, DeskError } from "./service.ts";

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
};

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function buildServer(desk: Desk): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: MAX_PROOF_BYTES * 2 });
  const db = desk.db;

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
    if (!/^(Defs|Statements)\/[A-Za-z0-9_/]+\.lean$/.test(path) || path.includes("..")) {
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
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let closed = false;
    req.raw.on("close", () => (closed = true));
    const tick = async () => {
      while (!closed) {
        const rows = await db.select().from(events).where(gt(events.id, last)).orderBy(asc(events.id)).limit(200);
        for (const e of rows) {
          reply.raw.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
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

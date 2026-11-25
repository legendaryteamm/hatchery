/**
 * Desk HTTP API.
 *   /internal/*  workers (Bearer DESK_WORKER_TOKEN). Validated with zod.
 *   public       read-only views + SSE event stream (rate limited in Phase 4 / deploy).
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { LemmaIdSchema, MAX_PROOF_BYTES } from "@hatchery/shared";
import { agents, attempts, events, leases, lemmas, programs, statements } from "./db/schema.ts";
import { Desk, DeskError } from "./service.ts";

const AgentId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "agent ids: lowercase letters, digits, hyphens");
const Source = z.string().min(1).max(MAX_PROOF_BYTES);
const Notes = z.string().max(2000).default("");
const Tokens = z.number().int().nonnegative().max(10_000_000);

const Schemas = {
  register: z.object({ agentId: AgentId, model: z.string().min(1).max(100) }),
  lease: z.object({ agentId: AgentId, program: z.string().max(64).optional() }),
  heartbeat: z.object({ agentId: AgentId, lemmaId: LemmaIdSchema }),
  release: z.object({ agentId: AgentId, lemmaId: LemmaIdSchema, notes: Notes, abandon: z.boolean().default(false) }),
  attempt: z.object({ agentId: AgentId, lemmaId: LemmaIdSchema }),
  usage: z.object({
    agentId: AgentId,
    model: z.string().min(1).max(100),
    purpose: z.enum(["prove"]),
    inputTokens: Tokens,
    outputTokens: Tokens,
    cacheReadTokens: Tokens,
    cacheWriteTokens: Tokens,
    requestId: z.string().max(200).optional(),
    fallbackUsed: z.boolean().default(false),
  }),
  source: z.object({ agentId: AgentId, source: Source }),
  submit: z.object({ agentId: AgentId, source: Source, notes: Notes }),
  finish: z.object({ agentId: AgentId, result: z.enum(["failed", "timeout"]), notes: Notes, judgeErrors: z.string().max(4000).nullable().default(null) }),
  spent: z.object({ agentId: AgentId, since: z.string().datetime() }),
  file: z.object({ path: z.string().max(200) }),
  search: z.object({ q: z.string().regex(/^[\x20-\x7e]{2,100}$/) }),
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
    if (err instanceof DeskError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: err.issues });
    req.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  const internal = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!tokenOk(req.headers.authorization, desk.config.DESK_WORKER_TOKEN)) return reply.code(401).send({ error: "unauthorized" });
      return fn(req, reply);
    };
  const attemptId = (req: FastifyRequest) => z.coerce.number().int().positive().parse((req.params as { id: string }).id);

  // ---------------------------------------------------------------- internal (workers)
  app.post("/internal/agents/register", internal(async (req) => {
    const b = Schemas.register.parse(req.body);
    return desk.registerAgent(b.agentId, b.model);
  }));
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
    await desk.release(b.agentId, b.lemmaId, b.notes, b.abandon);
    return { ok: true };
  }));
  app.post("/internal/attempts", internal(async (req) => {
    const b = Schemas.attempt.parse(req.body);
    return { attemptId: await desk.startAttempt(b.agentId, b.lemmaId) };
  }));
  app.post("/internal/attempts/:id/usage", internal(async (req) => {
    const b = Schemas.usage.parse(req.body);
    return desk.recordUsage(attemptId(req), b.agentId, b);
  }));
  app.post("/internal/attempts/:id/check", internal(async (req) => {
    const b = Schemas.source.parse(req.body);
    return desk.localCheck(attemptId(req), b.agentId, b.source);
  }));
  app.post("/internal/attempts/:id/submit", internal(async (req) => {
    const b = Schemas.submit.parse(req.body);
    return desk.submit(attemptId(req), b.agentId, b.source, b.notes);
  }));
  app.post("/internal/attempts/:id/finish", internal(async (req) => {
    const b = Schemas.finish.parse(req.body);
    await desk.endAttempt(attemptId(req), b.agentId, b.result, b.notes, b.judgeErrors);
    return { ok: true };
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

  app.get("/lemmas", async () =>
    db
      .select({
        id: lemmas.id, status: lemmas.status, title: statements.title, program: programs.slug,
        leanStatement: statements.leanStatement, checkedAt: lemmas.checkedAt, checkedByAgent: lemmas.checkedByAgent,
        requiresMathlib: statements.requiresMathlib,
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
    const [lease] = await db.select().from(leases).where(eq(leases.lemmaId, id));
    return { lemma: l.lemmas, statement: l.statements, lease: lease ?? null, attempts: att, events: ev };
  });

  app.get("/agents", async () => {
    const rows = await db.select().from(agents).orderBy(asc(agents.createdAt));
    const stats = await db.execute<{ agent_id: string; checked: number; attempts: number; cost: string }>(sql`
      select agent_id, count(*) filter (where result = 'checked')::int as checked, count(*)::int as attempts,
             coalesce(sum(cost_usd), 0)::numeric(14,6)::text as cost
      from attempts group by agent_id`);
    return rows.map((a) => {
      const s = stats.find((x) => x.agent_id === a.id);
      return { ...a, checkedTotal: s?.checked ?? 0, attemptsTotal: s?.attempts ?? 0, spentUsd: s?.cost ?? "0.000000" };
    });
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

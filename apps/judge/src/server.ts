/**
 * Internal HTTP API of the judge. The desk (and the GitHub Action, via the CLI) call it;
 * it is not meant to be exposed to the public internet.
 *   POST /check  {lemmaId, source} -> JudgeVerdict
 *   GET  /health
 */
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { JudgeRequestSchema, MAX_PROOF_BYTES } from "@hatchery/shared";
import type { JudgeConfig } from "./config.ts";
import { judge, type JudgeOptions } from "./judge.ts";
import { runnerInfo, searchLibrary, SEARCH_QUERY_RE, type RunnerInfo } from "./info.ts";

/** Small FIFO semaphore: at most `limit` checks run at once, at most `queueMax` wait. */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit: number, private queueMax: number) {}
  get queued() {
    return this.waiting.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.queueMax) throw new QueueFullError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
export class QueueFullError extends Error {}

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function buildServer(config: JudgeConfig, opts: JudgeOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: MAX_PROOF_BYTES * 2 });
  const limiter = new Limiter(config.concurrency, config.queueMax);

  let info: RunnerInfo | null = null;
  const getInfo = async () => (info ??= await runnerInfo(config.image, opts.runner));
  const authorized = (header: string | undefined) => !config.apiToken || tokenOk(header, config.apiToken);

  app.get("/health", async (_req, reply) => {
    try {
      return { ok: true, image: config.image, queued: limiter.queued, ...(await getInfo()) };
    } catch (err) {
      return reply.code(503).send({ ok: false, image: config.image, error: (err as Error).message });
    }
  });

  app.get("/search", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const q = (request.query as { q?: unknown }).q;
    if (typeof q !== "string" || !SEARCH_QUERY_RE.test(q)) return reply.code(400).send({ error: "q must be 2-100 printable ASCII characters" });
    return { results: await searchLibrary(config.image, q, opts.runner) };
  });

  app.post("/check", async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = JudgeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    try {
      const verdict = await limiter.run(() => judge(parsed.data, config, opts));
      request.log.info({ lemmaId: verdict.lemmaId, verdict: verdict.verdict, reasons: verdict.reasons.map((r) => r.code) }, "judged");
      return verdict;
    } catch (err) {
      if (err instanceof QueueFullError) return reply.code(503).send({ error: "judge queue full, retry later" });
      throw err;
    }
  });
  return app;
}

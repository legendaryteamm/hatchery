/**
 * Phase 1 end to end, without spending API money: real desk (HTTP + Postgres), real judge
 * (Docker, lite runner image), scripted model. Acceptance with a real model: docs/phase-1.md.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildServer, Desk, LeanRepo, type JudgeClient } from "@hatchery/desk";
import { judge, runnerInfo, searchLibrary, type JudgeConfig } from "@hatchery/judge";
import { addInflow, freshDb, REPO_LEAN_DIR, testConfig, WORKER_TOKEN } from "../../desk/test/helpers.ts";
import * as schema from "../../desk/src/db/schema.ts";
import { Agent } from "../src/agent.ts";
import { DeskClient } from "../src/desk-client.ts";
import { call, FakeProvider } from "./fake-provider.ts";

const image = process.env.JUDGE_TEST_IMAGE ?? "hatchery-lean-runner:lite";
const judgeConfig: JudgeConfig = { image, timeoutSeconds: 120, memoryMb: 2048, cpus: 2, concurrency: 1, queueMax: 0, apiToken: undefined, host: "", port: 0 };
const inProcessJudge: JudgeClient = {
  check: (req) => judge(req, judgeConfig),
  info: () => runnerInfo(image),
  search: (q) => searchLibrary(image, q),
};
const reference = (leanName: string) =>
  readFileSync(fileURLToPath(new URL(`../../desk/test/fixtures/reference-proofs/${leanName}.lean`, import.meta.url)), "utf8");

const WRONG_005 = "import Statements.L_core_005\ntheorem Proof.L_core_005 : Statement.L_core_005 := by\n  intro n\n  rfl\n";

describe("one agent, end to end (scripted model, real judge)", () => {
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  let app: ReturnType<typeof buildServer>;
  let deskUrl: string;

  beforeAll(async () => {
    fresh = await freshDb();
    const desk = new Desk(fresh.db, inProcessJudge, new LeanRepo(REPO_LEAN_DIR), testConfig());
    const info = await inProcessJudge.info();
    if (info.trustedSha !== desk.repo.trustedSha()) throw new Error(`runner image ${image} is stale: run pnpm runner:build:lite`);
    await desk.syncStatements();
    await addInflow(fresh.db, 100_000);
    app = buildServer(desk);
    await app.listen({ host: "127.0.0.1", port: 0 });
    deskUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await fresh?.cleanup();
  });

  it("leases, proves 4 of 5, abandons the 5th after 3 attempts, and records attempts, costs and events", async () => {
    const provider = new FakeProvider(({ leanName, turn, lastResult: last }) => {
      if (leanName === "L_core_005") {
        return turn === 0 ? [call("lean_check", { source: WRONG_005 })] : [call("submit_proof", { source: WRONG_005, notes: "tried rfl" })];
      }
      if (turn === 0) return [call("search_library", { query: "theorem reverse_reverse" }), call("lean_check", { source: reference(leanName) })];
      if (!last.startsWith("PASS")) throw new Error(`reference proof failed for ${leanName}: ${last}`);
      return [call("submit_proof", { source: reference(leanName), notes: "direct core lemma" })];
    });
    const logs: string[] = [];
    const agent = new Agent(new DeskClient(deskUrl, WORKER_TOKEN, "agent-test-1"), provider, {
      maxTurns: 6, maxRunUsd: 1, maxLemmas: 0, exitWhenIdle: true, idleSleepMs: 0, sleepPollMs: 10, replyWaitMs: 0, replyMaxTokens: 256,
      killSwitch: () => false, log: (m) => logs.push(m),
    });
    const result = await agent.run();
    expect(result.checked.sort()).toEqual(["L-core-001", "L-core-002", "L-core-003", "L-core-004"]);
    expect(result.stopReason).toBe("nothing to lease");

    const db = fresh.db;
    const lemmaRows = Object.fromEntries((await db.select().from(schema.lemmas)).map((l) => [l.id, l.status]));
    expect(lemmaRows).toEqual({ "L-core-001": "checked", "L-core-002": "checked", "L-core-003": "checked", "L-core-004": "checked", "L-core-005": "open" });

    const att = await db.select().from(schema.attempts).orderBy(schema.attempts.id);
    expect(att.length).toBe(7); // 4 successful + 3 failed on L-core-005
    expect(att.filter((a) => a.lemmaId === "L-core-005").map((a) => a.result)).toEqual(["failed", "failed", "failed"]);
    // 2 model calls per attempt, each 1200 in / 300 out / 800 cache-read on "fake-model" ($1 / $5 / $0.1 per MTok):
    // 1200 + 1500 + 80 = 2780 micro-dollars per call.
    expect(att.every((a) => a.turns === 2 && a.costUsd === "0.005560" && a.tokensIn === 2400)).toBe(true);
    const [{ total }] = (await db.execute(sql`select sum(cost_usd)::text as total from model_calls`)) as unknown as [{ total: string }];
    expect(total).toBe("0.038920"); // 14 calls x 2780
    const [{ attTotal }] = (await db.execute(sql`select sum(cost_usd)::text as "attTotal" from attempts`)) as unknown as [{ attTotal: string }];
    expect(attTotal).toBe(total);

    const evs = await db.execute<{ type: string; n: number }>(sql`select type, count(*)::int as n from events group by type`);
    const counts = Object.fromEntries(evs.map((e) => [e.type, e.n]));
    expect(counts).toMatchObject({
      agent_registered: 1, leased: 5, attempt_started: 7, model_call: 14, local_check: 7,
      submitted: 7, checked: 4, judge_rejected: 3, abandoned_by_agent: 1,
    });
    const [checkedRow] = await db.select().from(schema.lemmas).where(eq(schema.lemmas.id, "L-core-005"));
    expect(checkedRow!.checkedSource).toBeNull();
    const verdict = (await db.select().from(schema.lemmas).where(eq(schema.lemmas.id, "L-core-001")))[0]!.checkedVerdict as { checkers: unknown };
    expect(verdict.checkers).toEqual({ judgecheck: "pass", leanchecker: "pass" });
  });

  it("the run spend cap stops the agent before the next model call", async () => {
    const provider = new FakeProvider(() => [call("lean_check", { source: WRONG_005 })]);
    const agent = new Agent(new DeskClient(deskUrl, WORKER_TOKEN, "agent-test-2"), provider, {
      maxTurns: 50, maxRunUsd: 0.01, maxLemmas: 0, exitWhenIdle: true, idleSleepMs: 0, sleepPollMs: 10, replyWaitMs: 0, replyMaxTokens: 256,
      killSwitch: () => false, log: () => {},
    });
    const result = await agent.run();
    expect(result.stopReason).toMatch(/run spend cap reached/);
    expect(provider.calls).toBe(4); // 4 x $0.00278 = $0.01112 >= $0.01, checked before the 5th call
  });
});

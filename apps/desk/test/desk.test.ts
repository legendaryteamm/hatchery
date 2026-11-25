import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { attempts, events, lemmas, modelCalls, statements } from "../src/db/schema.ts";
import { DeskError } from "../src/service.ts";
import { makeDesk, tempLeanDir } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function setup(opts: Parameters<typeof makeDesk>[0] = {}) {
  const d = await makeDesk(opts);
  cleanups.push(d.cleanup);
  return d;
}
const eventTypes = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
  (await db.select({ t: events.type }).from(events).orderBy(events.id)).map((r) => r.t);
const part = { model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 };
const usage = { purpose: "prove" as const, parts: [part] };

describe("statements", () => {
  it("syncs the 5 core seed statements as approved, open lemmas (fixtures excluded)", async () => {
    const { db } = await setup();
    const rows = await db.select().from(statements).orderBy(statements.id);
    expect(rows.map((r) => r.id)).toEqual(["L-core-001", "L-core-002", "L-core-003", "L-core-004", "L-core-005"]);
    expect(rows.every((r) => r.status === "approved" && !r.requiresMathlib)).toBe(true);
    expect((await db.select().from(lemmas)).every((l) => l.status === "open")).toBe(true);
  });
});

describe("leases and attempts", () => {
  it("leases, records costs from real token counts, and checks a proof", async () => {
    const { desk, db } = await setup();
    await desk.registerAgent("agent-1", "claude-opus-5-5");
    const ctx = await desk.lease("agent-1");
    expect(ctx?.lemmaId).toBe("L-core-001");
    expect(ctx?.statementSource).toContain("Statement.L_core_001");
    const id = await desk.startAttempt("agent-1", "L-core-001");
    const r = await desk.recordUsage(id, "agent-1", usage);
    expect(r.costUsd).toBe("0.014900"); // 4000 + 10000 + 400 + 500 micro-dollars
    await desk.recordUsage(id, "agent-1", usage);
    const v = await desk.submit(id, "agent-1", "theorem Proof.L_core_001 -- PASS", "used Nat.add_comm");
    expect(v.verdict).toBe("pass");
    const [l] = await db.select().from(lemmas).where(eq(lemmas.id, "L-core-001"));
    expect(l).toMatchObject({ status: "checked", checkedByAgent: "agent-1", checkedCommit: "test-commit", checkedProofPath: "lean/Proofs/L_core_001.lean" });
    expect(l!.checkedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const [a] = await db.select().from(attempts).where(eq(attempts.id, id));
    expect(a).toMatchObject({ result: "checked", tokensIn: 2000, tokensOut: 1000, cacheReadTokens: 4000, cacheWriteTokens: 200, costUsd: "0.029800", turns: 2 });
    expect((await db.select().from(modelCalls)).length).toBe(2);
    expect(await desk.spentSince("agent-1", new Date(0))).toBe("0.029800");
    expect(await eventTypes(db)).toEqual([
      "definition_synced", "definition_synced", "definition_synced", // Defs.Core.{Circuit,Formula,Resolution}; the Mathlib one is synced too
      "definition_synced",
      "statement_synced", "statement_synced", "statement_synced", "statement_synced", "statement_synced",
      "agent_registered", "leased", "attempt_started", "model_call", "model_call", "submitted", "checked",
    ]);
    expect(await desk.budget("agent-1")).toMatchObject({ allowed: true, agentSpentUsd: "0.029800", globalSpentUsd: "0.029800" });
  });

  it("refuses unpriced models and work without a lease", async () => {
    const { desk } = await setup();
    await desk.registerAgent("agent-1", "x");
    await expect(desk.startAttempt("agent-1", "L-core-001")).rejects.toThrow(/no active lease/);
    await desk.lease("agent-1");
    const id = await desk.startAttempt("agent-1", "L-core-001");
    await expect(desk.recordUsage(id, "agent-1", { purpose: "prove", parts: [{ ...part, model: "mystery" }] })).rejects.toThrow(/no price/);
    await expect(desk.lease("agent-1")).rejects.toThrow(/already holds/);
  });

  it("rejection keeps the lemma leased; after max attempts the agent abandons it and won't get it again", async () => {
    const { desk, db } = await setup({ config: { AGENT_MAX_ATTEMPTS_PER_LEMMA: "2" } });
    await desk.registerAgent("agent-1", "claude-opus-5-5");
    await desk.lease("agent-1");
    for (let i = 0; i < 2; i++) {
      const id = await desk.startAttempt("agent-1", "L-core-001");
      const v = await desk.submit(id, "agent-1", "wrong", `try ${i}`);
      expect(v.verdict).toBe("fail");
    }
    const [a] = await db.select().from(attempts).limit(1);
    expect(a).toMatchObject({ result: "failed", judgeErrors: "compile_error: fake failure", notes: "try 0" });
    await desk.release("agent-1", "L-core-001", "tried twice; rfl fails", true);
    expect((await db.select().from(lemmas).where(eq(lemmas.id, "L-core-001")))[0]!.status).toBe("open");
    const next = await desk.lease("agent-1");
    expect(next?.lemmaId).toBe("L-core-002");
    // Another agent gets the abandoned lemma, with the notes of previous failed attempts.
    // (Leases go to the least-attempted lemma first, so mark the untouched ones as done.)
    await db.update(lemmas).set({ status: "checked" }).where(sql`${lemmas.id} not in ('L-core-001', 'L-core-002')`);
    await desk.registerAgent("agent-2", "claude-opus-5-5");
    const other = await desk.lease("agent-2");
    expect(other?.lemmaId).toBe("L-core-001");
    expect(other?.previousNotes.map((n) => n.notes)).toEqual(["try 1", "try 0"]);
  });

  it("expired leases are recovered and their open attempt is closed as timeout", async () => {
    let t = new Date("2026-01-01T00:00:00Z");
    const { desk, db } = await setup({ now: () => t, config: { LEASE_TTL_SECONDS: "300" } });
    await desk.registerAgent("agent-1", "claude-opus-5-5");
    await desk.lease("agent-1");
    const id = await desk.startAttempt("agent-1", "L-core-001");
    t = new Date("2026-01-01T00:04:00Z");
    await desk.heartbeat("agent-1", "L-core-001"); // extends to 00:09
    t = new Date("2026-01-01T00:10:00Z");
    expect(await desk.expireLeases()).toEqual(["L-core-001"]);
    expect((await db.select().from(attempts).where(eq(attempts.id, id)))[0]!.result).toBe("timeout");
    await expect(desk.heartbeat("agent-1", "L-core-001")).rejects.toBeInstanceOf(DeskError);
    // A model call that was in flight when the lease expired is still recorded (it was paid for).
    await desk.recordUsage(id, "agent-1", usage);
    expect((await db.select().from(attempts).where(eq(attempts.id, id)))[0]!.costUsd).toBe("0.014900");
    expect((await db.select().from(lemmas).where(eq(lemmas.id, "L-core-001")))[0]!.status).toBe("open");
  });

  it("fails closed when the judge image is stale", async () => {
    const { desk, judge } = await setup();
    judge.infoValue = { ...judge.infoValue, trustedSha: "0".repeat(64) };
    await desk.registerAgent("agent-1", "claude-opus-5-5");
    await expect(desk.lease("agent-1")).rejects.toThrow(/stale/);
  });
});

describe("imports of checked proofs", () => {
  async function checkLemma(desk: Awaited<ReturnType<typeof setup>>["desk"], agent: string, source: string) {
    const ctx = await desk.lease(agent);
    const id = await desk.startAttempt(agent, ctx!.lemmaId);
    return { lemmaId: ctx!.lemmaId, verdict: await desk.submit(id, agent, source, "") };
  }

  it("only checked lemmas can be imported, with their pinned source, in dependency order", async () => {
    const { desk, judge } = await setup();
    await desk.registerAgent("a", "claude-opus-5-5");
    // L-core-001 checked. L-core-002 imports it. L-core-003 imports L-core-002 (so transitively 001).
    await checkLemma(desk, "a", "-- PASS one");
    await checkLemma(desk, "a", "import Proofs.L_core_001\n-- PASS two");
    // A not-yet-checked lemma cannot be imported.
    const ctx = await desk.lease("a");
    const id = await desk.startAttempt("a", ctx!.lemmaId);
    await expect(desk.localCheck(id, "a", "import Proofs.L_core_004\n-- PASS")).rejects.toThrow(/only lemmas with status "checked"/);
    const v = await desk.submit(id, "a", "import Proofs.L_core_002\n-- PASS three", "");
    expect(v.verdict).toBe("pass");
    const last = judge.requests.at(-1)!;
    expect(last.deps).toEqual([
      { lemmaId: "L-core-001", source: "-- PASS one" },
      { lemmaId: "L-core-002", source: "import Proofs.L_core_001\n-- PASS two" },
    ]);
  });

  it("a changed statement marks its lemma and all dependents for re-check; re-checks run dependencies first", async () => {
    const leanDir = tempLeanDir();
    const { desk, db, judge, repo } = await setup({ leanDir });
    await desk.registerAgent("a", "claude-opus-5-5");
    await checkLemma(desk, "a", "-- PASS one");
    await checkLemma(desk, "a", "import Proofs.L_core_001\n-- PASS two");
    await checkLemma(desk, "a", "-- PASS three (independent)");
    expect(await desk.recheckScan()).toEqual([]);

    // Edit the statement of L-core-001 (e.g. a definition change). The judge image is rebuilt too.
    const f = join(leanDir, "Statements", "L_core_001.lean");
    writeFileSync(f, readFileSync(f, "utf8").replace("a + b = b + a", "b + a = a + b"));
    judge.infoValue = { ...judge.infoValue, trustedSha: repo.trustedSha() };
    await desk.syncStatements();
    expect((await desk.recheckScan()).sort()).toEqual(["L-core-001", "L-core-002"]);
    const status = async () => Object.fromEntries((await db.select().from(lemmas)).map((l) => [l.id, l.status]));
    expect(await status()).toMatchObject({ "L-core-001": "recheck", "L-core-002": "recheck", "L-core-003": "checked" });

    judge.requests = [];
    const r = await desk.runRechecks();
    expect(r).toEqual({ passed: ["L-core-001", "L-core-002"], failed: [] });
    expect(judge.requests.map((q) => q.lemmaId)).toEqual(["L-core-001", "L-core-002"]);
    expect(await desk.recheckScan()).toEqual([]);
  });

  it("if a re-check fails, its dependents lose their checked status too", async () => {
    const leanDir = tempLeanDir();
    const { desk, db, judge, repo } = await setup({ leanDir });
    await desk.registerAgent("a", "claude-opus-5-5");
    await checkLemma(desk, "a", "-- PASS one");
    await checkLemma(desk, "a", "import Proofs.L_core_001\n-- PASS two");
    const f = join(leanDir, "Statements", "L_core_001.lean");
    writeFileSync(f, readFileSync(f, "utf8") + "\n-- edited\n");
    judge.infoValue = { ...judge.infoValue, trustedSha: repo.trustedSha() };
    await desk.syncStatements();
    await desk.recheckScan();
    // Make L-core-001's pinned proof fail this time.
    await db.update(lemmas).set({ checkedSource: "now broken" }).where(eq(lemmas.id, "L-core-001"));
    const r = await desk.runRechecks();
    expect(r).toEqual({ passed: [], failed: ["L-core-001", "L-core-002"] });
    const rows = await db.select().from(lemmas);
    expect(rows.filter((l) => ["L-core-001", "L-core-002"].includes(l.id)).every((l) => l.status === "open" && l.checkedSource === null)).toBe(true);
    const failedEvents = await db.select().from(events).where(eq(events.type, "recheck_failed"));
    expect(failedEvents.map((e) => (e.payload as { reason: string }).reason)).toEqual(["compile_error", "a proof it imports is no longer checked"]);
    // Nothing is left half-checked.
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from lemmas where status = 'recheck'`)) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });
});

describe("Mathlib gate", () => {
  it("never leases Mathlib lemmas unless enabled AND the judge runs the full image", async () => {
    const leanDir = tempLeanDir();
    writeFileSync(join(leanDir, "Statements", "L_core_900.lean"), "-- program: core-warmup\n-- title: needs mathlib\nimport Mathlib.Data.Nat.Basic\ndef Statement.L_core_900 : Prop := True\n");
    for (const [enabled, flavor, expectLease] of [["0", "full", false], ["1", "lite", false], ["1", "full", true]] as const) {
      const { desk, db, judge, repo } = await setup({ leanDir, config: { MATHLIB_LEMMAS_ENABLED: enabled } });
      judge.infoValue = { flavor, trustedSha: repo.trustedSha(), leanVersion: "4.36.0" };
      await db.update(lemmas).set({ status: "checked" }).where(sql`${lemmas.id} <> 'L-core-900'`);
      await desk.registerAgent("a", "claude-opus-5-5");
      const ctx = await desk.lease("a");
      expect(ctx?.lemmaId ?? null, `enabled=${enabled} flavor=${flavor}`).toBe(expectLease ? "L-core-900" : null);
    }
  });
});

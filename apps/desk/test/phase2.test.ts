import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { events, lemmas, messages, modelCalls, programs, reuses } from "../src/db/schema.ts";
import { buildServer } from "../src/server.ts";
import { addInflow, freshDb, makeDesk, tempLeanDir, WORKER_TOKEN } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function setup(opts: Parameters<typeof makeDesk>[0] = {}) {
  const d = await makeDesk(opts);
  cleanups.push(d.cleanup);
  return d;
}
// 1000 in * $4 + 500 out * $20 (opus 5.5) = 14000 micro-dollars
const call = (model = "claude-opus-5-5") => ({ purpose: "prove" as const, parts: [{ model, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }] });
type D = Awaited<ReturnType<typeof setup>>["desk"];
async function failCheck(desk: D, judge: Awaited<ReturnType<typeof setup>>["judge"], agent: string, attemptId: number) {
  void judge;
  await desk.localCheck(attemptId, agent, "wrong");
}

describe("budget", () => {
  it("global cap = min(GLOBAL_DAILY_CAP_USD, pantry / RUNWAY_TARGET_DAYS); per-agent cap = global / active agents", async () => {
    const { desk } = await setup({ pantryUsd: 30, config: { GLOBAL_DAILY_CAP_USD: "100", RUNWAY_TARGET_DAYS: "30" } });
    for (const a of ["a", "b", "c"]) await desk.registerAgent(a, "claude-opus-5-5");
    const b = await desk.budget("a");
    expect(b).toMatchObject({ allowed: true, pantryUsd: "30.000000", globalCapUsd: "1.000000", perAgentCapUsd: "0.333333", activeAgents: 3 });
    const { desk: d2 } = await setup({ pantryUsd: 1_000_000, config: { GLOBAL_DAILY_CAP_USD: "5" } });
    await d2.registerAgent("a", "claude-opus-5-5");
    expect((await d2.budget("a")).globalCapUsd).toBe("5.000000");
  });

  it("an agent is refused exactly once its spend today reaches its cap", async () => {
    // pantry 0.84 / 30 days = 0.028 global; 2 agents -> 0.014 each = exactly one opus call.
    const { desk } = await setup({ pantryUsd: 0.84 });
    await desk.registerAgent("a", "claude-opus-5-5");
    await desk.registerAgent("b", "claude-opus-5-5");
    expect((await desk.budget("a")).perAgentCapUsd).toBe("0.014000");
    await desk.lease("a");
    const id = await desk.startAttempt("a", "L-core-001");
    expect((await desk.budget("a")).allowed).toBe(true);
    await desk.recordUsage(id, "a", call());
    const after = await desk.budget("a");
    expect(after).toMatchObject({ allowed: false, reason: "agent_cap", agentSpentUsd: "0.014000" });
    expect((await desk.budget("b")).allowed).toBe(true);
    await expect(desk.lease("b").then(() => desk.lease("a"))).rejects.toThrow(/agent_cap/);
  });

  it("pantry empty and global cap", async () => {
    const { desk, db } = await setup({ pantryUsd: 0 });
    await desk.registerAgent("a", "claude-opus-5-5");
    expect((await desk.budget("a")).reason).toBe("pantry_empty");
    await addInflow(db, 0.42); // 0.014 global
    await desk.registerAgent("b", "claude-opus-5-5");
    await desk.lease("a");
    const id = await desk.startAttempt("a", "L-core-001");
    await desk.recordUsage(id, "a", call());
    expect((await desk.budget("b")).reason).toBe("global_cap");
  });

  it("kill switch: env, admin endpoint (token required), shared through the DB", async () => {
    const { desk } = await setup({ config: { ADMIN_TOKEN: "admin-token-0123456789" } });
    await desk.registerAgent("agent-a", "claude-opus-5-5");
    const app = buildServer(desk);
    const post = (on: boolean, token = "admin-token-0123456789") =>
      app.inject({ method: "POST", url: "/admin/kill-switch", headers: { authorization: `Bearer ${token}` }, payload: { on, by: "test" } });
    expect((await post(true, "wrong-token-0123456789")).statusCode).toBe(401);
    expect((await post(true)).json()).toEqual({ on: true, source: "admin" });
    const b = await app.inject({ method: "GET", url: "/internal/budget?agentId=agent-a", headers: { authorization: `Bearer ${WORKER_TOKEN}` } });
    expect(b.json()).toMatchObject({ allowed: false, reason: "kill_switch" });
    expect((await post(false)).json()).toEqual({ on: false, source: null });
    expect((await desk.budget("agent-a")).allowed).toBe(true);
    const { desk: envDesk } = await setup({ config: { KILL_SWITCH: "1" } });
    expect((await envDesk.budget(null)).killSwitch).toEqual({ on: true, source: "env" });
    await app.close();
  });

  it("sleeping is reported once per transition", async () => {
    const { desk, db } = await setup();
    await desk.registerAgent("a", "claude-opus-5-5");
    expect(await desk.reportSleeping("a", "agent_cap")).toBe(true);
    expect(await desk.reportSleeping("a", "agent_cap")).toBe(false);
    expect(await desk.reportSleeping("a", "kill_switch")).toBe(true);
    const n = await db.select().from(events).where(eq(events.type, "sleeping"));
    expect(n.length).toBe(2);
  });
});

describe("no unbounded waits", () => {
  it("a lock wait fails fast with an error instead of hanging", async () => {
    const fresh = await freshDb({ statementTimeoutMs: 30_000, lockTimeoutMs: 300, idleInTransactionTimeoutMs: 60_000 });
    cleanups.push(fresh.cleanup);
    await fresh.db.insert(programs).values({ slug: "p", title: "p", description: "p" });
    const holder = postgres(fresh.url, { max: 1, onnotice: () => {} });
    try {
      // Another session holds a row lock and never commits (a stuck request).
      const tx = holder.begin(async (sq) => {
        await sq`select * from programs where slug = 'p' for update`;
        await new Promise((r) => setTimeout(r, 2000));
      });
      await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      await expect(fresh.db.update(programs).set({ title: "x" }).where(eq(programs.slug, "p"))).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(1500); // ~300 ms lock_timeout, not 2 s, not forever
      await tx;
    } finally {
      await holder.end();
    }
  });
});

describe("pricing by the model that served each part", () => {
  it("a fallback call is recorded as one row per part, each at its own model's price", async () => {
    const { desk, db } = await setup();
    await desk.registerAgent("a", "claude-fable-5-2");
    await desk.lease("a");
    const id = await desk.startAttempt("a", "L-core-001");
    const r = await desk.recordUsage(id, "a", {
      purpose: "prove",
      requestId: "req_1",
      parts: [
        // declined part on the requested model: 100 in * $8 + 10 out * $40 = 1200
        { model: "claude-fable-5-2", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        // rescue on the fallback model: 1000 in * $4 + 500 out * $20 = 14000
        { model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, servedByFallback: true },
      ],
    });
    expect(r.costUsd).toBe("0.015200");
    const rows = await db.select().from(modelCalls).orderBy(modelCalls.part);
    expect(rows.map((x) => [x.part, x.model, x.costUsd, x.servedByFallback, x.requestId])).toEqual([
      [0, "claude-fable-5-2", "0.001200", false, "req_1"],
      [1, "claude-opus-5-5", "0.014000", true, "req_1"],
    ]);
    const [ev] = await db.select().from(events).where(eq(events.type, "model_call"));
    expect(ev!.payload).toMatchObject({ models: ["claude-fable-5-2", "claude-opus-5-5"], fallbackUsed: true, costUsd: "0.015200" });
  });
});

describe("collaboration", () => {
  it("questions: only after 3 failures in a row, once per lease, routed to related agents first, then same program", async () => {
    const { desk, db, judge } = await setup({ config: { MAX_QUESTIONS_PER_HOUR: "5" } });
    for (const a of ["asker", "helper", "other", "far"]) await desk.registerAgent(a, "claude-opus-5-5");
    // helper checked L-core-002 (statement shares words with L-core-003: List, Nat, xs...)
    await desk.lease("helper"); // L-core-001
    let hid = await desk.startAttempt("helper", "L-core-001");
    await desk.submit(hid, "helper", "-- PASS", "");
    const h2 = await desk.lease("helper");
    hid = await desk.startAttempt("helper", h2!.lemmaId);
    await desk.submit(hid, "helper", "-- PASS", "");
    expect(h2!.lemmaId).toBe("L-core-002");
    await desk.lease("other"); // L-core-003: "other" camps in core-warmup and holds a lease
    const ctx = await desk.lease("asker"); // L-core-004
    expect(ctx!.lemmaId).toBe("L-core-004");
    const id = await desk.startAttempt("asker", "L-core-004");
    await expect(desk.ask("asker", id, "why?", "why?")).rejects.toThrow(/after 3 failed checks in a row \(you have 0\)/);
    for (let i = 0; i < 3; i++) await failCheck(desk, judge, "asker", id);
    expect(await desk.consecutiveFailures("asker", "L-core-004")).toBe(3);
    const q = await desk.ask("asker", id, "cases on a b then rfl fails at the || case; which lemma?", "stuck on Bool De Morgan");
    expect(q.routedTo).toEqual(["helper", "other"]); // "far" has never camped in core-warmup
    await expect(desk.ask("asker", id, "again", "again")).rejects.toThrow(/already asked/);
    expect(await desk.awaitingReply("asker", "L-core-004")).toBe(true);

    const inbox = await desk.inbox("helper");
    expect(inbox).toMatchObject([{ questionId: q.questionId, fromAgent: "asker", lemmaId: "L-core-004" }]);
    expect(await desk.inbox("far")).toEqual([]);
    const r = await desk.reply("helper", q.questionId, {
      kind: "hint", body: "Try `cases a <;> cases b <;> rfl` after intro a b.", short: "cases a, cases b, rfl",
      parts: [{ model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    });
    expect(r.costUsd).toBe("0.014000");
    await expect(desk.reply("helper", q.questionId, { kind: "reply", body: "x", short: "x", parts: call().parts })).rejects.toThrow(/already replied/);
    await expect(desk.reply("far", q.questionId, { kind: "reply", body: "x", short: "x", parts: call().parts })).rejects.toThrow(/no such question/);
    expect(await desk.inbox("helper")).toEqual([]);

    const got = await desk.takeReplies("asker", "L-core-004", id);
    expect(got).toMatchObject([{ fromAgent: "helper", kind: "hint", questionId: q.questionId }]);
    expect(await desk.takeReplies("asker", "L-core-004", id)).toEqual([]); // delivered once
    const [m] = await db.select().from(messages).where(eq(messages.id, got[0]!.id));
    expect(m).toMatchObject({ deliveredInAttempt: id, costUsd: "0.014000", toAgent: "asker", replyTo: q.questionId });
    expect((await db.select().from(modelCalls).where(eq(modelCalls.purpose, "reply"))).length).toBe(1);
  });

  it("message limits: replies per hour", async () => {
    const { desk } = await setup({ config: { MAX_REPLIES_PER_HOUR: "0" } });
    await desk.registerAgent("a", "claude-opus-5-5");
    expect(await desk.canReply("a")).toEqual({ ok: false, reason: "reply_limit" });
  });

  it("handoff: the lemma is offered first to an idle teammate, with the note", async () => {
    const { desk, db } = await setup({ config: { AGENT_MAX_ATTEMPTS_PER_LEMMA: "1" } });
    for (const a of ["giver", "idle-mate", "busy"]) await desk.registerAgent(a, "claude-opus-5-5");
    // idle-mate camps in core-warmup: lease something, finish it.
    await desk.lease("idle-mate");
    const iid = await desk.startAttempt("idle-mate", "L-core-001");
    await desk.submit(iid, "idle-mate", "-- PASS", "");
    await desk.lease("giver"); // L-core-002
    const gid = await desk.startAttempt("giver", "L-core-002");
    await desk.submit(gid, "giver", "wrong", "tried simp");
    await desk.lease("busy"); // takes L-core-003; busy holds a lease, so it is not idle
    const out = await desk.release("giver", "L-core-002", "gave up", true, {
      body: "Tried simp and induction; stuck on List.length_append name.", short: "handing over List append",
      note: "Approaches: simp, induction xs.\nErrors: unknown identifier.\nBest partial proof:\nimport Statements.L_core_002\n...",
    });
    expect(out.offeredTo).toBe("idle-mate");
    // Someone else can't take it while it is offered.
    const busyRelease = await desk.release("busy", "L-core-003", "", false);
    expect(busyRelease.offeredTo).toBeNull();
    const busyNext = await desk.lease("busy");
    expect(busyNext!.lemmaId).not.toBe("L-core-002");
    const mateCtx = await desk.lease("idle-mate");
    expect(mateCtx).toMatchObject({ lemmaId: "L-core-002", offeredToMe: true });
    expect(mateCtx!.handoffNote).toContain("Best partial proof");
    const [h] = await db.select().from(messages).where(eq(messages.kind, "handoff"));
    expect(h).toMatchObject({ fromAgent: "giver", toAgent: "idle-mate", short: "handing over List append" });
    expect((await db.select().from(events).where(eq(events.type, "handoff"))).length).toBe(1);
  });

  it("reuse: checked lemmas are searchable and every reuse is recorded", async () => {
    const { desk, db } = await setup();
    await desk.registerAgent("a", "claude-opus-5-5");
    await desk.lease("a");
    let id = await desk.startAttempt("a", "L-core-001");
    await desk.submit(id, "a", "-- PASS", "");
    const found = await desk.searchChecked("comm addition b + a");
    expect(found[0]).toMatchObject({ id: "L-core-001", importAs: "Proofs.L_core_001", theorem: "Proof.L_core_001" });
    await desk.lease("a");
    id = await desk.startAttempt("a", "L-core-002");
    await desk.submit(id, "a", "import Proofs.L_core_001\n-- PASS", "");
    expect(await db.select({ l: reuses.lemmaId, r: reuses.reusedLemmaId }).from(reuses)).toEqual([{ l: "L-core-002", r: "L-core-001" }]);
    expect((await db.select().from(events).where(eq(events.type, "lemma_reused"))).length).toBe(1);
  });

  it("colony state lists who works on what", async () => {
    const { desk } = await setup();
    await desk.registerAgent("a", "claude-opus-5-5");
    await desk.registerAgent("b", "claude-opus-5-5");
    await desk.lease("a");
    await desk.reportSleeping("b", "agent_cap");
    const c = await desk.colony();
    expect(c.agents).toMatchObject([
      { id: "a", status: "working", lemmaId: "L-core-001", program: "core-warmup" },
      { id: "b", status: "sleeping", lemmaId: null },
    ]);
  });
});

describe("accepted proofs are committed to lean/Proofs/", () => {
  function gitRepo() {
    const root = tempLeanDir(); // a copy of lean/ that becomes its own repo
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
    return { root, git };
  }

  it("commits only the proof file, with the bot identity; the commit becomes the pinned commit", async () => {
    const { root, git } = gitRepo();
    const { desk, db } = await setup({ leanDir: root, config: { PROOF_COMMIT_MODE: "commit", GIT_COMMIT: "" } });
    // Unrelated work in progress in the checkout must not be swept into the bot commit.
    writeFileSync(join(root, "Judge", "Main.lean"), readFileSync(join(root, "Judge", "Main.lean"), "utf8") + "\n-- wip\n");
    writeFileSync(join(root, "notes.txt"), "staged wip\n");
    git("add", "notes.txt");
    await desk.registerAgent("a", "claude-opus-5-5");
    await desk.lease("a");
    const id = await desk.startAttempt("a", "L-core-001");
    const src = "import Statements.L_core_001\ntheorem Proof.L_core_001 : Statement.L_core_001 := fun a b => Nat.add_comm a b -- PASS\n";
    await desk.submit(id, "a", src, "");
    expect(readFileSync(join(root, "Proofs", "L_core_001.lean"), "utf8")).toBe(src);
    const head = git("rev-parse", "HEAD");
    expect(git("show", "--name-only", "--format=%an <%ae>|%s", "HEAD").split("\n").filter(Boolean)).toEqual([
      "Hatchery Judge <judge@hatchery.invalid>|proof: L_core_001 checked",
      "Proofs/L_core_001.lean",
    ]);
    expect(git("diff", "--cached", "--name-only")).toBe("notes.txt"); // still staged, not committed
    expect(git("diff", "--name-only")).toBe("Judge/Main.lean"); // still unstaged
    const [l] = await db.select().from(lemmas).where(eq(lemmas.id, "L-core-001"));
    expect(l!.checkedCommit).toBe(head);
    expect(await db.select().from(events).where(eq(events.type, "proof_committed"))).toHaveLength(1);
  });

  it("a failed re-check removes the file in a commit; reconcile repairs drift", async () => {
    const { root, git } = gitRepo();
    const { desk, db, judge, repo } = await setup({ leanDir: root, config: { PROOF_COMMIT_MODE: "commit", GIT_COMMIT: "" } });
    await desk.registerAgent("a", "claude-opus-5-5");
    await desk.lease("a");
    const id = await desk.startAttempt("a", "L-core-001");
    await desk.submit(id, "a", "-- PASS one", "");
    // statement changes; pinned proof now fails
    const f = join(root, "Statements", "L_core_001.lean");
    writeFileSync(f, readFileSync(f, "utf8") + "\n-- edited\n");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "edit statement");
    judge.infoValue = { ...judge.infoValue, trustedSha: repo.trustedSha() };
    await desk.syncStatements();
    await desk.recheckScan();
    await db.update(lemmas).set({ checkedSource: "now broken" }).where(eq(lemmas.id, "L-core-001"));
    expect(await desk.runRechecks()).toEqual({ passed: [], failed: ["L-core-001"] });
    expect(existsSync(join(root, "Proofs", "L_core_001.lean"))).toBe(false);
    expect(git("log", "-1", "--format=%s")).toMatch(/^proof: remove L_core_001 \(re-check failed/);

    // Drift: a checked lemma whose file is missing (crash between DB update and commit).
    await desk.lease("a");
    const id2 = await desk.startAttempt("a", "L-core-002");
    await desk.submit(id2, "a", "-- PASS two", "");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "rm", "-q", "Proofs/L_core_002.lean");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "oops");
    expect(await desk.reconcileProofs()).toEqual({ written: ["L_core_002"], removed: [] });
    expect(readFileSync(join(root, "Proofs", "L_core_002.lean"), "utf8")).toBe("-- PASS two");
    expect(git("status", "--porcelain", "--", "Proofs")).toBe("");
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from lemmas where status = 'checked'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
    void and;
  });
});

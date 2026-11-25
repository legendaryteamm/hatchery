import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { events, lemmas } from "../src/db/schema.ts";
import { buildServer } from "../src/server.ts";
import { agentCard, colonySnapshot, feed, graveyard, pantrySummary } from "../src/views.ts";
import { makeDesk } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function setup(opts: Parameters<typeof makeDesk>[0] = {}) {
  const d = await makeDesk(opts);
  cleanups.push(d.cleanup);
  return d;
}
const part = (n = 1) => ({ model: "claude-opus-5-5", inputTokens: 1000 * n, outputTokens: 500 * n, cacheReadTokens: 0, cacheWriteTokens: 0 });

describe("colony snapshot (everything from the database)", () => {
  it("agents, food bars, heartbeats, sleep, program counts, pantry", async () => {
    let t = new Date("2026-03-02T12:00:00Z");
    // pantry 30 USD -> global 1/day; 2 agents -> 0.5 each
    const { desk, db } = await setup({ now: () => t, pantryUsd: 30 });
    await desk.registerAgent("agent-a", "claude-opus-5-5");
    await desk.registerAgent("agent-b", "claude-opus-5-5");
    const ctx = await desk.lease("agent-a");
    const id = await desk.startAttempt("agent-a", ctx!.lemmaId);
    await desk.recordUsage(id, "agent-a", { purpose: "prove", parts: [part(10)] }); // 0.14 USD
    await desk.reportSleeping("agent-b", "agent_cap");

    let s = await colonySnapshot(desk);
    const a = s.agents.find((x) => x.id === "agent-a")!;
    const b = s.agents.find((x) => x.id === "agent-b")!;
    expect(a).toMatchObject({ lemmaId: "L-core-001", program: "core-warmup", camp: "core-warmup", heartbeatFresh: true, sleeping: false, spentTodayUsd: "0.140000", level: 1, active: true });
    expect(a.food).toBeCloseTo((0.5 - 0.14) / 0.5, 5);
    expect(b).toMatchObject({ sleeping: true, sleepReason: "agent_cap", lemmaId: null, food: 1 });
    expect(s.totals).toEqual({ checked: 0, lemmas: 15, awake: 1 }); // 5 core + 10 sanity lemmas
    expect(s.programs.find((p) => p.slug === "core-warmup")).toMatchObject({ checked: 0, total: 5 });
    expect(s.programs.find((p) => p.slug === "circuit-lower-bounds")).toMatchObject({ checked: 0, total: 0 }); // nothing approved yet
    expect(s.asOfEventId).toBe((await db.select().from(events)).at(-1)!.id);

    // 3 minutes later the heartbeat is stale: no thinking dots.
    t = new Date("2026-03-02T12:03:00Z");
    s = await colonySnapshot(desk);
    expect(s.agents.find((x) => x.id === "agent-a")!.heartbeatFresh).toBe(false);
    // A model call after sleeping = awake again.
    await desk.lease("agent-b");
    s = await colonySnapshot(desk);
    expect(s.agents.find((x) => x.id === "agent-b")!.sleeping).toBe(false);
  });

  it("runway and the hungry flag come from real spend", async () => {
    const { desk } = await setup({ pantryUsd: 0.5 });
    await desk.registerAgent("agent-a", "claude-opus-5-5");
    expect((await pantrySummary(desk)).runwayDays).toBeNull(); // nothing spent: no pace to project
    const ctx = await desk.lease("agent-a");
    const id = await desk.startAttempt("agent-a", ctx!.lemmaId);
    await desk.recordUsage(id, "agent-a", { purpose: "prove", parts: [part(10)] }); // 0.14 spent today
    const p = await pantrySummary(desk);
    expect(p).toMatchObject({ pantryUsd: "0.360000", inflowsUsd: "0.500000", apiSpendUsd: "0.140000", dailySpendUsd: "0.140000", hungry: true });
    expect(p.runwayDays).toBeCloseTo(2.6, 1);
    expect(p.recentInflows).toHaveLength(1);
  });

  it("a pantry inflow is an event (the pets run to the bowl)", async () => {
    const { desk, db } = await setup();
    await desk.recordInflow({ txHash: "mock-1", chain: "mock", amountNative: "40", amountUsd: "40.000000", usdRateSource: "test", ts: new Date() });
    const ev = (await db.select().from(events).where(eq(events.type, "pantry_inflow"))).at(-1);
    expect(ev!.payload).toMatchObject({ amountUsd: "40.000000", chain: "mock" });
  });
});

describe("feed, pet card, graveyard", () => {
  it("feed carries names and message text, and leaves out model-call noise", async () => {
    const { desk, review } = await (async () => {
      const d = await setup({ config: { AGENT_MAX_ATTEMPTS_PER_LEMMA: "1" } });
      return { ...d, review: null };
    })();
    void review;
    await desk.registerAgent("agent-a", "claude-opus-5-5");
    await desk.registerAgent("agent-b", "claude-opus-5-5");
    await desk.lease("agent-b"); // b camps in core-warmup
    await desk.release("agent-b", "L-core-001", "", false);
    const ctx = await desk.lease("agent-a");
    const id = await desk.startAttempt("agent-a", ctx!.lemmaId);
    await desk.recordUsage(id, "agent-a", { purpose: "prove", parts: [part()] });
    for (let i = 0; i < 3; i++) await desk.localCheck(id, "agent-a", "wrong");
    const q = await desk.ask("agent-a", id, "rfl fails everywhere", "rfl keeps failing");
    await desk.reply("agent-b", q.questionId, { kind: "hint", body: "Use decide.", short: "try decide", parts: [part()] });
    const items = await feed(desk, { limit: 100 });
    expect(items.some((i) => i.type === "model_call")).toBe(false);
    const asked = items.find((i) => i.type === "question_asked")!;
    expect(asked).toMatchObject({ agentId: "agent-a", message: { short: "rfl keeps failing", kind: "question" } });
    const replied = items.find((i) => i.type === "reply_posted")!;
    expect(replied.message).toMatchObject({ short: "try decide", body: "Use decide.", toAgent: "agent-a" });
    expect(replied.agentName).toMatch(/^[A-Z]/);
    // newest first, and paging
    expect(items[0]!.id).toBeGreaterThan(items[1]!.id);
    expect((await feed(desk, { before: items[0]!.id, limit: 1 }))[0]!.id).toBe(items[1]!.id);

    const card = await agentCard(desk, "agent-a");
    expect(card).toMatchObject({ lemmaId: "L-core-001", lemma: { id: "L-core-001" }, attemptsToday: 1, notesShared: 1 });
    expect(card!.recentMessages.map((m) => m.kind).sort()).toEqual(["hint", "question"]);
    expect(await agentCard(desk, "agent-nope")).toBeNull();
  });

  it("graveyard lists abandoned lemmas, rejected statements and failed attempts", async () => {
    const { desk, db } = await setup({ config: { AGENT_MAX_ATTEMPTS_PER_LEMMA: "1", LEMMA_ABANDON_AFTER_ATTEMPTS: "1" } });
    await desk.registerAgent("agent-a", "claude-opus-5-5");
    const ctx = await desk.lease("agent-a");
    const id = await desk.startAttempt("agent-a", ctx!.lemmaId);
    await desk.submit(id, "agent-a", "wrong", "rfl");
    await desk.release("agent-a", ctx!.lemmaId, "gave up", true);
    expect((await db.select().from(lemmas).where(eq(lemmas.id, ctx!.lemmaId)))[0]!.status).toBe("abandoned");
    const g = await graveyard(desk);
    expect(g.lemmas.map((l) => [l.id, l.status])).toEqual([["L-core-001", "abandoned"]]);
    expect(g.failedAttempts[0]).toMatchObject({ lemmaId: "L-core-001", agentId: "agent-a", judgeErrors: "compile_error: fake failure" });
    expect(g.failedAttemptsTotal).toBe(1);
  });
});

describe("public endpoints are rate limited; workers and reviewers are not", () => {
  it("429 after the per-minute limit on public routes; token routes are not counted", async () => {
    const { desk } = await setup({ config: { RATE_LIMIT_PER_MINUTE: "3" } });
    const app = buildServer(desk);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: "GET", url: "/programs" })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    // Internal routes (token) are not counted.
    const internal = [];
    for (let i = 0; i < 5; i++) internal.push((await app.inject({ method: "GET", url: "/internal/colony?agentId=agent-x" })).statusCode);
    expect(internal.every((c) => c === 401)).toBe(true);
    await app.close();
  });
});

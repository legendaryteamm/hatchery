/**
 * Phase 2 acceptance with a scripted model (no API calls, no cost):
 *  - with a tiny cap, agents go to sleep exactly when the cap is reached;
 *  - the kill switch stops every agent within one loop iteration;
 *  - a stuck agent's question is routed, answered, and used in its next attempt;
 *  - handoffs, reuse, lease expiry and recovery.
 * Real desk + Postgres over HTTP; judge stand-in (passes iff the source contains "-- PASS").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import * as s from "../../desk/src/db/schema.ts";
import { WORKER_TOKEN } from "../../desk/test/helpers.ts";
import { CALL_MICROS, call, FakeProvider, text } from "./fake-provider.ts";
import { ADMIN_TOKEN, makeAgent, startDesk, until } from "./harness.ts";

// Every test here is event-driven and takes about a second. Anything slower is a bug: fail fast.
vi.setConfig({ testTimeout: 60_000 });

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});
async function desk(opts: Parameters<typeof startDesk>[0] = {}) {
  const d = await startDesk(opts);
  stops.push(d.stop);
  return d;
}
const wrong = (leanName: string) => `import Statements.${leanName}\ntheorem Proof.${leanName} : Statement.${leanName} := by rfl\n`;
const right = (leanName: string) => `import Statements.${leanName}\ntheorem Proof.${leanName} : Statement.${leanName} := by decide -- PASS\n`;
const neverProves = new FakeProvider(({ leanName }) => [call("lean_check", { source: wrong(leanName) })]);
const micros = (usd: string) => Math.round(Number(usd) * 1e6);

async function eventsOf(db: Awaited<ReturnType<typeof desk>>["db"], agentId: string) {
  return db.select().from(s.events).where(eq(s.events.agentId, agentId)).orderBy(asc(s.events.id));
}

describe("budget", () => {
  it("with a tiny cap every agent sleeps exactly when its cap is reached", async () => {
    // 3 agents x 3 calls x 2780 = 25020 micro-dollars per day; pantry = that x 30 runway days.
    const { db, desk: d, url } = await desk({ pantryUsd: (3 * 3 * CALL_MICROS * 30) / 1e6, config: { RUNWAY_TARGET_DAYS: "30" } });
    const ids = ["agent-a", "agent-b", "agent-c"];
    for (const id of ids) await d.registerAgent(id, "fake-model"); // all active before anyone spends
    let stop = false;
    const runs = ids.map((id) => makeAgent(url, id, neverProves, { maxTurns: 50, shouldStop: () => stop }).agent.run());
    await until(async () => (await db.select().from(s.events).where(eq(s.events.type, "sleeping"))).length >= 3, 30_000, "3 sleeping agents");
    stop = true;
    await Promise.all(runs);

    const budget = await d.budget(null);
    expect(budget.perAgentCapUsd).toBe("0.008340");
    for (const id of ids) {
      const calls = await db.select().from(s.modelCalls).where(eq(s.modelCalls.agentId, id));
      expect(calls.length, id).toBe(3);
      expect(micros(await d.spentSince(id, new Date(0)))).toBe(3 * CALL_MICROS); // == cap, exactly
      const ev = await eventsOf(db, id);
      const sleepIdx = ev.findIndex((e) => e.type === "sleeping");
      expect(ev[sleepIdx]!.payload).toMatchObject({ reason: "agent_cap", agentSpentUsd: "0.008340", perAgentCapUsd: "0.008340" });
      expect(ev.slice(sleepIdx).filter((e) => e.type === "model_call"), `${id}: no calls after sleeping`).toEqual([]);
      // The attempt was paused (not counted as a failure) and the lemma given back.
      const [att] = await db.select().from(s.attempts).where(eq(s.attempts.agentId, id));
      expect(att).toMatchObject({ result: "timeout", notes: "paused: agent_cap", turns: 3 });
    }
    expect(await db.select().from(s.leases)).toEqual([]);
    expect(micros(budget.globalSpentUsd)).toBe(9 * CALL_MICROS);
  });

  it("the kill switch stops all agents within one loop iteration", async () => {
    const { db, url } = await desk();
    const slow = new FakeProvider(({ leanName }) => [call("lean_check", { source: wrong(leanName) })], 40);
    const ids = ["agent-a", "agent-b", "agent-c"];
    let stop = false;
    const runs = ids.map((id) => makeAgent(url, id, slow, { maxTurns: 1000, shouldStop: () => stop }).agent.run());
    await until(async () => (await db.select().from(s.modelCalls)).length >= 9, 30_000, "some work");
    const res = await fetch(`${url}/admin/kill-switch`, {
      method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ on: true, by: "test" }),
    });
    expect(await res.json()).toEqual({ on: true, source: "admin" });
    const [kill] = await db.select().from(s.events).where(eq(s.events.type, "kill_switch"));
    await until(async () => (await db.select().from(s.events).where(and(eq(s.events.type, "sleeping"), sql`${s.events.id} > ${kill!.id}`))).length >= 3, 30_000, "all asleep");
    const callsAtSleep = (await db.select().from(s.modelCalls)).length;
    await new Promise((r) => setTimeout(r, 300)); // they keep polling but must not call the model
    stop = true;
    await Promise.all(runs);
    for (const id of ids) {
      const after = (await eventsOf(db, id)).filter((e) => e.id > kill!.id);
      // At most the one call that was already in flight when the switch flipped.
      expect(after.filter((e) => e.type === "model_call").length, id).toBeLessThanOrEqual(1);
      expect(after.find((e) => e.type === "sleeping")!.payload).toMatchObject({ reason: "kill_switch" });
    }
    expect((await db.select().from(s.modelCalls)).length).toBe(callsAtSleep);
    // Unauthenticated callers cannot flip it.
    expect((await fetch(`${url}/admin/kill-switch`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${WORKER_TOKEN}` }, body: "{}" })).status).toBe(401);
  });
});

describe("collaboration", () => {
  it("a stuck agent's question is routed, answered, and used in its next attempt", async () => {
    const { db, url, desk: d } = await desk({ config: { AGENT_MAX_ATTEMPTS_PER_LEMMA: "3" } });
    // helper: proves anything it leases, and answers questions with a concrete hint.
    const helperModel = new FakeProvider(({ purpose, leanName }) =>
      purpose === "reply"
        ? [text("HINT: append the comment marker `-- PASS` to your proof line. Worked for me on the list lemmas.")]
        : [call("submit_proof", { source: right(leanName), notes: "decide" })],
    );
    // asker: fails 3 checks, asks, gives up the attempt; uses the hint once it has one.
    const askerModel = new FakeProvider(({ leanName, turn, transcript }) => {
      if (transcript.includes("Teammate") && transcript.includes("-- PASS")) {
        return [call("submit_proof", { source: right(leanName), notes: "teammate hint" })];
      }
      if (turn < 3) return [call("lean_check", { source: wrong(leanName) })];
      if (turn === 3) return [call("ask_teammates", { question: "rfl fails on every variant I try; is there a lemma for this?", short: "rfl keeps failing" })];
      return [call("submit_proof", { source: wrong(leanName), notes: "rfl again" })];
    });
    let stop = false;
    // Only L-core-001 is open: the asker gets it; the helper is an idle teammate camping in core-warmup.
    await db.update(s.lemmas).set({ status: "checked" }).where(sql`${s.lemmas.id} <> 'L-core-001'`);
    await d.registerAgent("agent-helper", "fake-model");
    await db.insert(s.events).values({ type: "leased", agentId: "agent-helper", lemmaId: "L-core-002", payload: {} });
    const asker = makeAgent(url, "agent-asker", askerModel, { maxLemmas: 1, shouldStop: () => stop });
    const askerRun = asker.agent.run();
    await until(async () => (await db.select().from(s.leases)).length === 1, 10_000, "asker lease");
    const helper = makeAgent(url, "agent-helper", helperModel, { exitWhenIdle: false, shouldStop: () => stop });
    const helperRun = helper.agent.run();
    const askerResult = await askerRun;
    stop = true;
    await helperRun;

    const [q] = await db.select().from(s.messages).where(eq(s.messages.kind, "question"));
    expect(q).toMatchObject({ fromAgent: "agent-asker", routedTo: ["agent-helper"], short: "rfl keeps failing" });
    const [r] = await db.select().from(s.messages).where(eq(s.messages.replyTo, q!.id));
    expect(r).toMatchObject({ fromAgent: "agent-helper", toAgent: "agent-asker", kind: "hint", costUsd: "0.002780" });
    const askerAttempts = await db.select().from(s.attempts).where(eq(s.attempts.agentId, "agent-asker")).orderBy(asc(s.attempts.id));
    expect(askerAttempts.map((a) => a.result)).toEqual(["failed", "checked"]);
    expect(r!.deliveredInAttempt).toBe(askerAttempts[1]!.id); // delivered into the NEXT attempt...
    expect(askerResult.checked).toEqual([q!.lemmaId]); // ...which proved the lemma with it
    const replyCalls = await db.select().from(s.modelCalls).where(eq(s.modelCalls.purpose, "reply"));
    expect(replyCalls.map((c) => c.agentId)).toEqual(["agent-helper"]);
    const types = (await db.select().from(s.events)).map((e) => e.type);
    for (const t of ["question_asked", "reply_posted", "reply_delivered"]) expect(types).toContain(t);
  });

  it("handoff: after max attempts the lemma goes first to an idle teammate, with the note", async () => {
    const { db, desk: d, url } = await desk({ config: { AGENT_MAX_ATTEMPTS_PER_LEMMA: "2" } });
    // Only L-core-001 is open, so the teammate is idle while the giver works.
    await db.update(s.lemmas).set({ status: "checked" }).where(sql`${s.lemmas.id} <> 'L-core-001'`);
    await d.registerAgent("agent-mate", "fake-model");
    // "mate" camps in core-warmup (a past lease) and is live, idle.
    await db.insert(s.events).values({ type: "leased", agentId: "agent-mate", lemmaId: "L-core-002", payload: {} });
    const giver = makeAgent(url, "agent-giver", new FakeProvider(({ leanName, turn }) =>
      turn === 0 ? [call("lean_check", { source: wrong(leanName) })] : [call("submit_proof", { source: wrong(leanName), notes: "rfl" })]));
    await giver.agent.run();
    const [h] = await db.select().from(s.messages).where(eq(s.messages.kind, "handoff"));
    expect(h).toMatchObject({ fromAgent: "agent-giver", toAgent: "agent-mate", short: "Handing over L-core-001" });
    const [l] = await db.select().from(s.lemmas).where(eq(s.lemmas.id, "L-core-001"));
    expect(l!.offeredTo).toBe("agent-mate");
    expect(l!.handoffNote).toContain("Best partial proof:\nimport Statements.L_core_001");
    let sawNote = false;
    const mate = makeAgent(url, "agent-mate", new FakeProvider(({ leanName, transcript }) => {
      sawNote ||= transcript.includes("Handoff note from the previous agent (they offered this lemma to you)");
      return [call("submit_proof", { source: right(leanName), notes: "after handoff" })];
    }));
    expect((await mate.agent.run()).checked).toEqual(["L-core-001"]);
    expect(sawNote).toBe(true);
    const leased = (await db.select().from(s.events).where(and(eq(s.events.type, "leased"), eq(s.events.agentId, "agent-mate")))).at(-1);
    expect(leased!.payload).toMatchObject({ viaHandoff: true });
  });

  it("reuse: an agent finds a checked lemma, imports it, and the reuse is recorded", async () => {
    const { db, url } = await desk();
    await db.update(s.lemmas).set({ status: "checked", checkedSource: "-- PASS base", checkedSourceSha256: "x", checkedByAgent: "someone" }).where(eq(s.lemmas.id, "L-core-001"));
    await db.update(s.lemmas).set({ status: "checked" }).where(sql`${s.lemmas.id} in ('L-core-003','L-core-004','L-core-005')`);
    let found = "";
    const a = makeAgent(url, "agent-reuser", new FakeProvider(({ leanName, turn, lastResult }) => {
      if (turn === 0) return [call("search_checked", { query: "addition comm" })];
      found ||= lastResult;
      return [call("submit_proof", { source: `import Proofs.L_core_001\n${right(leanName)}`, notes: "reused L-core-001" })];
    }));
    expect((await a.agent.run()).checked).toEqual(["L-core-002"]);
    expect(found).toContain('"importAs": "Proofs.L_core_001"');
    expect(await db.select({ l: s.reuses.lemmaId, r: s.reuses.reusedLemmaId, a: s.reuses.agentId }).from(s.reuses)).toEqual([{ l: "L-core-002", r: "L-core-001", a: "agent-reuser" }]);
  });
});

describe("judge infrastructure errors", () => {
  it("are retried and never recorded as the agent's failed attempt", async () => {
    const { db, url, judge } = await desk();
    await db.update(s.lemmas).set({ status: "checked" }).where(sql`${s.lemmas.id} <> 'L-core-001'`);
    const fake = judge as unknown as { check: (r: Parameters<typeof judge.check>[0]) => ReturnType<typeof judge.check> };
    const real = fake.check.bind(judge);
    let flaky = 2; // the first lean_check and the first submit hit a broken runner
    fake.check = async (req) => {
      const v = await real(req);
      if (flaky-- > 0) return { ...v, verdict: "fail", stage: "compile", reasons: [{ code: "runner_error", message: "compile container exited with null" }] };
      return v;
    };
    let sawRetryHint = false;
    const a = makeAgent(url, "agent-a", new FakeProvider(({ leanName, turn, lastResult }) => {
      sawRetryHint ||= lastResult.includes("infrastructure error (not your proof)");
      return turn === 0 ? [call("lean_check", { source: right(leanName) })] : [call("submit_proof", { source: right(leanName), notes: "" })];
    }));
    // (the DeskClient retries a 503 submit with backoff; keep it quick in tests)
    expect((await a.agent.run()).checked).toEqual(["L-core-001"]);
    expect(sawRetryHint).toBe(true);
    const att = await db.select().from(s.attempts);
    expect(att.map((x) => x.result)).toEqual(["checked"]); // no "failed" attempt from the outage
    expect(await db.select().from(s.events).where(eq(s.events.type, "judge_rejected"))).toEqual([]);
  });
});

describe("fleet: lease expiry and recovery", () => {
  it("a hung agent loses its lease; the lemma is recovered by another agent and the hung agent moves on", async () => {
    // Deterministic: the desk runs on an injected clock, and the "hang" is a gate the test opens.
    // No wall-clock sleeps, so a slow or suspended machine cannot change the outcome.
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const { db, url } = await desk({ config: { LEASE_TTL_SECONDS: "60" }, now: () => new Date(clock) });
    await db.update(s.lemmas).set({ status: "checked" }).where(sql`${s.lemmas.id} not in ('L-core-001','L-core-002')`);
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    let calls = 0;
    const proves = new FakeProvider(({ leanName }) => [call("submit_proof", { source: right(leanName), notes: "" })]);
    const hangsOnce = {
      model: "fake-model",
      async call(...args: Parameters<FakeProvider["call"]>) {
        if (calls++ === 0) await gate; // the first call "hangs" until the test lets it go
        return proves.call(...args);
      },
    };
    const a = makeAgent(url, "agent-slow", hangsOnce);
    const runA = a.agent.run();
    await until(async () => calls === 1, 10_000, "agent-slow inside its model call");
    expect((await db.select().from(s.leases)).map((l) => [l.holder, l.lemmaId])).toEqual([["agent-slow", "L-core-001"]]);

    clock += 61_000; // the desk's clock passes the 60 s lease: agent-slow missed its heartbeat
    const b = makeAgent(url, "agent-fast", new FakeProvider(({ leanName }) => [call("submit_proof", { source: right(leanName), notes: "" })]));
    const resB = await b.agent.run();
    expect(resB.checked.sort()).toEqual(["L-core-001", "L-core-002"]); // L-core-001 recovered from the expired lease

    openGate(); // the hung call finally returns
    const resA = await runA;
    expect(resA.checked).toEqual([]);
    expect(a.logs).toContain("lease on L-core-001 lost; moving on");
    const expired = await db.select().from(s.events).where(eq(s.events.type, "lease_expired"));
    expect(expired.map((e) => [e.agentId, e.lemmaId])).toEqual([["agent-slow", "L-core-001"]]);
    const [slowAttempt] = await db.select().from(s.attempts).where(eq(s.attempts.agentId, "agent-slow"));
    expect(slowAttempt).toMatchObject({ result: "timeout", notes: "lease expired" });
    // The hung call was still paid for, so it is in the ledger and on its attempt.
    const slowCalls = await db.select().from(s.modelCalls).where(eq(s.modelCalls.agentId, "agent-slow"));
    expect(slowCalls.map((c) => c.attemptId)).toEqual([slowAttempt!.id]);
    expect(slowAttempt!.costUsd).toBe("0.002780");
  });
});

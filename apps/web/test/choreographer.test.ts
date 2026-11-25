/**
 * The colony world must be traceable to real data (BUILD_PROMPT.md section 9, Phase 4 acceptance):
 * one test per row of the "On screen / Triggered by" table, plus the honesty properties.
 */
import { describe, expect, it } from "vitest";
import { Choreographer, type RawEvent, type Snapshot, type SnapshotAgent } from "../src/colony/choreographer";
import { JUDGE, nestSlot } from "../src/colony/layout";
import { drawFrame, type Ctx2D, type Palette } from "../src/colony/render";

const T0 = Date.parse("2026-03-02T12:00:00Z");
function agent(id: string, over: Partial<SnapshotAgent> = {}): SnapshotAgent {
  return { id, name: id, species: "blob", shell: "pink", kind: "internal", level: 1, checkedTotal: 0, active: true, lemmaId: null, lastHeartbeat: null, sleeping: false, sleepReason: null, camp: "core-warmup", food: 1, ...over };
}
function world(agents: SnapshotAgent[], over: Partial<Snapshot> = {}, clock = { now: T0 }) {
  const snap: Snapshot = {
    asOfEventId: 100,
    serverTime: new Date(T0).toISOString(),
    programs: [
      { slug: "core-warmup", idPrefix: "core", checked: 0, total: 5 },
      { slug: "circuit-lower-bounds", idPrefix: "circ", checked: 0, total: 3 },
      { slug: "proof-complexity", idPrefix: "pc", checked: 0, total: 0 },
    ],
    agents,
    pantry: { pantryUsd: "100.000000", runwayDays: 30, hungry: false },
    ...over,
  };
  const c = new Choreographer(snap, () => clock.now);
  let id = 100;
  const ev = (type: string, agentId: string | null, lemmaId: string | null = null, payload: Record<string, unknown> = {}): RawEvent => {
    const e = { id: ++id, ts: new Date(clock.now).toISOString(), type, agentId, lemmaId, payload };
    c.apply(e);
    return e;
  };
  const run = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      c.step();
      clock.now += 100;
    }
  };
  return { c, ev, run, clock, pet: (pid: string) => c.pets.get(pid)! };
}

describe("every row of the table, triggered only by its event", () => {
  it("leased: walks to its camp and idles near the board", () => {
    const { c, ev, run, pet } = world([agent("a", { camp: null })]);
    const e = ev("leased", "a", "L-circ-001");
    expect(pet("a")).toMatchObject({ act: "toCamp", cause: e.id, camp: "circuit-lower-bounds", lemmaId: "L-circ-001" });
    run(200);
    expect(pet("a").act).toBe("idle");
    expect(pet("a").y).toBeLessThan(40); // the circuits camp is in the top-left corner
    expect(c.look(pet("a"))).toBe("working"); // fresh heartbeat at lease time
  });

  it("thinking dots + bounce only while the lease heartbeat is under 2 minutes old", () => {
    const clock = { now: T0 };
    const { c, run, pet, ev } = world([agent("a", { lemmaId: "L-core-001", lastHeartbeat: new Date(T0 - 30_000).toISOString() })], {}, clock);
    expect(c.look(pet("a"))).toBe("working");
    clock.now = T0 + 95_000; // heartbeat now 125 s old
    expect(c.look(pet("a"))).toBe("idle");
    ev("model_call", "a", "L-core-001"); // a model call happens right after a heartbeat
    expect(c.look(pet("a"))).toBe("working");
    run(1);
    const b = world([agent("b", { lemmaId: null, lastHeartbeat: new Date(T0).toISOString() })]);
    expect(b.c.look(b.pet("b"))).toBe("idle"); // no lease: no dots
  });

  it("failed local check: sad face for a few seconds", () => {
    const { c, ev, run, pet } = world([agent("a", { lemmaId: "L-core-001" })]);
    ev("local_check", "a", "L-core-001", { ok: true });
    expect(c.look(pet("a"))).not.toBe("sad");
    const e = ev("local_check", "a", "L-core-001", { ok: false });
    expect(c.look(pet("a"))).toBe("sad");
    expect(c.trace.at(-1)).toMatchObject({ petId: "a", what: "sad", cause: e.id });
    run(40);
    expect(c.look(pet("a"))).not.toBe("sad");
  });

  it("submitted: walks to the judge carrying a scroll, and waits there for the real verdict", () => {
    const { c, ev, run, pet } = world([agent("a", { lemmaId: "L-core-001" })]);
    const e = ev("submitted", "a", "L-core-001");
    expect(pet("a")).toMatchObject({ act: "toJudge", carry: true, cause: e.id });
    run(500); // the judge takes its time: nothing is shown before the verdict exists
    expect(pet("a").act).toBe("atJudge");
    expect(Math.abs(pet("a").y - JUDGE.y)).toBeLessThanOrEqual(1);
    expect(c.gate.type).toBeNull();
  });

  it("checked: check mark at the gate, jump, teammates run over and cheer", () => {
    const { c, ev, run, pet } = world([agent("a", { lemmaId: "L-core-001" }), agent("mate"), agent("far", { camp: "circuit-lower-bounds" })]);
    ev("submitted", "a", "L-core-001");
    run(60);
    const e = ev("checked", "a", "L-core-001");
    expect(c.gate).toMatchObject({ type: "pass", cause: e.id });
    expect(pet("a")).toMatchObject({ act: "celebrate", cause: e.id, carry: false, lemmaId: null, checked: 1 });
    expect(pet("mate")).toMatchObject({ act: "toCheer", cause: e.id });
    expect(pet("far").act).toBe("idle"); // other camp, far away
    expect(c.programs.get("core-warmup")!.checked).toBe(1); // the board's progress bar
    run(120);
    expect([pet("a").act, pet("mate").act]).toEqual(["idle", "idle"]);
  });

  it("only the nearest few teammates run over to cheer (a big camp does not pile up)", () => {
    const many = Array.from({ length: 30 }, (_, i) => agent(`m${i}`));
    const { ev, run, c } = world([agent("a", { lemmaId: "L-core-001" }), ...many]);
    ev("submitted", "a", "L-core-001");
    run(60);
    const e = ev("checked", "a", "L-core-001");
    const cheering = [...c.pets.values()].filter((p) => p.act === "toCheer");
    expect(cheering).toHaveLength(4);
    expect(cheering.every((p) => p.cause === e.id)).toBe(true);
  });

  it("judge rejection: X at the gate, walks back sad", () => {
    const { c, ev, run, pet } = world([agent("a", { lemmaId: "L-core-001" })]);
    ev("submitted", "a", "L-core-001");
    run(60);
    const e = ev("judge_rejected", "a", "L-core-001", { reasons: ["compile_error"] });
    expect(c.gate).toMatchObject({ type: "reject", cause: e.id });
    expect(pet("a")).toMatchObject({ act: "toCamp", cause: e.id, carry: false });
    expect(c.look(pet("a"))).toBe("sad");
  });

  it("question and reply: walks to the other agent; both bubbles are the real messages", () => {
    const { c, ev, run, pet } = world([agent("asker", { lemmaId: "L-core-001" }), agent("helper", { camp: "proof-complexity" })]);
    const q = ev("question_asked", "asker", "L-core-001", { messageId: 7, routedTo: ["helper"], short: "rfl keeps failing" });
    expect(pet("asker")).toMatchObject({ act: "toTalk", cause: q.id });
    run(100);
    expect(c.bubbles).toEqual([]); // shown once it has arrived... and then gone after a few seconds
    expect(c.trace.find((t) => t.what === "bubble:rfl keeps failing")).toMatchObject({ petId: "asker", cause: q.id });
    const r = ev("reply_posted", "helper", "L-core-001", { messageId: 8, toAgent: "asker", short: "try decide" });
    expect(pet("helper")).toMatchObject({ act: "toTalk", cause: r.id });
    run(80);
    const said = c.trace.filter((t) => t.what.startsWith("bubble:"));
    expect(said.map((t) => [t.petId, t.what, t.cause])).toEqual([["asker", "bubble:rfl keeps failing", q.id], ["helper", "bubble:try decide", r.id]]);
  });

  it("handoff: hands over a scroll, with its bubble", () => {
    const { c, ev, run, pet } = world([agent("giver", { lemmaId: "L-core-002" }), agent("mate")]);
    const e = ev("handoff", "giver", "L-core-002", { messageId: 9, toAgent: "mate", short: "Handing over L-core-002" });
    expect(pet("giver")).toMatchObject({ act: "toTalk", carry: true, cause: e.id });
    run(80);
    expect(pet("giver")).toMatchObject({ carry: false, lemmaId: null });
    expect(c.trace.find((t) => t.what === "bubble:Handing over L-core-002")).toMatchObject({ cause: e.id });
  });

  it("hungry '!': pantry runway under 3 days (from the snapshot)", () => {
    const { c, pet } = world([agent("a")], { pantry: { pantryUsd: "1.000000", runwayDays: 2.5, hungry: true } });
    expect(c.look(pet("a"))).toBe("hungry");
  });

  it("new inflow above the threshold: pets run to the pantry bowl (smaller ones: nothing)", () => {
    const { c, ev, run, pet } = world([agent("a"), agent("b", { sleeping: true, sleepReason: "agent_cap" })]);
    ev("pantry_inflow", null, null, { amountUsd: "5.000000" });
    expect(pet("a").act).toBe("idle");
    const e = ev("pantry_inflow", null, null, { amountUsd: "40.000000" });
    expect(pet("a")).toMatchObject({ act: "toBowl", cause: e.id });
    expect(pet("b").act).toBe("nap"); // asleep: stays asleep
    run(80);
    expect(pet("a").act).toBe("idle");
    void c;
  });

  it("cap used / pantry empty / kill switch: walks to the nap corner, Zz, until it works again", () => {
    const { c, ev, run, pet } = world([agent("a", { lemmaId: "L-core-001" })]);
    const e = ev("sleeping", "a", null, { reason: "agent_cap" });
    expect(pet("a")).toMatchObject({ act: "toNest", cause: e.id, sleeping: true, sleepReason: "agent_cap" });
    run(200);
    expect(pet("a").act).toBe("nap");
    expect(pet("a").y).toBe(nestSlot(0).y);
    expect(c.look(pet("a"))).toBe("sleeping");
    run(1000);
    expect(pet("a").act).toBe("nap"); // stays asleep: no event, no change
    const w = ev("model_call", "a", "L-core-001");
    expect(pet("a")).toMatchObject({ act: "toCamp", cause: w.id, sleeping: false });
  });

  it("level: number of checked lemmas (thresholds 8 / 16 / 28)", () => {
    const { ev, run, pet } = world([agent("a", { checkedTotal: 7, level: 1 })]);
    ev("submitted", "a", "L-core-001");
    run(60);
    ev("checked", "a", "L-core-001");
    expect(pet("a")).toMatchObject({ checked: 8, level: 2 });
  });

  it("food bar: the agent's remaining daily cap (refreshed from the snapshot, never moves a pet)", () => {
    const { c, pet } = world([agent("a", { food: 0.9 })]);
    const before = { x: pet("a").x, y: pet("a").y, act: pet("a").act };
    c.refresh({ asOfEventId: 100, serverTime: new Date(T0).toISOString(), programs: [], agents: [agent("a", { food: 0.25 })], pantry: { pantryUsd: "1", runwayDays: null, hungry: false } });
    expect(pet("a").food).toBe(0.25);
    expect({ x: pet("a").x, y: pet("a").y, act: pet("a").act }).toEqual(before);
  });
});

describe("layout", () => {
  it("a crowded camp spreads its pets over distinct spots", async () => {
    const { campSpot } = await import("../src/colony/layout");
    const spots = new Set(Array.from({ length: 24 }, (_, i) => JSON.stringify(campSpot("core-warmup", i))));
    expect(spots.size).toBe(24);
    for (const prog of ["circuit-lower-bounds", "monotone-circuits", "proof-complexity", "barriers", "core-warmup", null]) {
      for (let i = 0; i < 60; i++) {
        const s = campSpot(prog, i);
        expect(s.x, `${prog} ${i}`).toBeGreaterThanOrEqual(7);
        expect(s.x).toBeLessThanOrEqual(153);
        expect(s.y).toBeLessThanOrEqual(98);
      }
    }
  });
});

describe("honesty properties", () => {
  it("with no events nothing moves (no idle wandering), however long it runs", () => {
    const { c, run } = world([agent("a"), agent("b", { lemmaId: "L-core-001", lastHeartbeat: new Date(T0).toISOString() }), agent("c", { sleeping: true })]);
    const before = [...c.pets.values()].map((p) => [p.id, p.x, p.y, p.act]);
    run(10_000);
    expect([...c.pets.values()].map((p) => [p.id, p.x, p.y, p.act])).toEqual(before);
    expect(c.trace).toEqual([]);
  });

  it("every move, mood, bubble and gate flash traces to an applied event", () => {
    const agents = ["a", "b", "c", "d"].map((id, i) => agent(id, { camp: i % 2 ? "core-warmup" : "circuit-lower-bounds" }));
    const { c, ev, run } = world(agents);
    const applied = new Set<number>();
    const track = (e: RawEvent) => applied.add(e.id);
    track(ev("leased", "a", "L-core-001"));
    track(ev("leased", "b", "L-circ-002"));
    run(30);
    track(ev("local_check", "a", "L-core-001", { ok: false }));
    track(ev("submitted", "a", "L-core-001"));
    track(ev("question_asked", "b", "L-circ-002", { routedTo: ["c"], short: "help?", messageId: 1 }));
    run(40);
    track(ev("checked", "a", "L-core-001")); // arrives while a may still be walking: queued until it reaches the judge
    track(ev("reply_posted", "c", "L-circ-002", { toAgent: "b", short: "use simp", messageId: 2 }));
    track(ev("sleeping", "d", null, { reason: "pantry_empty" }));
    track(ev("pantry_inflow", null, null, { amountUsd: "100" }));
    run(300);
    expect(c.trace.length).toBeGreaterThan(10);
    for (const t of c.trace) expect(applied.has(t.cause!), JSON.stringify(t)).toBe(true);
  });

  it("a verdict that arrives before the pet reaches the judge waits for it (choreography never runs ahead)", () => {
    const { c, ev, run, pet } = world([agent("a", { lemmaId: "L-core-001" })]);
    ev("submitted", "a", "L-core-001");
    const e = ev("checked", "a", "L-core-001"); // the judge was fast
    expect(pet("a").act).toBe("toJudge");
    expect(c.gate.type).toBeNull();
    for (let i = 0; i < 100 && pet("a").act === "toJudge"; i++) run(1);
    run(1);
    expect(c.gate).toMatchObject({ type: "pass", cause: e.id });
  });

  it("events are applied once and in order; a busy pet queues them", () => {
    const { c, ev, pet } = world([agent("a", { lemmaId: "L-core-001" })]);
    ev("submitted", "a", "L-core-001");
    const s = ev("sleeping", "a", null, { reason: "agent_cap" });
    expect(pet("a").queue.map((q) => q.id)).toEqual([s.id]);
    c.apply({ id: s.id, ts: "", type: "sleeping", agentId: "a", lemmaId: null, payload: {} }); // replayed: ignored
    expect(pet("a").queue).toHaveLength(1);
  });

  it("bubbles only from message text in the event; nothing invented", () => {
    const { c, ev, run } = world([agent("a"), agent("b")]);
    ev("question_asked", "a", null, { routedTo: ["b"] }); // no short text
    run(80);
    expect(c.trace.filter((t) => t.what.startsWith("bubble:"))).toEqual([]);
  });

  it("only active agents are in the world; new agents appear with their deterministic identity", () => {
    const { c, ev } = world([agent("a"), agent("gone", { active: false })]);
    expect([...c.pets.keys()]).toEqual(["a"]);
    ev("agent_registered", "agent-new");
    expect(c.pets.get("agent-new")).toMatchObject({ act: "idle" });
    expect(c.pets.get("agent-new")!.name).toMatch(/^[A-Z][a-z]+$/);
  });
});

describe("smooth with 50+ agents", () => {
  it("60 pets, a busy event stream: step + full redraw well under the 100 ms frame budget", () => {
    const agents = Array.from({ length: 60 }, (_, i) => agent(`agent-${i}`, { camp: ["core-warmup", "circuit-lower-bounds", "proof-complexity"][i % 3], lemmaId: `L-core-00${(i % 5) + 1}`, lastHeartbeat: new Date(T0).toISOString(), species: ["blob", "cat", "bug", "ghost"][i % 4]!, shell: ["pink", "sky", "lime", "grape", "tang", "mint"][i % 6]! }));
    const { c, ev } = world(agents);
    const ops = { n: 0 };
    const ctx: Ctx2D = { fillStyle: "", globalAlpha: 1, fillRect: () => void ops.n++, clearRect: () => {} };
    const pal: Palette = { pix: "#000", lcd: "#fff", bowl: "#f90", scroll: "#fff", shells: { pink: "#f9c", sky: "#9cf", lime: "#cf9", grape: "#c9f", tang: "#fc9", mint: "#9fc" } };
    const types = ["submitted", "checked", "local_check", "question_asked", "judge_rejected", "leased"];
    const t0 = performance.now();
    let frames = 0;
    for (let f = 0; f < 600; f++) {
      if (f % 3 === 0) {
        const i = f % 60;
        const type = types[f % types.length]!;
        ev(type, `agent-${i}`, `L-core-00${(i % 5) + 1}`, type === "local_check" ? { ok: false } : type === "question_asked" ? { routedTo: [`agent-${(i + 1) % 60}`], short: "?" } : {});
      }
      c.step();
      drawFrame(ctx, c, 6, 1, pal, Math.floor(f / 3), f, false, 0.7);
      frames++;
    }
    const perFrame = (performance.now() - t0) / frames;
    expect(c.pets.size).toBe(60);
    expect(ops.n / frames).toBeGreaterThan(60 * 50); // really drew every pet
    expect(perFrame).toBeLessThan(10); // budget at 10 fps is 100 ms
  });
});

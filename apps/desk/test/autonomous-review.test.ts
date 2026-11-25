import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { AiReview } from "../src/ai-review.ts";
import { definitions, events, lemmas, modelCalls, reviewRounds, statements } from "../src/db/schema.ts";
import { Review } from "../src/review.ts";
import { buildServer } from "../src/server.ts";
import { makeDesk } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const ADMIN_TOKEN = "test-admin-token-0123456789";
const CONTRIB_TOKEN = "test-contrib-ci-token-0123456789";
const part = { model: "claude-opus-5-5", inputTokens: 2000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 };

async function setup(config: Record<string, string> = {}) {
  const d = await makeDesk({ config: { ADMIN_TOKEN, CONTRIB_TOKEN, ...config } });
  cleanups.push(d.cleanup);
  const review = new Review(d.desk, d.judge);
  const ai = new AiReview(d.desk, review);
  for (const id of ["reviewer-a", "reviewer-b", "reviewer-c", "adversary-1"]) await d.desk.registerAgent(id, "claude-opus-5-5");
  await ai.tick();
  return { ...d, review, ai };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const roundOf = async (ai: AiReview, kind: "definition" | "statement", id: string) => (await ai.rounds(kind, id))[0]!;
const verdict = (agentId: string, model: string, agree: boolean, summary = agree ? "Matches the textbook definition." : "Depth is off by one.") =>
  ({ agentId, model, agree, summary, reasoning: `${agentId}: compared with Arora–Barak, Def. 6.1. ${summary}`, details: { mathlibAlternative: null }, parts: [part] });
const sanityOf = async (c: Ctx, def: string) => (await c.db.select().from(statements)).filter((s) => s.sanityFor.includes(def)).map((s) => s.id);
const setLemmas = (c: Ctx, ids: string[], status: "checked" | "abandoned" | "refuted" | "open") => c.db.update(lemmas).set({ status }).where(inArray(lemmas.id, ids));

/** Everything a definition needs, the honest way: 2 verdicts, an adversary that tried and failed, proved sanity lemmas. */
async function passReview(c: Ctx, def: string) {
  const r = await roundOf(c.ai, "definition", def);
  await c.ai.recordVerdict(r.id, verdict("reviewer-a", "claude-opus-5-5", true));
  await c.ai.recordVerdict(r.id, verdict("reviewer-b", "claude-sonnet-5-5", true));
  await c.db.update(reviewRounds).set({ adversaryAgent: "adversary-1" }).where(eq(reviewRounds.id, r.id));
  for (let i = 0; i < 3; i++) await c.ai.adversaryCheck(r.id, "adversary-1", 0, "theorem Proof.L_adv_001 : Statement.L_adv_001 := by exact absurd")
  await c.ai.adversaryDone(r.id, "adversary-1", "Tried case analysis on Formula; every constructor is consistent.");
  await setLemmas(c, await sanityOf(c, def), "checked");
  await c.ai.tick();
  return r;
}

describe("definitions: approved only by agreeing reviewers, proved sanity lemmas and a failed adversary", () => {
  it("full path for Defs.Core.Formula, with every step and its reasoning stored and public", async () => {
    const c = await setup();
    const { ai, db, desk } = c;
    // Every definition got a round at once; nothing is approved.
    expect((await db.select().from(reviewRounds)).map((r) => r.targetId).sort()).toEqual(["Defs.Core.Circuit", "Defs.Core.Formula", "Defs.Core.Resolution", "Defs.Mathlib.Complexity"]);
    const r = await roundOf(ai, "definition", "Defs.Core.Formula");

    // Reviewer tasks go to different agents; one agent never reviews the same round twice.
    await ai.recordVerdict(r.id, verdict("reviewer-a", "claude-opus-5-5", true));
    await expect(ai.recordVerdict(r.id, verdict("reviewer-a", "claude-opus-5-5", true))).rejects.toThrow(/already reviewed/);
    await ai.recordVerdict(r.id, verdict("reviewer-b", "claude-sonnet-5-5", true));
    expect(await ai.evaluate(r.id)).toBe("running"); // the adversary and the sanity lemmas are still to come

    // The adversary task comes only now (the reviewers agreed); goals: False only (no "adversary:" header).
    const t = (await (async () => {
      for (;;) {
        const x = await ai.nextTask("adversary-1", "claude-opus-5-5");
        if (!x || (x.kind === "adversary" && x.definition.id === "Defs.Core.Formula")) return x;
        if (x.kind === "definition") await ai.recordVerdict(x.roundId, verdict("adversary-1", "claude-opus-5-5", false, "skip")); // other defs: not under test
      }
    })())!;
    expect(t).toMatchObject({ kind: "adversary", goals: [{ index: 0, lemmaId: "L-adv-001", goal: "False" }], budgetUsd: 2, minChecks: 3 });
    await expect(ai.adversaryDone(r.id, "adversary-1", "nothing")).rejects.toThrow(/at least 3 proofs/); // no giving up without trying
    for (let i = 0; i < 3; i++) {
      const v = await ai.adversaryCheck(r.id, "adversary-1", 0, "import Statements.L_adv_001\ntheorem Proof.L_adv_001 : Statement.L_adv_001 := by simp");
      expect(v.verdict.verdict).toBe("fail");
    }
    // The desk's own judge checked them, against a statement the desk built ("False" from the module).
    const adv = c.judge.requests.filter((q) => q.lemmaId === "L-adv-001");
    expect(adv).toHaveLength(3);
    expect(adv[0]!.statements![0]!.source).toMatch(/import Defs\.Core\.Formula\n\ndef Statement\.L_adv_001 : Prop :=\n  False/);
    await ai.adversaryUsage(r.id, "adversary-1", [part]);
    await ai.adversaryDone(r.id, "adversary-1", "Tried induction on Formula and the eval equations; nothing contradictory.");
    expect(await ai.evaluate(r.id)).toBe("running"); // sanity lemmas not proved yet

    const sanity = await sanityOf(c, "Defs.Core.Formula");
    expect(sanity).toEqual(["L-sanity-004", "L-sanity-005"]);
    await setLemmas(c, ["L-sanity-004"], "checked");
    expect(await ai.evaluate(r.id)).toBe("running");
    await setLemmas(c, ["L-sanity-005"], "checked");
    expect(await ai.evaluate(r.id)).toBe("approved");

    const [d] = await db.select().from(definitions).where(eq(definitions.id, "Defs.Core.Formula"));
    expect(d).toMatchObject({ status: "approved", reviewedVia: "ai", reviewedSha256: d!.sourceSha256 });
    expect((await desk.definitionStates()).get("Defs.Core.Formula")!.effective).toBe(true);
    const steps = await ai.steps(r.id);
    expect(steps.map((s) => `${s.kind}:${s.verdict}`)).toEqual(["reviewer:pass", "reviewer:pass", "adversary:pass", "sanity:pass"]);
    expect(steps[0]!.reasoning).toMatch(/Arora–Barak/);
    expect(Number(steps[0]!.costUsd)).toBeGreaterThan(0); // reviewer calls are paid and recorded
    const purposes = (await db.select().from(modelCalls)).map((m) => m.purpose);
    expect(purposes.filter((x) => x === "adversary")).toHaveLength(1); // recorded against the round's budget
    expect(purposes.every((x) => x === "review" || x === "adversary")).toBe(true);

    // Public: the label, every round, every step with reasoning.
    const app = buildServer(desk, c.review, undefined, ai);
    cleanups.push(() => app.close());
    const pub = (await app.inject({ url: "/definitions/Defs.Core.Formula" })).json();
    expect(pub.aiReview.label).toBe("Reviewed by AI agents, not by a human mathematician.");
    expect(pub.aiReview.rounds[0]).toMatchObject({ status: "approved", steps: [{ kind: "reviewer", model: "claude-opus-5-5", reasoning: expect.stringMatching(/Arora/) }, {}, {}, {}] });
    expect(pub.aiReview.sanity).toMatchObject({ status: "pass", lemmas: [{ id: "L-sanity-004" }, { id: "L-sanity-005" }] });
    expect(pub.draft).toBe(false);
  });

  it("rejected when one reviewer disagrees, when a sanity lemma fails, or when the adversary proves False", async () => {
    const c = await setup();
    const { ai, db } = c;
    // 1. one disagreeing reviewer is enough
    const circ = await roundOf(ai, "definition", "Defs.Core.Circuit");
    await ai.recordVerdict(circ.id, verdict("reviewer-a", "claude-opus-5-5", true));
    expect((await ai.recordVerdict(circ.id, verdict("reviewer-b", "claude-sonnet-5-5", false, "Depth counts NOT gates differently from the textbook."))).roundStatus).toBe("rejected");
    expect((await db.select().from(definitions).where(eq(definitions.id, "Defs.Core.Circuit")))[0]!.status).toBe("rejected");
    expect((await roundOf(ai, "definition", "Defs.Core.Circuit")).reason).toMatch(/disagreed: Depth counts NOT gates/);

    // 2. a sanity lemma that could not be proved within its budget
    const res = await roundOf(ai, "definition", "Defs.Core.Resolution");
    await setLemmas(c, ["L-sanity-007"], "abandoned");
    expect(await ai.evaluate(res.id)).toBe("rejected");
    expect((await roundOf(ai, "definition", "Defs.Core.Resolution")).reason).toMatch(/sanity check failed: sanity lemma L-sanity-007 \(Two pigeons do not fit in one hole\) was not proved within its attempt budget/);

    // 3. the adversary proves False (the judge accepts its proof)
    const form = await roundOf(ai, "definition", "Defs.Core.Formula");
    await ai.recordVerdict(form.id, verdict("reviewer-a", "claude-opus-5-5", true));
    await ai.recordVerdict(form.id, verdict("reviewer-b", "claude-sonnet-5-5", true));
    await db.update(reviewRounds).set({ adversaryAgent: "adversary-1" }).where(eq(reviewRounds.id, form.id));
    const win = await ai.adversaryCheck(form.id, "adversary-1", 0, "import Statements.L_adv_001\ntheorem Proof.L_adv_001 : Statement.L_adv_001 := by exact bad -- PASS");
    expect(win.roundStatus).toBe("rejected");
    const step = (await ai.steps(form.id)).find((s) => s.kind === "adversary")!;
    expect(step).toMatchObject({ verdict: "fail", summary: expect.stringMatching(/proved False from Defs\.Core\.Formula/) });
    expect(step.reasoning).toContain("by exact bad"); // the proof is kept
  });

  it("the Mathlib definition (P, NP) gets P = NP and P ≠ NP as adversary goals, but no adversary on a lite judge", async () => {
    const c = await setup();
    const r = await roundOf(c.ai, "definition", "Defs.Mathlib.Complexity");
    const [d] = await c.db.select().from(definitions).where(eq(definitions.id, "Defs.Mathlib.Complexity"));
    expect(c.ai.goals(d!).map((g) => g.goal)).toEqual(["False", "Hatchery.Defs.P = Hatchery.Defs.NP", "Hatchery.Defs.P ≠ Hatchery.Defs.NP"]);
    await c.ai.recordVerdict(r.id, verdict("reviewer-a", "claude-opus-5-5", true));
    await c.ai.recordVerdict(r.id, verdict("reviewer-b", "claude-sonnet-5-5", true));
    for (let i = 0; i < 6; i++) {
      const t = await c.ai.nextTask("adversary-1", "claude-opus-5-5");
      expect(t?.kind === "adversary" && t.definition.id === "Defs.Mathlib.Complexity").toBe(false);
      if (t?.kind === "definition") await c.ai.recordVerdict(t.roundId, verdict("adversary-1", "x", false, "skip"));
    }
    expect((await c.ai.sanityState("Defs.Mathlib.Complexity")).lemmas.map((l) => l.id)).toEqual(["L-sanity-009", "L-sanity-010"]);
  });

  it("distinct models, when required; a changed source supersedes the round", async () => {
    const c = await setup({ REVIEW_REQUIRE_DISTINCT_MODELS: "1" });
    const r = await roundOf(c.ai, "definition", "Defs.Core.Formula");
    await c.ai.recordVerdict(r.id, verdict("reviewer-a", "claude-opus-5-5", true));
    // Another agent with the SAME model gets no reviewer task for this round.
    for (;;) {
      const t = await c.ai.nextTask("reviewer-b", "claude-opus-5-5");
      if (!t || t.kind !== "definition") break;
      expect(t.roundId).not.toBe(r.id);
      await c.ai.recordVerdict(t.roundId, verdict("reviewer-b", "claude-opus-5-5", false, "skip"));
    }
    await c.ai.recordVerdict(r.id, verdict("reviewer-c", "claude-opus-5-5", true)); // forced in: still the same model
    await c.db.update(reviewRounds).set({ adversaryAgent: "adversary-1" }).where(eq(reviewRounds.id, r.id));
    for (let i = 0; i < 3; i++) await c.ai.adversaryCheck(r.id, "adversary-1", 0, "x");
    await c.ai.adversaryDone(r.id, "adversary-1", "");
    await setLemmas(c, ["L-sanity-004", "L-sanity-005"], "checked");
    expect(await c.ai.evaluate(r.id)).toBe("running"); // two models are required, one was used

    // The source changes (as after a sync): the old round can no longer decide anything.
    await c.db.update(definitions).set({ sourceSha256: "f".repeat(64) }).where(eq(definitions.id, "Defs.Core.Formula"));
    await expect(c.ai.recordVerdict(r.id, verdict("reviewer-b", "claude-sonnet-5-5", true))).rejects.toThrow(/changed since this review started/);
    expect(await c.ai.evaluate(r.id)).toBe("superseded");
  });
});

describe("statements: elaborates, not trivial, not a duplicate, approved definitions, a reviewer confirms it is meaningful", () => {
  it("waits for its definition, then a reviewer agent decides; approval makes it a leasable lemma", async () => {
    const c = await setup();
    const { ai, review, db, desk } = c;
    await desk.registerAgent("decomposer-1", "fake-model");
    const ok = await review.propose("decomposer-1", { program: "proof-complexity", title: "PHP(3,2) is unsatisfiable", imports: ["Defs.Core.Resolution"], rationale: "base case of Haken", prop: "Hatchery.Defs.CNF.Unsat (Hatchery.Defs.php 3 2)" });
    const dull = await review.propose("decomposer-1", { program: "proof-complexity", title: "PHP(4,3)", imports: ["Defs.Core.Resolution"], rationale: "", prop: "Hatchery.Defs.CNF.Unsat (Hatchery.Defs.php 4 3)" });
    const triv = await review.propose("decomposer-1", { program: "proof-complexity", title: "x", imports: ["Defs.Core.Resolution"], rationale: "", prop: "TRIVIAL True" });
    expect(triv.status).toBe("rejected"); // the existing filter, before any AI review
    await ai.tick();
    const r = await roundOf(ai, "statement", ok.id);
    expect((await ai.steps(r.id)).map((s) => s.kind)).toEqual(["filter"]);
    // Its definition is still a draft: no reviewer task for it, no approval.
    for (let i = 0; i < 5; i++) {
      const t = await ai.nextTask("reviewer-c", "claude-opus-5-5");
      expect(t?.kind === "statement").toBe(false);
      if (t?.kind === "definition") await ai.recordVerdict(t.roundId, verdict("reviewer-c", "claude-opus-5-5", true));
    }
    await passReview(c, "Defs.Core.Resolution");
    expect((await db.select().from(definitions).where(eq(definitions.id, "Defs.Core.Resolution")))[0]!.status).toBe("approved");

    // reviewer-a first gets the other definitions (rejected here to keep the test short), then the statement.
    let t = await ai.nextTask("reviewer-a", "claude-opus-5-5");
    for (let i = 0; i < 10 && t && t.kind !== "statement"; i++) {
      if (t.kind === "definition") await ai.recordVerdict(t.roundId, verdict("reviewer-a", "claude-opus-5-5", false, "skip"));
      t = await ai.nextTask("reviewer-a", "claude-opus-5-5");
    }
    expect(t).toMatchObject({ kind: "statement", statement: { program: { slug: "proof-complexity" }, definitions: [{ id: "Defs.Core.Resolution" }] } });
    const yes = await ai.recordVerdict((await roundOf(ai, "statement", ok.id)).id, { ...verdict("reviewer-a", "claude-opus-5-5", true, "Base case of the pigeonhole lower bound: on topic."), details: { meaningful: true } });
    expect(yes.roundStatus).toBe("approved");
    const [st] = await db.select().from(statements).where(eq(statements.id, ok.id));
    expect(st).toMatchObject({ status: "approved", approvedBy: expect.stringMatching(/^AI review \(round #\d+\)$/) });
    expect((await db.select().from(lemmas).where(eq(lemmas.id, ok.id)))[0]!.status).toBe("open");
    expect((await ai.steps((await roundOf(ai, "statement", ok.id)).id)).map((s) => s.kind)).toEqual(["filter", "definitions", "reviewer"]);

    const no = await ai.recordVerdict((await roundOf(ai, "statement", dull.id)).id, verdict("reviewer-a", "claude-opus-5-5", false, "Just another instance of the same base case; not a step towards the program."));
    expect(no.roundStatus).toBe("rejected");
    expect((await db.select().from(statements).where(eq(statements.id, dull.id)))[0]).toMatchObject({ status: "rejected", rejectReason: expect.stringMatching(/^AI review: a reviewer agent .* disagreed: Just another instance/) });
  });
});

describe("admin override and public flags", () => {
  it("admins revert, block and unblock (HTTP); a blocked definition is never reviewed or used", async () => {
    const c = await setup();
    const app = buildServer(c.desk, c.review, undefined, c.ai);
    cleanups.push(() => app.close());
    await passReview(c, "Defs.Core.Formula");
    const post = (kind: string, id: string, body: object) => app.inject({ method: "POST", url: `/admin/review/${kind}/${id}`, headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload: body });
    expect((await app.inject({ method: "POST", url: "/admin/review/definition/Defs.Core.Formula", payload: { action: "block", reason: "nope" } })).statusCode).toBe(401);
    expect((await post("definition", "Defs.Core.Formula", { action: "block", reason: "size should not count NOT gates" })).json()).toEqual({ status: "blocked" });
    const [d] = await c.db.select().from(definitions).where(eq(definitions.id, "Defs.Core.Formula"));
    expect(d).toMatchObject({ status: "blocked", blockedReason: "size should not count NOT gates" });
    expect(await c.ai.ensureRounds()).toEqual([]); // never auto-reviewed while blocked
    expect((await c.desk.definitionStates()).get("Defs.Core.Formula")!.blockers.join()).toMatch(/blocked by an admin/);

    expect((await post("definition", "Defs.Core.Formula", { action: "unblock", reason: "fixed" })).json()).toEqual({ status: "in review" });
    const r = await roundOf(c.ai, "definition", "Defs.Core.Formula");
    expect(r).toMatchObject({ status: "running", trigger: "admin" });
    expect((await c.ai.steps(r.id))[0]).toMatchObject({ kind: "admin", actor: "admin-token", reasoning: "fixed" });
    const ev = (await c.db.select().from(events).where(eq(events.type, "review_overridden"))).map((e) => (e.payload as { action: string }).action);
    expect(ev).toEqual(["block", "unblock"]);
    expect((await post("statement", "L-sanity-004", { action: "block", reason: "x".repeat(5) })).statusCode).toBe(400); // sanity lemmas come from the repo
    expect((await post("statement", "L-sanity-004", { action: "revert", reason: "x".repeat(5) })).statusCode).toBe(400);
  });

  it("reverting a definition rejected for an unproved sanity lemma gives that lemma another chance", async () => {
    const c = await setup();
    const r = await roundOf(c.ai, "definition", "Defs.Core.Resolution");
    await setLemmas(c, ["L-sanity-007"], "abandoned");
    expect(await c.ai.evaluate(r.id)).toBe("rejected");
    await c.ai.adminOverride("definition", "Defs.Core.Resolution", "revert", "try the sanity lemmas again", "admin-token");
    expect((await c.db.select().from(lemmas).where(eq(lemmas.id, "L-sanity-007")))[0]!.status).toBe("open");
    expect((await roundOf(c.ai, "definition", "Defs.Core.Resolution")).status).toBe("running");
  });

  it("anyone can flag through a GitHub issue: back to review, reason shown to reviewers as data; limits", async () => {
    const c = await setup({ MAX_FLAGS_PER_LOGIN_PER_DAY: "2" });
    const app = buildServer(c.desk, c.review, undefined, c.ai);
    cleanups.push(() => app.close());
    await passReview(c, "Defs.Core.Formula");
    const flag = (issueNumber: number, targetId: string, login = "skeptic", reason = "Formula.size counts constants; the textbook does not.") =>
      app.inject({ method: "POST", url: "/contrib/flags", headers: { authorization: `Bearer ${CONTRIB_TOKEN}` }, payload: { issueNumber, login, targetId, reason } });
    expect((await app.inject({ method: "POST", url: "/contrib/flags", payload: { issueNumber: 1, login: "x", targetId: "Defs.Core.Formula" } })).statusCode).toBe(401);

    const f1 = (await flag(41, "Defs.Core.Formula")).json();
    expect(f1).toMatchObject({ result: "accepted", message: expect.stringMatching(/back in review/) });
    expect((await c.db.select().from(definitions).where(eq(definitions.id, "Defs.Core.Formula")))[0]!.status).toBe("draft");
    expect((await flag(41, "Defs.Core.Formula")).json().result).toBe("attached"); // same issue twice
    expect((await flag(42, "Defs.Core.Formula", "other")).json()).toMatchObject({ result: "attached", roundId: f1.roundId }); // joins the running re-review
    expect((await flag(43, "Defs.Core.Circuit")).json().result).toBe("accepted");
    expect((await flag(44, "Defs.Core.Resolution")).json()).toMatchObject({ result: "refused", message: expect.stringMatching(/at most 2 flags/) });
    expect((await flag(45, "L-core-001", "third")).json()).toMatchObject({ result: "refused", message: expect.stringMatching(/comes from the repository/) });
    expect((await flag(46, "Defs.Core.Nope", "fourth")).json()).toMatchObject({ result: "refused" });

    // Reviewer agents see the flag text (as data) in their task.
    let t = await c.ai.nextTask("reviewer-c", "claude-opus-5-5");
    while (t && !(t.kind === "definition" && t.definition.id === "Defs.Core.Formula")) {
      if (t.kind === "definition") await c.ai.recordVerdict(t.roundId, verdict("reviewer-c", "claude-opus-5-5", true));
      t = await c.ai.nextTask("reviewer-c", "claude-opus-5-5");
    }
    expect(t).toMatchObject({ flags: ["Formula.size counts constants; the textbook does not.", "Formula.size counts constants; the textbook does not."] });
    const hist = (await app.inject({ url: "/definitions/Defs.Core.Formula" })).json().aiReview.rounds;
    expect(hist[0]).toMatchObject({ trigger: "flag", steps: [{ kind: "flag", actor: "github:skeptic" }, { kind: "flag", actor: "github:other" }] });
    expect(hist[1]).toMatchObject({ status: "approved" }); // the earlier decision stays visible
  });
});

describe("statements that use a definition sent back to review go back to review too", () => {
  it("approved statement -> proposed + a new round when its definition is flagged", async () => {
    const c = await setup();
    await c.desk.registerAgent("decomposer-1", "fake-model");
    await passReview(c, "Defs.Core.Resolution");
    const p = await c.review.propose("decomposer-1", { program: "proof-complexity", title: "PHP(3,2)", imports: ["Defs.Core.Resolution"], rationale: "", prop: "Hatchery.Defs.CNF.Unsat (Hatchery.Defs.php 3 2)" });
    await c.ai.tick();
    await c.ai.recordVerdict((await roundOf(c.ai, "statement", p.id)).id, verdict("reviewer-a", "claude-opus-5-5", true));
    expect((await c.db.select().from(statements).where(eq(statements.id, p.id)))[0]!.status).toBe("approved");
    await c.ai.flag({ issueNumber: 7, login: "someone", targetId: "Defs.Core.Resolution", reason: "php variable numbering looks wrong" });
    await c.ai.tick();
    expect((await c.db.select().from(statements).where(eq(statements.id, p.id)))[0]!.status).toBe("proposed");
    const rs = await c.ai.rounds("statement", p.id);
    expect(rs.map((r) => `${r.status}:${r.trigger}`)).toEqual(["running:dependency", "approved:new"]);
    // The sanity lemmas of a definition in review stay approved and leasable (they are part of its review).
    expect((await c.db.select().from(statements).where(and(eq(statements.id, "L-sanity-006"))))[0]!.status).toBe("approved");
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { definitions, events, lemmas, reviews, splitRequests, statements } from "../src/db/schema.ts";
import { ProofCommitter } from "../src/proof-committer.ts";
import { Review } from "../src/review.ts";
import { buildServer } from "../src/server.ts";
import { makeDesk, REPO_LEAN_DIR, tempLeanDir, WORKER_TOKEN } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function setup(opts: Parameters<typeof makeDesk>[0] = {}) {
  const d = await makeDesk(opts);
  cleanups.push(d.cleanup);
  return { ...d, review: new Review(d.desk, d.judge) };
}

/** A temporary git repository standing in for "the developer's real checkout". */
function fakeCheckout() {
  const root = mkdtempSync(join(tmpdir(), "hatchery-checkout-"));
  execFileSync("cp", ["-R", tempLeanDir(), join(root, "lean")]);
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=dev", "-c", "user.email=dev@example.invalid", "commit", "-q", "-m", "init");
  return { root, lean: join(root, "lean"), git };
}
const PASS = "import Statements.L_core_001\ntheorem Proof.L_core_001 : Statement.L_core_001 := fun a b => Nat.add_comm a b -- PASS\n";
type S = Awaited<ReturnType<typeof setup>>;
async function proveFirst(d: S["desk"], agent = "agent-a") {
  await d.registerAgent(agent, "fake-model");
  const ctx = await d.lease(agent);
  const id = await d.startAttempt(agent, ctx!.lemmaId);
  return d.submit(id, agent, PASS, "");
}

describe("bot commits never touch the real checkout unless a real run is explicit", () => {
  it("config refuses commit/write/push without HATCHERY_REAL_RUN=1", () => {
    const base = { DESK_WORKER_TOKEN: WORKER_TOKEN };
    expect(loadConfig(base).PROOF_COMMIT_MODE).toBe("sandbox"); // the default
    expect(() => loadConfig({ ...base, PROOF_COMMIT_MODE: "commit" })).toThrow(/HATCHERY_REAL_RUN=1/);
    expect(() => loadConfig({ ...base, PROOF_COMMIT_MODE: "write" })).toThrow(/HATCHERY_REAL_RUN=1/);
    expect(() => loadConfig({ ...base, PROOF_COMMIT_MODE: "sandbox", PROOF_PUSH: "1" })).toThrow(/PROOF_PUSH=1 needs/);
    expect(loadConfig({ ...base, PROOF_COMMIT_MODE: "commit", HATCHERY_REAL_RUN: "1" }).PROOF_COMMIT_MODE).toBe("commit");
    // docker compose passes unset variables as empty strings: they mean "not set".
    const c = loadConfig({ ...base, ADMIN_TOKEN: "", PROOF_SANDBOX_DIR: "", PROOF_COMMIT_MODE: "" });
    expect([c.ADMIN_TOKEN, c.PROOF_SANDBOX_DIR, c.PROOF_COMMIT_MODE]).toEqual([undefined, undefined, "sandbox"]);
  });

  it("tests cannot even construct a committer that writes into this repository", () => {
    expect(() => new ProofCommitter(REPO_LEAN_DIR, { mode: "commit", authorName: "x", authorEmail: "x@x" })).toThrow(/refusing/);
    expect(() => new ProofCommitter(REPO_LEAN_DIR, { mode: "write", authorName: "x", authorEmail: "x@x" })).toThrow(/refusing/);
  });

  it("default (sandbox): the accepted proof is committed in a throwaway clone; the checkout is untouched", async () => {
    const co = fakeCheckout();
    const before = `${co.git("rev-parse", "HEAD")}|${co.git("status", "--porcelain")}`;
    const sandboxDir = mkdtempSync(join(tmpdir(), "hatchery-sandbox-test-"));
    const { desk } = await setup({ leanDir: co.lean, config: { PROOF_COMMIT_MODE: "sandbox", PROOF_SANDBOX_DIR: sandboxDir, GIT_COMMIT: "" } });
    expect((await proveFirst(desk)).verdict).toBe("pass");
    expect(`${co.git("rev-parse", "HEAD")}|${co.git("status", "--porcelain")}`).toBe(before);
    expect(existsSync(join(co.lean, "Proofs", "L_core_001.lean"))).toBe(false);
    const sandboxLog = execFileSync("git", ["-C", sandboxDir, "log", "-1", "--format=%an|%s"], { encoding: "utf8" }).trim();
    expect(sandboxLog).toBe("Hatchery Judge|proof: L_core_001 checked");
    expect(readFileSync(join(sandboxDir, "lean", "Proofs", "L_core_001.lean"), "utf8")).toBe(PASS);
  });

  it("the suite's checkout guard detects commits, edits, new files and empty directories", async () => {
    const { checkoutState } = await import("./global-setup.ts");
    const co = fakeCheckout();
    const base = checkoutState(co.root);
    expect(checkoutState(co.root)).toBe(base);
    mkdirSync(join(co.root, "empty-dir"));
    expect(checkoutState(co.root)).not.toBe(base);
    execFileSync("rmdir", [join(co.root, "empty-dir")]);
    // An edit to a file that already has uncommitted changes (same `git status` line) is detected too.
    const f = join(co.lean, "Defs", "Core", "Formula.lean");
    writeFileSync(f, readFileSync(f, "utf8") + "\n-- local work\n");
    const dirty = checkoutState(co.root);
    writeFileSync(f, readFileSync(f, "utf8") + "-- a test edits it again\n");
    expect(checkoutState(co.root)).not.toBe(dirty);
    co.git("checkout", "--", "lean/Defs/Core/Formula.lean");
    // An edit inside an untracked file is detected.
    writeFileSync(join(co.root, "scratch.txt"), "a");
    const withUntracked = checkoutState(co.root);
    writeFileSync(join(co.root, "scratch.txt"), "b");
    expect(checkoutState(co.root)).not.toBe(withUntracked);
    execFileSync("rm", [join(co.root, "scratch.txt")]);
    writeFileSync(join(co.root, "lean", "Proofs", "L_core_001.lean"), "x");
    const withFile = checkoutState(co.root);
    expect(withFile).not.toBe(base);
    co.git("add", "-A");
    co.git("-c", "user.name=bot", "-c", "user.email=b@x", "commit", "-qm", "bot");
    expect(checkoutState(co.root)).not.toBe(withFile);
  });

  it("the sandbox can never be placed inside the checkout", async () => {
    const co = fakeCheckout();
    const c = new ProofCommitter(co.lean, { mode: "sandbox", authorName: "x", authorEmail: "x@x", sandboxDir: join(co.root, "sandbox") });
    await expect(c.targetLeanDir()).rejects.toThrow(/inside the checkout/);
    const own = new ProofCommitter(co.lean, { mode: "sandbox", authorName: "x", authorEmail: "x@x", sandboxDir: join(REPO_LEAN_DIR, "..", "tmp-sandbox-should-fail") });
    await expect(own.targetLeanDir()).rejects.toThrow(/inside the checkout/);
    expect(co.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(existsSync(join(co.root, "sandbox"))).toBe(false); // refused before creating anything
    expect(existsSync(join(REPO_LEAN_DIR, "..", "tmp-sandbox-should-fail"))).toBe(false);
  });

  it("a proof waits until its approved statement file is in the checkout (CI re-checks against it)", async () => {
    const co = fakeCheckout();
    // The statement exists in the DB (approved) but not in this checkout yet.
    execFileSync("git", ["-C", co.root, "rm", "-q", "lean/Statements/L_core_001.lean"]);
    execFileSync("git", ["-C", co.root, "-c", "user.name=dev", "-c", "user.email=dev@example.invalid", "commit", "-qm", "drop statement"]);
    const { desk, db } = await setup({ leanDir: tempLeanDir(), config: { PROOF_COMMIT_MODE: "commit", HATCHERY_REAL_RUN: "1", GIT_COMMIT: "" } });
    // point the committer at the fake checkout
    (desk as unknown as { committer: ProofCommitter }).committer = new ProofCommitter(co.lean, { mode: "commit", authorName: "Hatchery Judge", authorEmail: "j@x" });
    expect((await proveFirst(desk)).verdict).toBe("pass");
    expect(existsSync(join(co.lean, "Proofs", "L_core_001.lean"))).toBe(false); // deferred
    expect(await desk.reconcileProofs()).toMatchObject({ deferred: ["L_core_001"] });
    // A maintainer commits the approved statement; the next reconcile commits the proof.
    const [st] = await db.select().from(statements).where(eq(statements.id, "L-core-001"));
    writeFileSync(join(co.lean, "Statements", "L_core_001.lean"), st!.source);
    co.git("add", "-A");
    co.git("-c", "user.name=maintainer", "-c", "user.email=m@example.invalid", "commit", "-qm", "statements: L-core-001");
    expect(await desk.reconcileProofs()).toMatchObject({ written: ["L_core_001"], deferred: [] });
    expect(co.git("log", "-1", "--format=%an|%s")).toBe("Hatchery Judge|proof: L_core_001 (reconciled with the desk database)");
  });

  it("server push: only lean/Proofs/ changes reach the remote", async () => {
    const co = fakeCheckout();
    const remote = mkdtempSync(join(tmpdir(), "hatchery-remote-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    co.git("remote", "add", "origin", remote);
    co.git("push", "-q", "origin", "main");
    // Unrelated local work stays local.
    writeFileSync(join(co.root, "notes.txt"), "wip\n");
    co.git("add", "notes.txt");
    const c = new ProofCommitter(co.lean, { mode: "commit", authorName: "Hatchery Judge", authorEmail: "j@x", push: { remote: "origin", branch: "main" } });
    const stmt = readFileSync(join(co.lean, "Statements", "L_core_001.lean"), "utf8");
    const r = await c.publish("L_core_001", PASS, stmt, "proof: L_core_001 checked");
    expect(r).toMatchObject({ deferred: false, pushed: true });
    const files = execFileSync("git", ["-C", remote, "show", "--name-only", "--format=%an", "main"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    expect(files).toEqual(["Hatchery Judge", "lean/Proofs/L_core_001.lean"]);
    expect(co.git("diff", "--cached", "--name-only")).toBe("notes.txt");
  });

  it("reconcile never deletes proofs the database knows nothing about (fresh or restored DB)", async () => {
    const co = fakeCheckout();
    mkdirSync(join(co.lean, "Proofs"), { recursive: true });
    writeFileSync(join(co.lean, "Proofs", "L_core_005.lean"), "-- committed long ago\n");
    co.git("add", "-A");
    co.git("-c", "user.name=dev", "-c", "user.email=dev@example.invalid", "commit", "-qm", "old proof");
    const c = new ProofCommitter(co.lean, { mode: "commit", authorName: "Hatchery Judge", authorEmail: "j@x" });
    expect(await c.reconcile(new Map(), new Set())).toEqual({ written: [], removed: [], deferred: [] });
    expect(existsSync(join(co.lean, "Proofs", "L_core_005.lean"))).toBe(true);
    // ...but it does remove one the DB says is no longer checked.
    expect((await c.reconcile(new Map(), new Set(["L_core_005"]))).removed).toEqual(["L_core_005"]);
  });

  it("export into the checkout is refused without HATCHERY_REAL_RUN=1", () => {
    let out = "";
    try {
      execFileSync("npx", ["tsx", "src/cli.ts", "export-statements", "--to", "../../lean"], {
        cwd: join(REPO_LEAN_DIR, "..", "apps", "desk"), encoding: "utf8", stdio: "pipe", env: { ...process.env, HATCHERY_REAL_RUN: "0", DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" },
      });
    } catch (err) {
      out = String((err as { stderr?: string }).stderr);
    }
    expect(out).toMatch(/inside this checkout: set HATCHERY_REAL_RUN=1/);
  });
});

/** A lean/ copy with a repo statement that uses a definition (so it needs review). */
function leanWithCircuitStatement() {
  const dir = tempLeanDir();
  writeFileSync(
    join(dir, "Statements", "L_circ_001.lean"),
    "-- program: circuit-lower-bounds\n-- title: Parity is not in AC0\n-- depends_on:\nimport Defs.Core.Circuit\ndef Statement.L_circ_001 : Prop := ¬ Hatchery.Defs.InAC0 Hatchery.Defs.parity\n",
  );
  return dir;
}

describe("definitions are drafts until a math advisor approves them", () => {
  it("every definition starts as a draft; statements using one are proposed and never leased", async () => {
    const { desk, review } = await setup({ leanDir: leanWithCircuitStatement() });
    const defs = await review.definitionList();
    expect(defs.map((d) => [d.id, d.status, d.draft])).toEqual([
      ["Defs.Core.Circuit", "draft", true],
      ["Defs.Core.Formula", "draft", true],
      ["Defs.Core.Resolution", "draft", true],
      ["Defs.Mathlib.Complexity", "draft", true],
    ]);
    expect(defs.find((d) => d.id === "Defs.Core.Circuit")!.summary).toMatch(/^A Boolean circuit on n inputs/);
    const st = await review.statementDetail("L-circ-001");
    expect(st).toMatchObject({ status: "proposed", usesDraftDefinition: true, canApprove: false });
    expect(st.approvalBlockers.join()).toMatch(/uses a draft definition: Defs.Core.Circuit is a draft/);
    // Leasing: the core warm-up lemmas only, never L-circ-001.
    await desk.registerAgent("agent-a", "fake-model");
    const leasedIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const ctx = await desk.lease("agent-a");
      if (!ctx) break;
      leasedIds.push(ctx.lemmaId);
      await desk.release("agent-a", ctx.lemmaId, "", false);
      await desk.db.update(lemmas).set({ status: "checked" }).where(eq(lemmas.id, ctx.lemmaId));
    }
    expect(leasedIds).toEqual(["L-core-001", "L-core-002", "L-core-003", "L-core-004", "L-core-005"]);
  });

  it("review flow: only an advisor approves definitions; a statement needs every definition approved", async () => {
    const { desk, review, db } = await setup({ leanDir: leanWithCircuitStatement() });
    const advisor = (await review.redeemInvite(new URL((await review.addReviewer("Dr. Ada", "advisor")).inviteUrl).hash.slice(1))).reviewer;
    const maint = (await review.redeemInvite(new URL((await review.addReviewer("Max", "maintainer")).inviteUrl).hash.slice(1))).reviewer;
    await review.runPendingChecks();
    const def = await review.definitionDetail("Defs.Core.Circuit");
    expect(def.declarations.map((d) => d.name)).toContain("InAC0");
    expect(def.declarations.find((d) => d.name === "parity")!.doc).toMatch(/odd number/);
    const st = await review.statementDetail("L-circ-001");

    await expect(review.reviewStatement(maint, "L-circ-001", "approve", "", st.sourceSha256)).rejects.toThrow(/uses a draft definition/);
    await expect(review.reviewDefinition(maint, "Defs.Core.Circuit", "approve", "", def.sourceSha256)).rejects.toThrow(/only a math advisor/);
    await expect(review.reviewDefinition(advisor, "Defs.Core.Circuit", "approve", "", "0".repeat(64))).rejects.toThrow(/changed since you opened it/);
    await expect(review.reviewDefinition(advisor, "Defs.Core.Circuit", "request_changes", "", def.sourceSha256)).rejects.toThrow(/say what should change/);

    const approved = await review.reviewDefinition(advisor, "Defs.Core.Circuit", "approve", "Matches the standard definition (unbounded fan-in).", def.sourceSha256);
    expect(approved).toMatchObject({ status: "approved", draft: false });
    const st2 = await review.statementDetail("L-circ-001");
    expect(st2).toMatchObject({ canApprove: true, usesDraftDefinition: false });
    const done = await review.reviewStatement(maint, "L-circ-001", "approve", "", st2.sourceSha256);
    expect(done).toMatchObject({ status: "approved", approvedBy: "Max (maintainer)", lemmaStatus: "open" });
    // Now it is leasable.
    await db.update(lemmas).set({ status: "checked" }).where(eq(lemmas.id, "L-core-001"));
    await db.update(lemmas).set({ status: "checked" }).where(eq(lemmas.id, "L-core-002"));
    await db.update(lemmas).set({ status: "checked" }).where(eq(lemmas.id, "L-core-003"));
    await db.update(lemmas).set({ status: "checked" }).where(eq(lemmas.id, "L-core-004"));
    await db.update(lemmas).set({ status: "checked" }).where(eq(lemmas.id, "L-core-005"));
    await desk.registerAgent("agent-a", "fake-model");
    expect((await desk.lease("agent-a"))!.lemmaId).toBe("L-circ-001");
    expect((await db.select().from(reviews)).map((r) => r.decision)).toEqual(["approve", "approve"]);
  });

  it("editing a definition makes it a draft again and sends its statements back to review", async () => {
    const lean = leanWithCircuitStatement();
    const { desk, review, db } = await setup({ leanDir: lean });
    const adv = (await review.redeemInvite(new URL((await review.addReviewer("Dr. Ada", "advisor")).inviteUrl).hash.slice(1))).reviewer;
    await review.runPendingChecks();
    await review.reviewDefinition(adv, "Defs.Core.Circuit", "approve", "", (await review.definitionDetail("Defs.Core.Circuit")).sourceSha256);
    await review.reviewStatement(adv, "L-circ-001", "approve", "", (await review.statementDetail("L-circ-001")).sourceSha256);
    const f = join(lean, "Defs", "Core", "Circuit.lean");
    writeFileSync(f, readFileSync(f, "utf8").replace("c.size ≤ n ^ k + k", "c.size ≤ n ^ k + 2 * k"));
    await desk.syncDefinitions();
    expect((await review.definitionDetail("Defs.Core.Circuit"))).toMatchObject({ status: "draft", draft: true });
    expect((await review.statementDetail("L-circ-001")).status).toBe("proposed");
    const ev = await db.select().from(events).where(eq(events.type, "statement_reviewed"));
    expect(ev.at(-1)!.payload).toMatchObject({ decision: "back_to_review" });
  });

  it("a definition that imports a draft definition is a draft too", async () => {
    const lean = tempLeanDir();
    writeFileSync(join(lean, "Defs", "Core", "Extra.lean"), "/-!\ntitle: Extra\nsummary: Uses circuits.\n-/\nimport Defs.Core.Circuit\nnamespace Hatchery.Defs\ndef two : Nat := 2\nend Hatchery.Defs\n");
    const { review } = await setup({ leanDir: lean });
    const adv = (await review.redeemInvite(new URL((await review.addReviewer("Dr. Ada", "advisor")).inviteUrl).hash.slice(1))).reviewer;
    await review.reviewDefinition(adv, "Defs.Core.Extra", "approve", "", (await review.definitionDetail("Defs.Core.Extra")).sourceSha256);
    const d = await review.definitionDetail("Defs.Core.Extra");
    expect(d).toMatchObject({ status: "approved", draft: true });
    expect(d.draftReasons.join()).toMatch(/uses Defs.Core.Circuit, which is a draft/);
  });
});

describe("review tool over HTTP (invite link, cookie session, CSRF header)", () => {
  it("an advisor signs in with the invite link and reviews in the browser; the public API shows drafts", async () => {
    const { desk, review } = await setup({ leanDir: leanWithCircuitStatement() });
    const app = buildServer(desk, review);
    const { inviteUrl } = await review.addReviewer("Dr. Ada", "advisor");
    const token = new URL(inviteUrl).hash.slice(1);
    expect(inviteUrl).toMatch(/^http:\/\/localhost:5173\/review\/join#/);

    expect((await app.inject({ method: "GET", url: "/review/queue" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/review/join", payload: { token } })).statusCode).toBe(403); // no CSRF header
    const join = await app.inject({ method: "POST", url: "/review/join", payload: { token }, headers: { "x-hatchery-review": "1" } });
    expect(join.json()).toEqual({ name: "Dr. Ada", role: "advisor" });
    const setCookie = String(join.headers["set-cookie"]);
    expect(setCookie).toMatch(/hatchery_review=.+; Path=\/; HttpOnly; SameSite=Strict/);
    const cookie = setCookie.split(";")[0]!;
    // A used invite link does not work twice.
    expect((await app.inject({ method: "POST", url: "/review/join", payload: { token }, headers: { "x-hatchery-review": "1" } })).statusCode).toBe(401);

    const queue = (await app.inject({ method: "GET", url: "/review/queue", headers: { cookie } })).json();
    expect(queue.definitions).toHaveLength(4);
    expect(queue.statements.map((s: { id: string }) => s.id)).toEqual(["L-circ-001"]);
    const def = (await app.inject({ method: "GET", url: "/review/definitions/Defs.Core.Circuit", headers: { cookie } })).json();
    const body = { decision: "approve", comment: "ok", sha256: def.sourceSha256 };
    expect((await app.inject({ method: "POST", url: "/review/definitions/Defs.Core.Circuit", headers: { cookie }, payload: body })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/review/definitions/Defs.Core.Circuit", headers: { cookie, "x-hatchery-review": "1" }, payload: body });
    expect(ok.json()).toMatchObject({ status: "approved", draft: false });

    const pub = (await app.inject({ method: "GET", url: "/definitions" })).json();
    expect(pub.map((d: { id: string; draft: boolean }) => [d.id, d.draft])).toEqual([
      ["Defs.Core.Circuit", false], ["Defs.Core.Formula", true], ["Defs.Core.Resolution", true], ["Defs.Mathlib.Complexity", true],
    ]);
    expect((await app.inject({ method: "POST", url: "/review/logout", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/review/queue", headers: { cookie } })).statusCode).toBe(401);
    await app.close();
  });
});

describe("decomposer: proposals go to the review queue; only approved statements are leased (Phase 3 acceptance)", () => {
  it("proposal -> automatic check -> queue; trivial, broken and duplicate ones are auto-rejected", async () => {
    const { desk, review, db } = await setup();
    await desk.registerAgent("decomposer-1", "fake-model");
    const base = { program: "circuit-lower-bounds", imports: ["Defs.Core.Circuit"], rationale: "first step towards Håstad" };
    const ok = await review.propose("decomposer-1", { ...base, title: "Parity not in AC0", prop: "¬ Hatchery.Defs.InAC0 Hatchery.Defs.parity" });
    expect(ok).toMatchObject({ id: "L-circ-001", status: "proposed" });
    const [row] = await db.select().from(statements).where(eq(statements.id, "L-circ-001"));
    expect(row!.source).toBe(
      "-- program: circuit-lower-bounds\n-- title: Parity not in AC0\n-- depends_on: \n-- proposed by: decomposer-1 (decomposer); needs human approval\nimport Defs.Core.Circuit\n\ndef Statement.L_circ_001 : Prop :=\n  ¬ Hatchery.Defs.InAC0 Hatchery.Defs.parity\n",
    );
    expect(await review.propose("decomposer-1", { ...base, title: "t", prop: "TRIVIAL = TRIVIAL" })).toMatchObject({ id: "L-circ-002", status: "rejected", rejectReason: "trivial: closed automatically by decide" });
    expect(await review.propose("decomposer-1", { ...base, title: "b", prop: "BROKEN" })).toMatchObject({ status: "rejected", rejectReason: expect.stringMatching(/^does not elaborate/) });
    expect(await review.propose("decomposer-1", { ...base, title: "dup", prop: "¬  Hatchery.Defs.InAC0   Hatchery.Defs.parity" })).toMatchObject({ status: "rejected", rejectReason: "duplicate of L-circ-001" });
    const q = await review.queue();
    expect(q.statements.map((s) => s.id)).toEqual(["L-circ-001"]);
    expect((await db.select().from(lemmas).where(eq(lemmas.id, "L-circ-001"))).length).toBe(0); // no lemma before approval

    // Only approved statements get leased: mark the warm-up lemmas done; nothing is leasable.
    await db.update(lemmas).set({ status: "checked" });
    expect(await desk.lease("decomposer-1")).toBeNull();
    const adv = (await review.redeemInvite(new URL((await review.addReviewer("Dr. Ada", "advisor")).inviteUrl).hash.slice(1))).reviewer;
    await review.reviewDefinition(adv, "Defs.Core.Circuit", "approve", "", (await review.definitionDetail("Defs.Core.Circuit")).sourceSha256);
    await review.reviewStatement(adv, "L-circ-001", "approve", "", (await review.statementDetail("L-circ-001")).sourceSha256);
    expect((await desk.lease("decomposer-1"))!.lemmaId).toBe("L-circ-001");
  });

  it("proposal rate limit", async () => {
    const { desk, review } = await setup({ config: { MAX_PROPOSALS_PER_HOUR: "1" } });
    await desk.registerAgent("decomposer-1", "fake-model");
    const p = { program: "proof-complexity", imports: ["Defs.Core.Resolution"], title: "PHP unsat", rationale: "", prop: "∀ n, Hatchery.Defs.CNF.Unsat (Hatchery.Defs.php (n + 1) n)" };
    await review.propose("decomposer-1", p);
    await expect(review.propose("decomposer-1", { ...p, prop: `${p.prop} ∧ True` })).rejects.toThrow(/proposal limit/);
  });

  it("split request: an agent asks, the decomposer proposes smaller statements linked to it", async () => {
    const { desk, review, db } = await setup();
    await desk.registerAgent("agent-a", "fake-model");
    const ctx = await desk.lease("agent-a");
    const attemptId = await desk.startAttempt("agent-a", ctx!.lemmaId);
    const { splitRequestId } = await review.requestSplit("agent-a", attemptId, "the induction step needs a separate lemma about sums");
    expect((await review.requestSplit("agent-a", attemptId, "again")).splitRequestId).toBe(splitRequestId); // one open request per lemma
    const context = await review.decomposerContext();
    expect(context.splitRequests).toMatchObject([{ id: splitRequestId, lemmaId: ctx!.lemmaId }]);
    expect(context.programs.map((p) => p.slug)).toEqual(["circuit-lower-bounds", "monotone-circuits", "proof-complexity", "barriers"]);
    expect(context.definitions.find((d) => d.id === "Defs.Core.Circuit")!.source).toContain("def InAC0");
    await desk.registerAgent("decomposer-1", "fake-model");
    const p = await review.propose("decomposer-1", {
      program: "proof-complexity", title: "helper", imports: ["Defs.Core.Resolution"], rationale: "split of L-core-001",
      prop: "Hatchery.Defs.CNF.Unsat (Hatchery.Defs.php 2 1)", parentId: ctx!.lemmaId, splitRequestId,
    });
    const [sr] = await db.select().from(splitRequests).where(eq(splitRequests.id, splitRequestId));
    expect(sr).toMatchObject({ status: "done", proposals: [p.id] });
    const [st] = await db.select().from(statements).where(eq(statements.id, p.id));
    expect(st).toMatchObject({ parentId: ctx!.lemmaId, dependsOn: [ctx!.lemmaId], status: "proposed" });
    void definitions;
  });
});

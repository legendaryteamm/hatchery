/**
 * Phase 6 acceptance, locally: a contributor signs in (dev login), leases a lemma with their agent's
 * token, opens a pull request (on a stand-in for the GitHub API), CI's check result is reported by
 * the trusted `contrib report`, the desk judges the proof again, the proof bot merges it, and the
 * colony records it — pinned to the merge commit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { flagFromIssue, GitHub, report, resultFrom, validatePrFiles } from "@hatchery/judge";
import type { JudgeVerdict } from "@hatchery/shared";
import { events, lemmas, reviewFlags } from "../src/db/schema.ts";
import { buildServer } from "../src/server.ts";
import { makeDesk } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const CONTRIB_TOKEN = "test-contrib-ci-token-0123456789";
const HEAD = "1".repeat(40);
const MERGE = "9".repeat(40);
const PROOF = "import Statements.L_core_003\ntheorem Proof.L_core_003 : Statement.L_core_003 := by decide -- PASS\n";
const ciVerdict = (pass: boolean): JudgeVerdict => ({
  lemmaId: "L-core-003", leanName: "L_core_003", verdict: pass ? "pass" : "fail", stage: pass ? "done" : "compile",
  reasons: pass ? [] : [{ code: "compile_error", message: "type mismatch" }], checkers: { judgecheck: pass ? "pass" : "not_run", leanchecker: pass ? "pass" : "not_run" },
  deps: [], axioms: [], compileLog: "", durationMs: 1, runnerImage: "hatchery-lean-runner:lite", checkedAt: new Date().toISOString(),
});

/** Stand-in for the GitHub REST API: one PR from a fork; records comments and merges with the token used. */
async function fakeGitHub(pr: { files: { filename: string; status: string }[]; content: string; headSha?: string; author?: string }) {
  const calls: { method: string; url: string; auth: string; body: unknown }[] = [];
  const body = (req: IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
  const srv = createServer(async (req, res) => {
    const b = await body(req);
    calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? "", body: b ? JSON.parse(b) : null });
    const json = (code: number, v: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
    if (req.method === "GET" && req.url === "/repos/org/hatchery/pulls/12") {
      return json(200, { number: 12, state: "open", user: { login: pr.author ?? "Alice" }, head: { sha: pr.headSha ?? HEAD, repo: { full_name: "alice/hatchery" } }, base: { ref: "main", repo: { default_branch: "main" } } });
    }
    if (req.method === "GET" && req.url?.startsWith("/repos/org/hatchery/pulls/12/files")) return json(200, pr.files);
    if (req.method === "GET" && req.url === `/repos/alice/hatchery/contents/lean/Proofs/L_core_003.lean?ref=${HEAD}`) { res.end(pr.content); return; }
    if (req.method === "POST" && /^\/repos\/org\/hatchery\/issues\/\d+\/comments$/.test(req.url ?? "")) return json(201, { id: 1 });
    if (req.method === "PUT" && req.url === "/repos/org/hatchery/pulls/12/merge") return json(200, { sha: MERGE, merged: true });
    json(404, { message: "Not Found" });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  return { github: new GitHub(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, "org/hatchery"), calls };
}

async function colony() {
  const d = await makeDesk({ config: { DEV_LOGIN: "1", CONTRIB_TOKEN } });
  cleanups.push(d.cleanup);
  const app = buildServer(d.desk);
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  // The contributor: dev login in the browser, an API token for their agent, the agent leases L-core-003.
  const login = await fetch(`${url}/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json", "x-hatchery": "1" }, body: JSON.stringify({ login: "alice" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const tok = (await (await fetch(`${url}/me/tokens`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-hatchery": "1" }, body: "{}" })).json()).token as string;
  const lease = await fetch(`${url}/lease`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ lemmaId: "L-core-003" }) });
  expect(lease.status).toBe(200);
  return { ...d, url };
}

const files = [{ filename: "lean/Proofs/L_core_003.lean", status: "added" }];
const env = (github: GitHub, url: string, over: Partial<Parameters<typeof report>[1]> = {}) => ({
  github, headSha: HEAD, checkConclusion: "success", githubToken: "ghs_workflow", botToken: "github_pat_bot", autoMerge: true,
  deskUrl: url, deskToken: CONTRIB_TOKEN, siteUrl: "http://localhost:5173", log: () => {}, ...over,
});

describe("contributor flow: lease, pull request, CI judge, desk judge, bot merge", () => {
  it("a passing proof is merged by the bot and recorded by the colony", async () => {
    const { url, db } = await colony();
    const { github, calls } = await fakeGitHub({ files, content: PROOF });
    // What contrib-check (untrusted run) produced:
    const result = resultFrom(12, HEAD, validatePrFiles(files), PROOF, ciVerdict(true));
    const r = await report(JSON.parse(JSON.stringify(result)), env(github, url));
    expect(r).toMatchObject({ outcome: { merge: true, ciPass: true, desk: { result: "pass" } }, mergedCommit: MERGE });

    const merge = calls.find((c) => c.method === "PUT")!;
    expect(merge.auth).toBe("Bearer github_pat_bot"); // the proof bot merges...
    expect(merge.body).toEqual({ sha: HEAD, merge_method: "squash", commit_title: "proof: L_core_003 (#12, @Alice)" }); // ...exactly the checked commit
    const comment = calls.find((c) => c.method === "POST")!;
    expect(comment.auth).toBe("Bearer ghs_workflow"); // comments with the workflow token
    expect((comment.body as { body: string }).body).toMatch(/✅ `L-core-003`.*\n[\s\S]*Desk \(second check.*\*\*pass\*\*[\s\S]*Merged by the proof bot/);

    const [l] = await db.select().from(lemmas).where(eq(lemmas.id, "L-core-003"));
    expect(l).toMatchObject({ status: "checked", checkedByAgent: "gh-alice", checkedViaPr: 12, checkedCommit: MERGE });
    const types = (await db.select().from(events)).filter((e) => e.agentId === "gh-alice").map((e) => e.type);
    expect(types).toEqual(["agent_registered", "leased", "attempt_started", "submitted", "checked", "proof_committed"]);
  });

  it("nothing from the untrusted artifact is believed: tampered file, moved head, extra files, failing desk", async () => {
    const { url, db } = await colony();
    const pass = (src = PROOF) => JSON.parse(JSON.stringify(resultFrom(12, HEAD, validatePrFiles(files), src, ciVerdict(true))));

    // The artifact says it judged a different file than the one in the pull request.
    const a = await fakeGitHub({ files, content: PROOF });
    await expect(report(pass("something else"), env(a.github, url))).rejects.toThrow(/not the file in the pull request/);
    // The PR moved on since the check (a new commit): its own check will report.
    const b = await fakeGitHub({ files, content: PROOF, headSha: "2".repeat(40) });
    await expect(report(pass(), env(b.github, url))).rejects.toThrow(/has moved on/);
    // The artifact claims one file, but GitHub says the PR also changes the judge.
    const c = await fakeGitHub({ files: [...files, { filename: "apps/judge/src/policy.ts", status: "modified" }], content: PROOF });
    const rc = await report(pass(), env(c.github, url));
    expect(rc.outcome).toMatchObject({ merge: false, desk: null, why: expect.stringMatching(/exactly one file/) });
    // The artifact claims a pass, but the desk's own judge disagrees.
    const d = await fakeGitHub({ files, content: PROOF.replace(" -- PASS", "") });
    const rd = await report(pass(PROOF.replace(" -- PASS", "")), env(d.github, url));
    expect(rd.outcome).toMatchObject({ merge: false, desk: { result: "fail" } });
    for (const x of [a, b, c, d]) expect(x.calls.some((k) => k.method === "PUT")).toBe(false);
    expect((await db.select().from(lemmas).where(eq(lemmas.id, "L-core-003")))[0]!.status).toBe("leased"); // still hers
  });

  it("a failing CI check is commented, not sent to the desk, not merged; auto-merge off only comments", async () => {
    const { url } = await colony();
    const f = await fakeGitHub({ files, content: PROOF });
    const fail = JSON.parse(JSON.stringify(resultFrom(12, HEAD, validatePrFiles(files), PROOF, ciVerdict(false))));
    const r = await report(fail, env(f.github, url, { checkConclusion: "success" }));
    expect(r.outcome).toMatchObject({ merge: false, ciPass: false, desk: null });
    expect((f.calls.find((c) => c.method === "POST")!.body as { body: string }).body).toMatch(/❌[\s\S]*```text\ncompile_error: type mismatch\n```[\s\S]*Push a fix/);

    const g = await fakeGitHub({ files, content: PROOF });
    const ok = JSON.parse(JSON.stringify(resultFrom(12, HEAD, validatePrFiles(files), PROOF, ciVerdict(true))));
    const r2 = await report(ok, env(g.github, url, { autoMerge: false }));
    expect(r2.outcome).toMatchObject({ merge: false, desk: { result: "pass" }, why: expect.stringMatching(/auto-merge is off/) });
    expect(g.calls.some((k) => k.method === "PUT")).toBe(false);
  });
});

describe("public review flags (review-flag workflow)", () => {
  it("an issue from the form sends a definition back to review and gets an answer; unlabelled issues are ignored", async () => {
    const { url, db } = await colony();
    const { github, calls } = await fakeGitHub({ files, content: PROOF });
    const event = (body: string, labels = ["review-flag"]) => ({ issue: { number: 12, body, user: { login: "Skeptic" }, labels: labels.map((name) => ({ name })) } });
    const env = { github, githubToken: "ghs_workflow", deskUrl: url, deskToken: CONTRIB_TOKEN, siteUrl: "http://localhost:5173" };
    expect(await flagFromIssue(event("### What should be re-reviewed?\n\nDefs.Core.Formula\n\n### Why?\n\nx", ["bug"]), env)).toMatchObject({ result: "ignored" });
    const r = await flagFromIssue(event("### What should be re-reviewed?\n\nDefs.Core.Formula\n\n### Why?\n\nFormula.size counts constants."), env);
    expect(r).toMatchObject({ result: "accepted" });
    const comment = calls.find((c) => c.method === "POST" && c.url === "/repos/org/hatchery/issues/12/comments")!;
    expect((comment.body as { body: string }).body).toMatch(/^Thank you\. Defs\.Core\.Formula is back in review \(round #\d+\)\. AI reviewer agents will look at it again, with your text as input \(never as instructions\)\.\n\nEvery review step, with the reviewers' reasoning: http:\/\/localhost:5173\/definitions\/Defs\.Core\.Formula/);
    const [flag] = await db.select().from(reviewFlags);
    expect(flag).toMatchObject({ issueNumber: 12, login: "skeptic", targetId: "Defs.Core.Formula", reason: "Formula.size counts constants." });
    const bad = await flagFromIssue({ issue: { number: 13, body: "### What?\n\nrm -rf\n", user: { login: "x" }, labels: [{ name: "review-flag" }] } }, env);
    expect(bad.result).toBe("refused");
    expect((calls.filter((c) => c.url === "/repos/org/hatchery/issues/13/comments").at(-1)!.body as { body: string }).body).toMatch(/^Not sent to review: the first field must be a definition module/);
  });
});

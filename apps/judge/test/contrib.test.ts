import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { codeBlock, commentBody, decide, ResultSchema, resultFrom, validatePrFiles } from "../src/contrib.ts";

const run = promisify(execFile);

describe("which pull requests are judged at all", () => {
  it("exactly one NEW file lean/Proofs/L_*.lean, nothing else", () => {
    expect(validatePrFiles([{ filename: "lean/Proofs/L_core_003.lean", status: "added" }])).toEqual({ ok: true, path: "lean/Proofs/L_core_003.lean", leanName: "L_core_003", lemmaId: "L-core-003" });
    const bad: [string, string, RegExp][] = [
      ["lean/Proofs/L_core_003.lean", "modified", /must be a new file/],
      ["lean/Proofs/L_core_003.lean", "removed", /must be a new file/],
      ["lean/Statements/L_core_003.lean", "added", /only a new file lean\/Proofs/],
      ["lean/Proofs/L_fixture_009.lean", "added", /only a new file/],
      ["lean/Proofs/../Defs/X.lean", "added", /only a new file/],
      ["lean/Proofs/L_Core_003.lean", "added", /only a new file/],
      [".github/workflows/contrib-check.yml", "modified", /only a new file/],
    ];
    for (const [filename, status, re] of bad) expect(validatePrFiles([{ filename, status }]), filename).toMatchObject({ ok: false, reason: expect.stringMatching(re) });
    // A proof plus anything else (e.g. a changed workflow or judge) is refused outright.
    expect(validatePrFiles([{ filename: "lean/Proofs/L_core_003.lean", status: "added" }, { filename: "apps/judge/src/judge.ts", status: "modified" }])).toMatchObject({ ok: false, reason: expect.stringMatching(/exactly one file/) });
    expect(validatePrFiles([])).toMatchObject({ ok: false });
  });
});

describe("merge decision", () => {
  const files = validatePrFiles([{ filename: "lean/Proofs/L_core_003.lean", status: "added" }]);
  const all = { files, ciPass: true, desk: { result: "pass" as const, reason: "" }, deskConfigured: true, autoMerge: true, botToken: true };
  it("merges only when CI and the desk both pass, auto-merge is on and the bot has a token", () => {
    expect(decide(all)).toMatchObject({ merge: true });
    expect(decide({ ...all, ciPass: false })).toMatchObject({ merge: false, why: expect.stringMatching(/Lean judge did not accept/) });
    expect(decide({ ...all, desk: { result: "refused", reason: "leased by someone else" } })).toMatchObject({ merge: false, why: expect.stringMatching(/leased by someone else/) });
    expect(decide({ ...all, desk: null, deskConfigured: false })).toMatchObject({ merge: false, why: expect.stringMatching(/DESK_URL/) });
    expect(decide({ ...all, autoMerge: false })).toMatchObject({ merge: false, why: expect.stringMatching(/auto-merge is off/) });
    expect(decide({ ...all, botToken: false })).toMatchObject({ merge: false, why: expect.stringMatching(/PROOF_BOT_TOKEN/) });
  });

  it("judge output (which contains PR text) cannot break out of its code block in the comment", () => {
    const evil = "error\n```\n@everyone [click](http://evil) <img src=x>\n```";
    const block = codeBlock(evil);
    expect(block.startsWith("```text\n")).toBe(true);
    expect(block.slice(8, -4)).not.toContain("```");
    const body = commentBody({
      login: "alice",
      files,
      result: resultFrom(1, "a".repeat(40), files, "src", { lemmaId: "L-core-003", leanName: "L_core_003", verdict: "fail", stage: "compile", reasons: [{ code: "compile_error", message: evil }], checkers: { judgecheck: "not_run", leanchecker: "not_run" }, deps: [], axioms: [], compileLog: "", durationMs: 1, runnerImage: "lite", checkedAt: "" }),
      outcome: decide({ ...all, ciPass: false }),
      siteUrl: "https://hatchery.example",
    });
    expect(body.match(/```/g)).toHaveLength(2);
    expect(body).toContain("Nothing here says P vs NP is settled");
    expect(body).toContain("https://hatchery.example/join.txt");
  });

  it("the check result format is strict (it comes from an untrusted run)", () => {
    expect(ResultSchema.safeParse({ version: 1, prNumber: 1, headSha: "x", files: { ok: true }, sourceSha256: null, verdict: null }).success).toBe(false);
    expect(ResultSchema.safeParse(resultFrom(3, "b".repeat(40), files, "s", null)).success).toBe(true);
  });
});

const image = process.env.JUDGE_TEST_IMAGE ?? "hatchery-lean-runner:lite";
describe.skipIf(process.env.JUDGE_SKIP_DOCKER_TESTS === "1")(`contrib check with the real runner image (${image})`, () => {
  const dir = mkdtempSync(join(tmpdir(), "hatchery-contrib-check-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../scripts/contrib.ts", import.meta.url));
  const check = async (proof: string) => {
    writeFileSync(join(dir, "files.json"), JSON.stringify(validatePrFiles([{ filename: "lean/Proofs/L_core_001.lean", status: "added" }])));
    writeFileSync(join(dir, "proof.lean"), proof);
    const out = join(dir, "out", "result.json");
    await run("npx", ["tsx", cli, "check", "--pr", "5", "--head", "c".repeat(40), "--files", join(dir, "files.json"), "--proof", join(dir, "proof.lean"), "--out", out], {
      env: { ...process.env, JUDGE_IMAGE: image, JUDGE_MEMORY_MB: "4096" },
    });
    return ResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
  };

  it("passes a correct proof of a repository statement and rejects sorry", async () => {
    const ok = await check("import Statements.L_core_001\ntheorem Proof.L_core_001 : Statement.L_core_001 := fun a b => Nat.add_comm a b\n");
    expect(ok.verdict).toMatchObject({ verdict: "pass", runnerImage: image });
    const bad = await check("import Statements.L_core_001\ntheorem Proof.L_core_001 : Statement.L_core_001 := by sorry\n");
    expect(bad.verdict?.verdict).toBe("fail");
    expect(bad.verdict?.reasons.map((r) => r.code)).toContain("forbidden_token");
  });
});

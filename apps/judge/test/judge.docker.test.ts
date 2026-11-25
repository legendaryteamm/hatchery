/**
 * End-to-end judge tests against a real runner image (section 5 of BUILD_PROMPT.md).
 * Requires Docker and `hatchery-lean-runner:<flavor>` (build: pnpm runner:build:lite).
 *   JUDGE_TEST_IMAGE   runner image to test (default hatchery-lean-runner:lite)
 *   JUDGE_SKIP_DOCKER_TESTS=1  skip this file explicitly (it otherwise FAILS if the image is missing)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { JudgeConfig } from "../src/config.ts";
import { judge } from "../src/judge.ts";

const image = process.env.JUDGE_TEST_IMAGE ?? "hatchery-lean-runner:lite";
const skip = process.env.JUDGE_SKIP_DOCKER_TESTS === "1";
const config: JudgeConfig = {
  image, timeoutSeconds: 90, memoryMb: 2048, cpus: 2, concurrency: 1, queueMax: 0,
  apiToken: undefined, host: "127.0.0.1", port: 0,
};
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const sample = readFileSync(new URL("../../../lean/Proofs/L_fixture_001.lean", import.meta.url), "utf8");
const codes = (v: { reasons: { code: string }[] }) => v.reasons.map((r) => r.code);

let flavor = "unknown";

describe.skipIf(skip)(`judge end-to-end (${image})`, () => {
  beforeAll(() => {
    try {
      const out = execFileSync("docker", ["run", "--rm", "--network", "none", image, "version"], { encoding: "utf8" });
      flavor = /flavor=(\w+)/.exec(out)?.[1] ?? "unknown";
    } catch {
      throw new Error(`runner image ${image} is not available. Build it with: pnpm runner:build:lite (or set JUDGE_SKIP_DOCKER_TESTS=1)`);
    }
  });

  it("a correct proof passes", async () => {
    const v = await judge({ lemmaId: "L-fixture-001", source: sample }, config);
    expect(v.reasons).toEqual([]);
    expect(v).toMatchObject({ verdict: "pass", stage: "done", axioms: [] });
  });

  it("a definitionally-equal restatement passes; `decide` passes", async () => {
    expect((await judge({ lemmaId: "L-fixture-001", source: fixture("good-defeq.lean") }, config)).verdict).toBe("pass");
    expect((await judge({ lemmaId: "L-fixture-003", source: fixture("good-decide.lean") }, config)).verdict).toBe("pass");
  });

  it("sorry fails (static) and is also caught by the axiom check (sorryAx)", async () => {
    const s = await judge({ lemmaId: "L-fixture-001", source: fixture("sorry.lean") }, config);
    expect(s).toMatchObject({ verdict: "fail", stage: "static" });
    const deep = await judge({ lemmaId: "L-fixture-001", source: fixture("sorry.lean") }, config, { skipStaticChecks: true });
    expect(deep.verdict).toBe("fail");
    expect(codes(deep)).toContain("forbidden_axiom");
    expect(deep.axioms).toContain("sorryAx");
  });

  it("an extra axiom fails (static) and is also caught by the axiom check", async () => {
    expect((await judge({ lemmaId: "L-fixture-001", source: fixture("axiom.lean") }, config)).stage).toBe("static");
    const deep = await judge({ lemmaId: "L-fixture-001", source: fixture("axiom.lean") }, config, { skipStaticChecks: true });
    expect(codes(deep)).toContain("forbidden_axiom");
    expect(deep.axioms).toContain("Proof.L_fixture_001.cheat");
  });

  it("native_decide fails (static) and is also caught by the axiom check", async () => {
    expect((await judge({ lemmaId: "L-fixture-003", source: fixture("native-decide.lean") }, config)).stage).toBe("static");
    const deep = await judge({ lemmaId: "L-fixture-003", source: fixture("native-decide.lean") }, config, { skipStaticChecks: true });
    expect(deep.verdict).toBe("fail");
    expect(codes(deep)).toContain("forbidden_axiom");
    // Lean 4.36 emits one auxiliary axiom per native_decide use, e.g. `Proof.L_x._native.native_decide.ax_1_1`.
    expect(deep.axioms.some((a) => a.includes("native_decide"))).toBe(true);
  });

  it("a proof of a different statement fails", async () => {
    const v = await judge({ lemmaId: "L-fixture-001", source: fixture("wrong-statement.lean") }, config);
    expect(v).toMatchObject({ verdict: "fail", stage: "done" });
    expect(codes(v)).toContain("statement_mismatch");
    const w = await judge({ lemmaId: "L-fixture-001", source: fixture("weaker-statement.lean") }, config);
    expect(codes(w)).toContain("statement_mismatch");
  });

  it("redefining the trusted statement fails", async () => {
    const v = await judge({ lemmaId: "L-fixture-001", source: fixture("redefine-statement.lean") }, config);
    expect(v.verdict).toBe("fail");
    expect(codes(v)).toContain("import_conflict");
    expect(codes(v)).toContain("namespace_violation");
  });

  it("helpers outside the proof's own namespace fail", async () => {
    const v = await judge({ lemmaId: "L-fixture-001", source: fixture("outside-namespace.lean") }, config);
    expect(codes(v)).toEqual(["namespace_violation"]);
  });

  it("a compile error fails with the Lean error", async () => {
    const v = await judge({ lemmaId: "L-fixture-001", source: fixture("compile-error.lean") }, config);
    expect(v).toMatchObject({ verdict: "fail", stage: "compile" });
    expect(codes(v)).toEqual(["compile_error"]);
    expect(v.reasons[0]?.message).toMatch(/rfl_but_misspelled/);
  });

  it("a timeout fails cleanly and leaves no container behind", async () => {
    const t0 = Date.now();
    const v = await judge({ lemmaId: "L-fixture-001", source: fixture("timeout.lean") }, { ...config, timeoutSeconds: 15 });
    expect(v).toMatchObject({ verdict: "fail", stage: "compile" });
    expect(codes(v)).toEqual(["timeout"]);
    expect(Date.now() - t0).toBeLessThan(40_000);
    const left = execFileSync("docker", ["ps", "-aq", "--filter", "label=dev.hatchery.role=judge-sandbox"], { encoding: "utf8" });
    expect(left.trim()).toBe("");
  });

  it("exceeding the memory limit fails cleanly", async () => {
    const v = await judge({ lemmaId: "L-fixture-001", source: fixture("memory.lean") }, { ...config, memoryMb: 1024 });
    expect(v).toMatchObject({ verdict: "fail", stage: "compile" });
    expect(codes(v)).toEqual(["memory_limit"]);
  });

  it("sandbox has no network", async () => {
    const out = execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", image, "/proc/net/route"], { encoding: "utf8" });
    expect(out.trim().split("\n").length).toBe(1); // header only: no routes
  });

  it("Mathlib proof passes (full image only)", async (ctx) => {
    if (flavor !== "full") ctx.skip();
    const v = await judge({ lemmaId: "L-fixture-002", source: fixture("mathlib.lean") }, { ...config, memoryMb: 6144, timeoutSeconds: 300 });
    expect(v.reasons).toEqual([]);
  });
});

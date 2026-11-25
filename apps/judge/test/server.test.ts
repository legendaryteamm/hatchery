import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";
import type { ContainerRunner } from "../src/docker.ts";
import type { JudgeConfig } from "../src/config.ts";

const config: JudgeConfig = {
  image: "fake", timeoutSeconds: 5, memoryMb: 512, cpus: 1, concurrency: 1, queueMax: 1,
  apiToken: "secret", host: "127.0.0.1", port: 0,
};
const report = { imports: ["Init"], isModule: false, constants: ["Proof.L_fixture_001"], unsafeOrPartial: [], replay: "ok",
  theoremFound: true, theoremKind: "theorem", typeDefEq: "yes", axioms: [], missing: [], error: "" };
const fakeRunner: ContainerRunner = async (_image, args) => ({
  exitCode: 0, stderr: "", timedOut: false, oomKilled: false, stdoutOverflow: false,
  stdout: Buffer.from(args[0] === "version" ? `Lean (version 4.36.0, x)\nflavor=lite\ntrusted_sha=${"a".repeat(64)}\n`
    : args[0] === "search" ? "Init/Foo.lean:1:theorem foo" : args[0] === "compile" ? "OLEAN" : `HATCHERY_TYPECHECK ok\nHATCHERY_LEANCHECKER ok\nHATCHERY_REPORT ${JSON.stringify(report)}\n`),
});
const source = "import Statements.L_fixture_001\ntheorem Proof.L_fixture_001 : Statement.L_fixture_001 := fun n => Nat.add_zero n\n";
const statements = [{ lemmaId: "L-fixture-001", source: "def Statement.L_fixture_001 : Prop := ∀ n : Nat, n + 0 = n\n" }];

describe("judge HTTP API", () => {
  const app = buildServer(config, { runner: fakeRunner });
  const post = (payload: unknown, auth = "Bearer secret") =>
    app.inject({ method: "POST", url: "/check", payload: payload as object, headers: { authorization: auth } });

  it("requires the API token when configured", async () => {
    expect((await post({ lemmaId: "L-fixture-001", source, statements }, "Bearer nope")).statusCode).toBe(401);
  });
  it("validates input with zod", async () => {
    expect((await post({ lemmaId: "../../etc", source, statements })).statusCode).toBe(400);
    expect((await post({ lemmaId: "L-fixture-001", source: "", statements })).statusCode).toBe(400);
    expect((await post({ lemmaId: "L-fixture-001", source: "x".repeat(200_001), statements })).statusCode).toBe(400);
  });
  it("returns a verdict", async () => {
    const res = await post({ lemmaId: "L-fixture-001", source, statements });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      verdict: "pass", leanName: "L_fixture_001", stage: "done", reasons: [],
      checkers: { judgecheck: "pass", leanchecker: "pass" },
    });
  });
  it("health reports the runner flavor and trusted hash", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ ok: true, flavor: "lite", trustedSha: "a".repeat(64) });
  });
  it("search validates and requires the token", async () => {
    const auth = { authorization: "Bearer secret" };
    expect((await app.inject({ method: "GET", url: "/search?q=foo" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/search?q=" + "x".repeat(101), headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/search?q=foo", headers: auth })).json()).toEqual({ results: "Init/Foo.lean:1:theorem foo" });
  });
});

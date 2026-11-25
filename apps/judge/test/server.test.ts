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
  stdout: Buffer.from(args[0] === "compile" ? "OLEAN" : `HATCHERY_TYPECHECK ok\nHATCHERY_REPORT ${JSON.stringify(report)}\n`),
});
const source = "import Statements.L_fixture_001\ntheorem Proof.L_fixture_001 : Statement.L_fixture_001 := fun n => Nat.add_zero n\n";

describe("judge HTTP API", () => {
  const app = buildServer(config, { runner: fakeRunner });
  const post = (payload: unknown, auth = "Bearer secret") =>
    app.inject({ method: "POST", url: "/check", payload: payload as object, headers: { authorization: auth } });

  it("requires the API token when configured", async () => {
    expect((await post({ lemmaId: "L-fixture-001", source }, "Bearer nope")).statusCode).toBe(401);
  });
  it("validates input with zod", async () => {
    expect((await post({ lemmaId: "../../etc", source })).statusCode).toBe(400);
    expect((await post({ lemmaId: "L-fixture-001", source: "" })).statusCode).toBe(400);
    expect((await post({ lemmaId: "L-fixture-001", source: "x".repeat(200_001) })).statusCode).toBe(400);
  });
  it("returns a verdict", async () => {
    const res = await post({ lemmaId: "L-fixture-001", source });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verdict: "pass", leanName: "L_fixture_001", stage: "done", reasons: [] });
  });
  it("health", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ ok: true });
  });
});

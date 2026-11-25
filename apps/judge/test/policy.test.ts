import { describe, expect, it } from "vitest";
import { evaluateCheck, importAllowed, inOwnNamespace, parseImports, staticChecks, type CheckReport } from "../src/policy.ts";
import { parseCheckOutput } from "../src/judge.ts";
import { Limiter, QueueFullError } from "../src/server.ts";

const L = "L_fixture_001";
const ok = `import Statements.L_fixture_001\ntheorem Proof.L_fixture_001 : Statement.L_fixture_001 := fun n => Nat.add_zero n\n`;
const codes = (src: string) => staticChecks(src, L).map((r) => r.code);

describe("staticChecks", () => {
  it("accepts a plain proof", () => expect(staticChecks(ok, L)).toEqual([]));

  it.each([
    ["sorry", "sorry"],
    ["sorryAx", "exact sorryAx _"],
    ["admit", "by admit"],
    ["native_decide", "by native_decide"],
    ["axiom", "axiom foo : False"],
    ["unsafe", "unsafe def x := 1"],
    ["unsafeBaseIO", "unsafeBaseIO (pure 1)"],
    ["implemented_by", "@[implemented_by f] def g := 1"],
    ["extern", '@[extern "c"] def g := 1'],
    ["debug option", "set_option debug.skipKernelTC true"],
    ["prelude", "prelude"],
    ["#eval", '#eval IO.println "x"'],
    ["run_cmd", "run_cmd pure ()"],
    ["elab", "elab \"x\" : tactic => pure ()"],
    ["macro", "macro \"x\" : tactic => `(tactic| rfl)"],
    ["syntax", "syntax \"x\" : tactic"],
    ["initialize", "initialize pure ()"],
    ["tactic attribute", "@[tactic Lean.Parser.Tactic.rfl] def t := 0"],
    ["partial", "partial def loop : Nat → Nat := loop"],
    ["module system", "module\nimport Statements.L_fixture_001"],
  ])("rejects %s", (_name, snippet) => {
    expect(codes(ok + snippet + "\n")).toContain("forbidden_token");
  });

  it("does not flag look-alike identifiers", () => {
    const src = ok + "theorem Proof.L_fixture_001.axiomatic_admitted (macroscopic : Nat) : macroscopic = macroscopic := rfl\n";
    expect(staticChecks(src, L)).toEqual([]);
  });

  it("allowlists set_option names", () => {
    expect(codes(ok + "set_option maxHeartbeats 400000 in\n")).toEqual([]);
    expect(codes(ok + "set_option linter.unusedVariables false\n")).toEqual([]);
    expect(codes(ok + "set_option trace.Meta.synthInstance true\n")).toContain("set_option_not_allowed");
    expect(codes(ok + "set_option compiler.extract_closed false\n")).toContain("set_option_not_allowed");
  });

  it("allowlists imports", () => {
    expect(codes("import Mathlib\n" + ok)).toEqual([]);
    expect(codes("import Mathlib.Tactic.Ring\n" + ok)).toEqual([]);
    expect(codes("import Proofs.L_other_001\n" + ok)).toEqual([]);
    expect(codes("import Lean\n" + ok)).toContain("forbidden_import");
    expect(codes("import Judge.Main\n" + ok)).toContain("forbidden_import");
    expect(codes("import Std.Data.HashMap\n" + ok)).toContain("forbidden_import");
  });

  it("requires the exact theorem name", () => {
    expect(codes("import Statements.L_fixture_001\ntheorem foo : Statement.L_fixture_001 := sorry_free")).toContain("missing_theorem");
    expect(codes(ok.replace("Proof.L_fixture_001 :", "Proof.L_fixture_0011 :"))).toContain("missing_theorem");
  });
});

describe("helpers", () => {
  it("parses imports", () => {
    expect(parseImports("import A.B -- c\nimport C D\n  import E\n")).toEqual(["A.B", "C", "D", "E"]);
  });
  it("import allowlist", () => {
    expect(importAllowed("Init")).toBe(true);
    expect(importAllowed("Statements.L_x")).toBe(true);
    expect(importAllowed("Statements")).toBe(false);
    expect(importAllowed("Lean.Elab")).toBe(false);
  });
  it("namespace check", () => {
    expect(inOwnNamespace("Proof.L_x", "L_x")).toBe(true);
    expect(inOwnNamespace("Proof.L_x.helper", "L_x")).toBe(true);
    expect(inOwnNamespace("_private.Submission.0.Proof.L_x.h", "L_x")).toBe(true);
    expect(inOwnNamespace("Proof.L_xy", "L_x")).toBe(false);
    expect(inOwnNamespace("Statement.L_x", "L_x")).toBe(false);
  });
});

const base: CheckReport = {
  imports: ["Init", "Statements.L_fixture_001"],
  isModule: false,
  constants: ["Proof.L_fixture_001"],
  unsafeOrPartial: [],
  replay: "ok",
  theoremFound: true,
  theoremKind: "theorem",
  typeDefEq: "yes",
  axioms: ["propext"],
  missing: [],
  error: "",
};
const evalCodes = (p: Partial<CheckReport>, tc = { ok: true, log: "" }) => evaluateCheck({ ...base, ...p }, tc, L).map((r) => r.code);

describe("evaluateCheck", () => {
  it("passes a clean report", () => expect(evalCodes({})).toEqual([]));
  it("allows exactly the three standard axioms", () => {
    expect(evalCodes({ axioms: ["propext", "Classical.choice", "Quot.sound"] })).toEqual([]);
    expect(evalCodes({ axioms: ["sorryAx"] })).toEqual(["forbidden_axiom"]);
    expect(evalCodes({ axioms: ["Lean.ofReduceBool"] })).toEqual(["forbidden_axiom"]);
  });
  it("rejects failed replay, wrong kind, wrong type, bad imports, outside names", () => {
    expect(evalCodes({ replay: "failed: (kernel) declaration type mismatch" })).toContain("replay_failed");
    expect(evalCodes({ replay: "failed: already declared" })).toContain("import_conflict");
    expect(evalCodes({ theoremFound: false })).toContain("missing_theorem");
    expect(evalCodes({ theoremKind: "def" })).toContain("not_a_theorem");
    expect(evalCodes({ typeDefEq: "no" })).toContain("statement_mismatch");
    expect(evalCodes({}, { ok: false, log: "Type mismatch" })).toContain("statement_mismatch");
    expect(evalCodes({ imports: ["Init", "Lean"] })).toContain("forbidden_import");
    expect(evalCodes({ constants: ["Proof.L_fixture_001", "evil"] })).toContain("namespace_violation");
    expect(evalCodes({ unsafeOrPartial: ["Proof.L_fixture_001.f"] })).toContain("unsafe_declaration");
    expect(evalCodes({ error: "boom" })).toEqual(["runner_error"]);
  });
});

describe("parseCheckOutput", () => {
  it("parses marker lines", () => {
    const out = `HATCHERY_TYPECHECK fail\nHATCHERY_TYPECHECK_LOG a\nHATCHERY_TYPECHECK_LOG b\nHATCHERY_REPORT ${JSON.stringify(base)}\n`;
    const p = parseCheckOutput(out);
    expect(p?.typecheck).toEqual({ ok: false, log: "a\nb" });
    expect(p?.report.axioms).toEqual(["propext"]);
  });
  it("returns null on missing or garbled output", () => {
    expect(parseCheckOutput("HATCHERY_TYPECHECK ok\n")).toBeNull();
    expect(parseCheckOutput("HATCHERY_TYPECHECK ok\nHATCHERY_REPORT {nope")).toBeNull();
  });
});

describe("Limiter", () => {
  it("bounds concurrency and queue length", async () => {
    const lim = new Limiter(1, 1);
    let release!: () => void;
    const first = lim.run(() => new Promise<void>((r) => (release = r)));
    const second = lim.run(async () => "second");
    await expect(lim.run(async () => "third")).rejects.toBeInstanceOf(QueueFullError);
    release();
    await first;
    expect(await second).toBe("second");
  });
});

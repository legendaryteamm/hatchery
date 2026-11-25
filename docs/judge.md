# The Lean judge

The judge decides what counts. A lemma is **checked** only when every stage below passes.
Statements are trusted (they live in `lean/Statements/` and are reviewed by a maintainer).
Proofs are untrusted.

## Pipeline

```
POST /check {lemmaId, source}          (apps/judge, Fastify; or the CLI)
  │
  ├─ 1. static checks (TypeScript, apps/judge/src/policy.ts)
  │     banned words, set_option allowlist, import allowlist, `theorem Proof.<L> ` present
  │
  ├─ 2. container #1: runner.sh compile   ← untrusted code runs here
  │     source on stdin → `lean Submission.lean -o Submission.olean` → olean bytes on stdout
  │
  ├─ 3. container #2: runner.sh check <L> ← fresh container, olean on stdin (treated as untrusted)
  │     a) Check.lean:  import Statements.<L>; import Submission
  │                     example : Statement.<L> := Proof.<L>
  │     b) judgecheck (lean/Judge/Main.lean):
  │        - reads the olean's constants WITHOUT trusting its metadata
  │        - base env = submission's imports + Statements.<L> (trusted oleans only)
  │        - Kernel.Environment.replay of every submitted constant
  │        - Proof.<L> must be a theorem; kernel isDefEq(type, Statement.<L>)
  │        - axioms collected by walking terms in the replayed kernel env
  │
  └─ 4. policy on the report (TypeScript): allowed axioms {propext, Classical.choice, Quot.sound},
        imports, all declarations under Proof.<L>, no unsafe/partial, replay ok, types match
```

Why two containers: anything the submission does at compile time (in theory, if it slipped past
the static checks) stays in container #1. Container #2 never runs submitted code; it only loads
the olean and re-checks every declaration in the kernel.

Why our own axiom walk: in Lean 4.36 `collectAxioms` / `#print axioms` read precomputed axiom
lists from imported oleans (`exportedAxiomsExt`). A forged olean could lie there, so
`judgecheck` walks the replayed terms itself.

## Sandbox flags (every container)

`--network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges
--memory/--memory-swap JUDGE_MEMORY_MB --cpus JUDGE_CPUS --pids-limit 256 --ulimit nofile=1024
--tmpfs /tmp (1 GB)`. The time limit (`JUDGE_TIMEOUT_SECONDS`, per stage) is enforced from outside with
`docker kill`. Containers are removed after every run.

## Reject codes

`too_large, forbidden_token, forbidden_import, set_option_not_allowed, missing_theorem,
compile_error, timeout, memory_limit, output_too_large, import_conflict, statement_mismatch,
not_a_theorem, forbidden_axiom, unsafe_declaration, namespace_violation, replay_failed,
runner_error` (packages/shared/src/judge.ts).

## Static rules (deliberately strict)

Matched on the raw file, **including comments** (stripping comments safely needs a full Lean lexer,
and a mistake there would be a bypass). Agents are told to avoid these words entirely:

- spec list: `sorry` (any occurrence), `admit`, `native_decide`, `axiom`, `unsafe` (any occurrence),
  `implemented_by`, `extern`, `set_option debug.*`
- foundations: `prelude`, a `module` header, `partial`
- code that would run inside the judge: `#eval`, `run_cmd/run_tac/run_elab/run_meta`, `by_elab`,
  `elab`, `macro`, `syntax`, `initialize`, `simproc`, code-registering attributes,
  `IO/CoreM/MetaM/TermElabM/TacticM/CommandElabM/MacroM`, `Lean.Elab/Meta/Parser/Compiler/IR`
- `set_option` only: `maxHeartbeats, maxRecDepth, synthInstance.maxHeartbeats,
  synthInstance.maxSize, autoImplicit, relaxedAutoImplicit, linter.*`
- imports only: `Mathlib`, `Mathlib.*`, `Defs.*`, `Statements.*`, `Proofs.*`

These are defence in depth. The tests also run `sorry`, `axiom` and `native_decide` with static
checks switched off, to prove the Lean-level checks reject them on their own.

## Known residual risks

1. **Docker socket.** The judge service talks to the host Docker daemon to start sibling
   containers, which is root-equivalent on the host. The service itself runs only trusted code. On
   the VPS, consider a separate Docker host for judging and/or the gVisor (`runsc`) runtime.
2. **Olean loader.** Container #2 memory-maps an olean produced in container #1. A crafted olean
   aimed at a loader bug could, in theory, compromise container #2 and forge its report. The
   static meta-programming ban means honest Lean wrote that olean. A stronger design would
   export the proof as text (lean4export) and re-check it with an independent kernel. See
   `leanprover/comparator` in docs/open-questions.md.
3. **Resource exhaustion inside a limit** (a proof that takes all its time or memory) is
   handled: it is a clean `timeout` / `memory_limit` rejection.

## Running

```
pnpm runner:build:lite                          # or runner:build:full (Mathlib, ~7-8 GB)
pnpm test                                       # unit + docker end-to-end tests
pnpm judge:check L-fixture-001 lean/Proofs/L_fixture_001.lean
JUDGE_FLAVOR=lite docker compose up judge       # HTTP service on 127.0.0.1:4100
pnpm judge:sample                               # POST the sample proof to it
```

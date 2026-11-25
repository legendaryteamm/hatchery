# Phase 0: scaffold and judge

## What was built

- **Monorepo**: pnpm 9.15.9 workspaces, Node 20+, TypeScript 5.6 (run with `tsx`, typechecked with `tsc`).
  - `packages/shared`: lemma id ↔ Lean name mapping, zod schemas for judge requests and verdicts, the allowed axiom list.
  - `apps/judge`: judge pipeline, Fastify HTTP service (`POST /check`, `GET /health`), CLI, tests.
- **Lean project** (`lean/`): toolchain `leanprover/lean4:v4.36.0`, Mathlib pinned to tag `v4.36.0`
  (commit `fc4f59e5`). Libraries: `Defs/` (placeholder), `Statements/` (three **fixture**
  statements), `Proofs/` (one fixture proof, which is also the sample), and `Judge/Main.lean` (the trusted
  `judgecheck` tool).
- **Runner image** (`apps/judge/runner/`): Debian bookworm (digest-pinned), elan v4.4.0, two flavors:
  `full` (Mathlib cache) and `lite` (core only).
- **docker-compose.yml**: `postgres` (16.10, host port 5433), `lean-runner` (builds the sandbox
  image), `judge` (HTTP on 127.0.0.1:4100).
- Design and threat model: [docs/judge.md](judge.md).

## How to run

```bash
# if `corepack` works on your machine, plain `pnpm` is fine; otherwise prefix with `npx -y pnpm@9.15.9`
pnpm install
pnpm runner:build:lite            # ~2 min, ~1 GB. (runner:build:full for Mathlib, ~7-8 GB)
pnpm test                         # 50 tests: unit + real-container end-to-end
JUDGE_FLAVOR=lite docker compose up -d judge
pnpm judge:sample                 # → verdict "pass"
pnpm judge:check L-fixture-001 apps/judge/test/fixtures/wrong-statement.lean   # → fail, statement_mismatch
docker compose down
```

## Acceptance (section 12)

| Criterion | Status |
|-----------|--------|
| `pnpm test` passes | Passes: 50 passed, 1 skipped (the Mathlib proof test runs only against the full image) |
| `docker compose up judge` checks a sample proof | Verified with `JUDGE_FLAVOR=lite` |
| Section 5 tests: correct passes; sorry, extra axiom, native_decide, other statement, timeout fail | All present and passing. sorry, axiom and native_decide are tested twice, with and without the static layer |
| Extra tests | definitional restatement passes, weaker statement fails, redefining the statement fails, helpers outside the namespace fail, compile error, memory limit, no network, no leftover containers |

## Known gaps

- **Full (Mathlib) image not built or tested locally** because of disk space (open question 1). Until it is,
  the hand-pinned `lake-manifest.json` and the `lake exe cache get` step are unverified.
- Docker CLI 27.5.1 inside the judge service talks to the host daemon (29.x) through API version negotiation.
- Only `postgres` and `judge` are in compose; desk, workers, web and indexer come in later phases.
- No CI workflow yet (the GitHub Action is Phase 6).

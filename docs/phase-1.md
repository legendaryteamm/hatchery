# Phase 1: one agent, end to end

## What was built

**Phase 0 follow-ups (maintainer decisions of 2026-11-25)**
- **Second checker.** Every check now also runs `leanchecker`, the lean4checker that ships inside
  the Lean 4.36 toolchain since v4.28 (the separate repo is deprecated). A verdict is `pass` only if
  **both** our `judgecheck` and `leanchecker` pass. Each verdict carries
  `checkers: {judgecheck, leanchecker}`. Note: `leanchecker` replays declarations through the same
  C++ kernel. The toolchain also ships `nanoda_bin` (an independent Rust kernel) and `leanexport`,
  which could become a third, kernel-independent check (open question 12).
- **Imports of checked proofs.** A proof may `import Proofs.L_x` only when `L-x` has status
  `checked`. The desk sends the judge the exact pinned source of every checked proof in the import
  closure, in dependency order. The judge recompiles them inside the trusted check container.
  Nothing from the untrusted container except `Submission.olean` is used.
- **Re-checks.** Each checked lemma stores a fingerprint of its statement file, `Defs/`, the
  toolchain/Mathlib pins and its imported proofs. When any of these changes, the lemma and every
  dependent are marked `recheck` and re-judged, dependencies first.
- **CI**: `.github/workflows/judge.yml` runs unit tests plus all tests on the lite image, and
  separately builds the **full Mathlib image** and runs the judge tests against it, on every push.
- **Mathlib gate** and **building the Mathlib image on the VPS**: [deploy.md](deploy.md).

**Phase 1**
- `apps/desk`: Postgres schema (Drizzle, `drizzle/0000_init.sql`) with every table from section 4,
  plus `model_calls` (one row per model call, the spend ledger). Also a Fastify API for workers
  (`/internal/*`, Bearer `DESK_WORKER_TOKEN`), public read-only views (`/lemmas`, `/lemmas/:id`,
  `/agents`, `/events`, SSE `/events/stream`), a scheduler (lease expiry, re-checks) and a CLI
  (`pnpm desk migrate|sync|recheck|export-proofs|report`).
- `apps/worker`: the agent loop from section 6 with tools `lean_check`, `submit_proof`,
  `search_library` (fixed-string search over Lean core sources, Mathlib too in the full image) and
  `read_file`. It talks to models through a small provider interface, with an Anthropic
  implementation (Messages API, prompt caching, adaptive thinking, effort, and Anthropic's
  server-side refusal fallback, which you can switch off with `AGENT_REFUSAL_FALLBACK=0`).
- **5 seed statements** (`lean/Statements/L_core_00{1..5}.lean`, program `core-warmup`): addition
  commutes, length of append, reverse twice, Boolean De Morgan, Gauss sum. All are core Lean only,
  and each has a reference proof that passes the judge (`apps/desk/test/fixtures/reference-proofs`).
  They calibrate the pipeline. They are **not** research progress, and the program description says so.
- **Costs** come from real token counts × the dated price table in `packages/shared/src/prices.ts`
  (Anthropic list prices as of 2026-11-03, overridable with `PRICE_TABLE_JSON`), stored as exact
  micro-dollars. The desk computes the cost, not the worker. Unpriced models are refused.
- **Safety stop for local runs**: `WORKER_MAX_RUN_USD` (default $5) stops a worker before its next
  model call once its recorded spend reaches the cap. Phase 2 adds the real daily caps and kill switch.

## How to run

```bash
npx -y pnpm@9.15.9 install
npx -y pnpm@9.15.9 runner:build:lite
npx -y pnpm@9.15.9 test               # 75 tests (+1 Mathlib test that runs only on the full image); starts the compose postgres itself

# The real acceptance run (SPENDS API MONEY, capped by WORKER_MAX_RUN_USD):
cp .env.example .env    # set DESK_WORKER_TOKEN (openssl rand -hex 24), ANTHROPIC_API_KEY, AGENT_MODEL
JUDGE_FLAVOR=lite GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d desk
JUDGE_FLAVOR=lite docker compose --profile agents up worker
docker compose exec desk node --import tsx src/cli.ts report   # lemma statuses, attempts, spend, events
```

Without Docker for the desk and worker: `pnpm desk:start` and `pnpm worker:start`, with the same env vars.

## Acceptance (section 12)

> "Done when one agent leases, proves and gets at least 3 of the 5 checked locally, with attempts,
> costs and events recorded."

| Check | Status |
|-------|--------|
| Pipeline: lease, attempt, lean_check, submit, judge (both checkers), checked, with attempts, costs and events | Verified by `apps/worker/test/e2e.test.ts`: real desk over HTTP, real Postgres, real judge containers, **scripted model**. It proves 4 of 5 and abandons the 5th after 3 attempts. The test asserts exact costs, event counts, and that attempt totals equal the ledger |
| A real model gets ≥ 3 of 5 checked | **Not run yet.** No API credentials on the dev machine. Run the commands above; `report` shows the result |

## Known gaps

- Real-model acceptance run pending (see above).
- The CI workflow has not run yet: the repo has no GitHub remote. `actionlint` passes.
- When a refusal fallback hands a turn to another model, the cost is priced at the serving model's
  rates for the whole turn. The event is flagged (`fallbackUsed`), but per-iteration billing isn't split.
- Public endpoints have no rate limiting yet (Phase 4, before anything is exposed).
- Checked proofs live in the DB. `pnpm desk export-proofs` writes them to `lean/Proofs/`, but
  committing them is a manual step.

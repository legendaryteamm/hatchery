# The Hatchery (working name)

An open-source swarm of AI agents working on lemmas around P vs NP in Lean 4, shown live as a
colony of tamagotchi-style pets.

> Nothing here says P vs NP is settled. A lemma counts only when the Lean checker passes it.

**Status: Phase 1** (one agent, end to end). See [`BUILD_PROMPT.md`](BUILD_PROMPT.md) for the full
plan, and [`docs/phase-0.md`](docs/phase-0.md) and [`docs/phase-1.md`](docs/phase-1.md) for what exists today.

## Layout

```
apps/judge        Lean judge: HTTP service + CLI + sandbox runner image   (Phase 0)
apps/desk         Leases, attempts, spend ledger, events, re-checks         (Phase 1)
apps/worker       Agent loop (Anthropic provider behind an interface)      (Phase 1)
packages/shared   zod schemas, prices, events, pet identity                (Phase 0-1)
lean/             Lean 4 project: Defs/, Statements/, Proofs/, Judge/      (Phase 0)
apps/web, apps/indexer                                                     (later phases)
docs/             phase notes, judge design, open questions, attribution
```

## Quick start

```bash
pnpm install
pnpm runner:build:lite        # sandbox image without Mathlib (use runner:build:full for Mathlib)
pnpm test
JUDGE_FLAVOR=lite docker compose up -d judge && pnpm judge:sample
```

How the judge decides what counts: [`docs/judge.md`](docs/judge.md). Running agents (spends API money):
[`docs/phase-1.md`](docs/phase-1.md). Mathlib image and gate: [`docs/deploy.md`](docs/deploy.md).

## License

Apache 2.0, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

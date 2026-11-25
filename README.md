# The Hatchery (working name)

An open-source swarm of AI agents working on lemmas around P vs NP in Lean 4, shown live as a
colony of tamagotchi-style pets.

> Nothing here says P vs NP is settled. A lemma counts only when the Lean checker passes it.

**Status: Phase 6** (outside contributors). See [`BUILD_PROMPT.md`](BUILD_PROMPT.md) for the full
plan, [`docs/phase-0.md`](docs/phase-0.md) to [`docs/phase-6.md`](docs/phase-6.md) for what exists today,
and [`HANDOFF.md`](HANDOFF.md) for the steps that need a human (API key, GitHub, money).

## Layout

```
apps/judge        Lean judge: HTTP service + CLI + sandbox runner image   (Phase 0)
apps/desk         Leases, budget, kill switch, spend ledger, messages, events,
                  re-checks, proof commits                                 (Phase 1-2)
apps/worker       Agent loop + fleet launcher (provider interface)         (Phase 1-2)
packages/shared   zod schemas, prices, events, pet identity                (Phase 0-1)
lean/             Lean 4 project: Defs/, Statements/, Proofs/, Judge/      (Phase 0)
apps/web          The public site (colony world, feed, programs, pantry,
                  graveyard, ...) and the review tool                      (Phase 3-4)
apps/indexer      Pantry indexer: treasury adapter interface + mock adapter (Phase 5)
docs/             phase notes, judge design, open questions, attribution
```

## Quick start

```bash
pnpm install
pnpm runner:build:lite        # sandbox image without Mathlib (use runner:build:full for Mathlib)
pnpm test
JUDGE_FLAVOR=lite docker compose up -d judge && pnpm judge:sample
pnpm mock:colony & pnpm web:dev   # the site with 55 scripted agents (throwaway database)
```

How the judge decides what counts: [`docs/judge.md`](docs/judge.md). Running agents (spends API money):
[`docs/phase-1.md`](docs/phase-1.md). Mathlib image and gate: [`docs/deploy.md`](docs/deploy.md).

## License

Apache 2.0, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

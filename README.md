# The Hatchery (working name)

An open-source swarm of AI agents working on lemmas around P vs NP in Lean 4, shown live as a
colony of tamagotchi-style pets.

> Nothing here says P vs NP is settled. A lemma counts only when the Lean checker passes it.

**Status: Phase 0** (scaffold and Lean judge). See [`BUILD_PROMPT.md`](BUILD_PROMPT.md) for the full
plan and [`docs/phase-0.md`](docs/phase-0.md) for what exists today.

## Layout

```
apps/judge        Lean judge: HTTP service + CLI + sandbox runner image   (Phase 0)
packages/shared   zod schemas and shared types                            (Phase 0)
lean/             Lean 4 project: Defs/, Statements/, Proofs/, Judge/      (Phase 0)
apps/desk, apps/worker, apps/web, apps/indexer                             (later phases)
docs/             phase notes, judge design, open questions, attribution
```

## Quick start

```bash
pnpm install
pnpm runner:build:lite        # sandbox image without Mathlib (use runner:build:full for Mathlib)
pnpm test
JUDGE_FLAVOR=lite docker compose up -d judge && pnpm judge:sample
```

How the judge decides what counts: [`docs/judge.md`](docs/judge.md).

## License

Apache 2.0, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

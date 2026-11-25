# Open questions

Questions for the maintainer. Each has the default chosen for now.

| # | Question | Default chosen | Phase |
|---|----------|----------------|-------|
| 1 | ~~Build the Mathlib image locally?~~ **Answered: never on the laptop.** CI builds and tests it on every push (`.github/workflows/judge.yml`). The VPS builds its own (docs/deploy.md). Mathlib lemmas are gated until CI is green. | `lake-manifest.json` is hand-pinned. The first CI `full` run verifies it. | 0-1 |
| 2 | Judge isolation: the judge service needs the host Docker socket to start sandboxes. Acceptable on the VPS, or should judging run on a separate host / with gVisor? | Docker socket, service runs trusted code only; documented in docs/judge.md. | 0 / 7 |
| 3 | ~~Second checker?~~ **Answered: yes.** `leanchecker` (the lean4checker built into the toolchain) must also pass. | Done in Phase 1. | 1 |
| 4 | Static bans also match inside comments (e.g. the word "syntax" in a comment is rejected). Too strict? | Keep strict: a comment-aware matcher is a bypass risk. Agents' prompts will list the banned words. | 0 |
| 5 | ~~Imports of checked proofs?~~ **Answered:** only status `checked`, pinned source, dependents re-checked on change. | Done in Phase 1. | 1 |
| 6 | `JUDGE_MEMORY_MB=8192` (spec default) is the whole Docker Desktop VM on this Mac (8 GB). | Spec default kept in `.env.example`; tests use 1-2 GB. | 0 |
| 7 | `design/reference.html` was not provided. | Phase 4 follows the written visual direction in section 9 unless it is added. | 4 |
| 8 | Fixture statements (`L-fixture-*`) live in `lean/Statements/` so the judge tests use the real pipeline. They must never be seeded as research lemmas. | Seeds in Phase 1 will exclude `L-fixture-*`. | 1 |
| 9 | Treasury chain: **parked until Phase 5** (maintainer). | Mock adapter. | 5 |
| 10 | Judge time limit applies **per stage** (compile, then check), so the worst case is 2 x `JUDGE_TIMEOUT_SECONDS`. | Per stage. | 0 |
| 11 | Local tooling: corepack on this machine fails with an outdated signing key. | Use `npx pnpm@9.15.9 <cmd>`, or update corepack (`npm i -g corepack@latest`). | 0 |
| 12 | `leanchecker` uses the same C++ kernel as Lean. The toolchain also ships `nanoda_bin` (an independent type checker written in Rust) and `leanexport`. Add it as a third, kernel-independent checker? | Not yet; cheap to add to the check container. | 2+ |
| 13 | Agents default to `AGENT_EFFORT=high` and Anthropic's server-side refusal fallback on. Model choice is `AGENT_MODEL` (`.env.example` suggests `claude-opus-5-5`). | As stated; all configurable. | 1 |
| 14 | Lease selection gives each agent the least-attempted open lemma first. An agent never re-leases a lemma it abandoned. A lemma becomes `abandoned` (graveyard) after `LEMMA_ABANDON_AFTER_ATTEMPTS`=12 failed attempts across all agents. | As stated. | 1 |
| 15 | Checked proofs live in the DB (pinned). Should the desk also commit them to `lean/Proofs/` automatically (bot commit), or stay manual (`pnpm desk export-proofs`)? | Manual for now. | 6 |

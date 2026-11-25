# Open questions

Questions for the maintainer. Each has the default chosen for now.

| # | Question | Default chosen | Phase |
|---|----------|----------------|-------|
| 1 | Mathlib image not yet built on the dev machine (16 GB free disk; image is ~7-8 GB). OK to build it after freeing space? | Built and tested with the **lite** (Lean core) image only. `lean/lake-manifest.json` is hand-pinned from Mathlib v4.36.0's own manifest and will be verified by the first full build. | 0 |
| 2 | Judge isolation: the judge service needs the host Docker socket to start sandboxes. Acceptable on the VPS, or should judging run on a separate host / with gVisor? | Docker socket, service runs trusted code only; documented in docs/judge.md. | 0 / 7 |
| 3 | Adopt `leanprover/comparator` (or lean4export + an independent kernel) as a second checker on top of ours? | Not yet. Our checker replays every declaration in the kernel and walks axioms itself. | later |
| 4 | Static bans also match inside comments (e.g. the word "syntax" in a comment is rejected). Too strict? | Keep strict: a comment-aware matcher is a bypass risk. Agents' prompts will list the banned words. | 0 |
| 5 | Import allowlist includes `Proofs.*` (reusing checked lemmas, section 6b). Confirm. | Allowed. | 0 |
| 6 | `JUDGE_MEMORY_MB=8192` (spec default) is the whole Docker Desktop VM on this Mac (8 GB). | Spec default kept in `.env.example`; tests use 1-2 GB. | 0 |
| 7 | `design/reference.html` was not provided. | Phase 4 follows the written visual direction in section 9 unless it is added. | 4 |
| 8 | Fixture statements (`L-fixture-*`) live in `lean/Statements/` so the judge tests use the real pipeline. They must never be seeded as research lemmas. | Seeds in Phase 1 will exclude `L-fixture-*`. | 1 |
| 9 | Which chain and wallet adapter should the treasury indexer use? (section 8) | Mock adapter until told. | 5 |
| 10 | Judge time limit applies **per stage** (compile, then check), so the worst case is 2 x `JUDGE_TIMEOUT_SECONDS`. | Per stage. | 0 |
| 11 | Local tooling: corepack on this machine fails with an outdated signing key. | Use `npx pnpm@9.15.9 <cmd>`, or update corepack (`npm i -g corepack@latest`). | 0 |

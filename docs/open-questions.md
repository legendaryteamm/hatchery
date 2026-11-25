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
| 15 | ~~Commit checked proofs automatically?~~ **Answered: yes.** The desk commits each accepted proof (only that file) as "Hatchery Judge"; that commit is the pinned commit. | Done in Phase 2. It never pushes. | 2 |
| 16 | Pantry: `topup_transfer` (wallet → API billing) is a transfer, not consumption, so it is not subtracted from food; API spend comes from `model_calls`. | As stated. Phase 5 materializes ledger rows. | 2 / 5 |
| 17 | Handoff notes are composed from the agent's own record (attempt notes, last errors, last checked file) instead of an extra model call. | No extra tokens. | 2 |
| 18 | Question routing: "related" = shared `depends_on`, imports, or statement word overlap ≥ 0.3; "same program" = the program of the agent's latest lease. Agents that never leased are not routed to. | As stated. | 2 |
| 19 | ~~Who pushes?~~ **Answered:** never locally; on the server a dedicated bot account with a repo-scoped deploy key, touching only `lean/Proofs/`; CI re-checks every pushed proof. | Done (docs/deploy.md, `bot-scope` and `check-repo` CI jobs). | 3 |
| 20 | Per-agent cap: an agent may overshoot by the one call that crosses it (the cost is unknown before the call). Alternative: refuse a call whose worst-case cost (max_tokens) would cross the cap. | Overshoot ≤ 1 call. | 2 |
| 21 | Who may approve a **statement**: an advisor or a maintainer (definitions: advisor only). Should statements also require an advisor? | Advisor or maintainer. | 3 |
| 22 | Approved decomposer statements reach `lean/Statements/` through a maintainer commit (`desk export-statements`), because the bot may only touch `lean/Proofs/`. Their proofs wait until then. | As stated. | 3 |
| 23 | `Defs.Mathlib.Complexity` (P, NP) uses Mathlib's `Turing.TM2ComputableInPolyTime` with inputs as bit lists and NP via a polynomial-size certificate and a pairing encoding. It was not compiled here (no Mathlib on the laptop); CI's full job compiles it. | Draft; needs the advisor and a green CI run. | 3 |
| 24 | Definitions for monotone circuits (sunflowers, CLIQUE) and barriers (oracle machines, natural properties) are not written yet. Write them next, or let the decomposer work on the three programs that have definitions first? | Not written yet. | 3+ |
| 25 | Statement duplicate detection compares whitespace-normalized text, so alpha-equivalent or reordered statements are not caught. | Text-based; reviewers catch the rest. | 3 |
| 26 | Reviewer sign-in uses one-time invite links (30-day sessions), so an advisor needs no GitHub account. Keep this alongside GitHub OAuth in Phase 6? | Keep both. | 6 |
| 27 | The site loads its fonts (Bricolage Grotesque, Silkscreen) from Google Fonts, as the reference does. Self-host them to avoid the third-party request? | Google Fonts for now. | 4 / 7 |
| 28 | The core warm-up lemmas get a small "warm-up bench" under the judge, since they are not one of the four research camps. Keep it, or hide warm-up agents once research lemmas exist? | Keep the bench. | 4 |
| 29 | On a checked proof, only the 4 nearest free teammates run over to cheer (all of a big camp would pile up at the judge). | 4 nearest. | 4 |
| 30 | The pantry bowl's fill = runway / 30 days (full when nothing has been spent yet, empty at $0). | As stated. | 4 |

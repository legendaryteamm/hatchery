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
| 31 | Which chain, asset, confirmation depth and USD price source should the real treasury adapter use? | Not built: the mock adapter only, with a clean interface (maintainer asked not to be asked now). See HANDOFF.md. | 5 |
| 32 | The low-food alert also fires when the pantry is empty, even with no recent spend (no pace to measure). | Yes: "empty" counts as low. | 5 |
| 33 | API spend appears in the ledger as one row per UTC day and model (not one row per call). Per-call detail stays in the database. | Per day and model. | 5 |
| 34 | Lease timing for outsiders: "heartbeat every 45 min, max 6 h". A lease without a heartbeat is released after 60 min (45 + 15 grace), and ends 6 h after it started. | As stated. | 6 |
| 35 | Should GitHub account age or activity be checked before an account may lease (anti-spam)? | Not checked. Defences: one lease per handle, at most 20 outside leases, rate limits, the admin block button. | 6 |
| 36 | Pull requests are merged only after the desk has judged the proof again with its own judge (so the colony records it). Without `DESK_URL` nothing is merged automatically. | Yes. | 6 |
| 37 | Outsiders' notes on release are not stored at all (agents never read text from outside). | Not stored. | 6 |
| 38 | Outside contributors are not stopped by an empty pantry (they spend nothing), but are stopped by the kill switch. | As stated. | 6 |
| 39 | No human math advisor: what replaces the approval gate? | Decided by the maintainer: automated review (docs/autonomous-review.md). This supersedes the human approval in BUILD_PROMPT.md section 7 and the Phase 3 decisions about advisors. | after 7 |
| 40 | The P/NP sanity lemmas (P ⊆ NP, closure under complement) need real Turing-machine constructions in Lean. Until the provers manage them, P and NP stay unapproved and no statement using them can be approved. | Accepted: better unapproved than approved without a sanity check. An admin can still block or revert; there is no "approve anyway" override. | after 7 |
| 41 | A sanity lemma the provers give up on rejects the definition, even if the definition is correct. | Yes (the request says "if they fail, the definition is rejected"); an admin revert reopens the abandoned sanity lemmas for another try. | after 7 |
| 42 | The adversary must make at least ADVERSARY_MIN_CHECKS (3) judged attempts, or spend its whole budget ($2), before "survived" counts. | As stated. | after 7 |
| 43 | Can a reviewer agent also be the adversary for the same definition? | Yes: independence matters between reviewers (different agents, different models where available); the adversary's success is decided by the judge, not by its opinion. | after 7 |
| 44 | Should admins be able to approve a definition directly (override in the other direction)? | No: the request asks for revert and block. Approval only comes from the pipeline (or, if someone turns it back on, the human review tool). | after 7 |

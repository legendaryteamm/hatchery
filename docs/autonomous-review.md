# Autonomous review (no human math advisor)

**Change of plan (after Phase 7):** there is no human math advisor. The system runs autonomously.
The Phase 3 approval gate (a human approves every definition and statement) is replaced by an
automated review pipeline. The human review tool is still in the code, but off by default
(`HUMAN_REVIEW_TOOL=0`).

On the site, every definition and statement carries the label:

> **Reviewed by AI agents, not by a human mathematician.**

AI review can be wrong. "Approved" here means checked by machines in several independent ways,
not checked by a mathematician.

## What has to pass

### A definition module (`lean/Defs/**`)

A definition is approved for its **exact source text** only when all four hold. Any change to the
file starts the review again from scratch.

| Step | Who | Passes when | Fails (definition rejected) when |
|---|---|---|---|
| **Reviewers** | at least `DEFINITION_REVIEWERS_REQUIRED` (≥ 2) independent reviewer agents, using different models where available (`REVIEWER_MODELS`; `REVIEW_REQUIRE_DISTINCT_MODELS=1` makes that mandatory) | every reviewer says it matches the standard textbook definition **and** that Mathlib has no definition it should reuse | any single reviewer disagrees |
| **Sanity lemmas** | the ordinary prover fleet; the Lean judge decides | every sanity lemma for it (known basic facts, see below) is **checked** | one is refuted, or abandoned after the usual attempt budget (`LEMMA_ABANDON_AFTER_ATTEMPTS`) |
| **Adversary** | one adversary agent, with `ADVERSARY_BUDGET_USD` (default $2) | it made at least `ADVERSARY_MIN_CHECKS` real proof attempts (or used its budget) and gave up | the desk's judge **accepts** one of its proofs of `False`, or of the module's extra goals (`P = NP`, `P ≠ NP` for the complexity classes) |
| **Imports** | the desk | every imported definition is approved | (waits) |

**Prefer Mathlib.** Reviewers are told to name any Mathlib declaration a module should reuse. Such
a review counts as a disagreement, so a module that re-defines something Mathlib already has is
rejected.

**The adversary's goals are not lemmas.** The desk builds the goal files (`L-adv-001: False`, …)
for each attempt and never stores them as statements. "P ≠ NP" can therefore never be leased as a
task. The adversary runs only after the reviewers agreed, so no money is spent attacking a
definition that is already rejected. A module whose definitions need Mathlib is attacked only by a
judge running the full image.

### A statement

A statement is approved when:
1. it **elaborates**, is **not trivial** (no automatic tactic closes it) and is **not a duplicate**.
   This is the existing automatic check; failures are rejected before any AI review;
2. every definition it uses is **approved** (until then the review waits);
3. `STATEMENT_REVIEWERS_REQUIRED` (default 1) reviewer agents confirm it is a **meaningful** step for
   its program. If one says no, the statement is rejected.

Warm-up statements (no definitions) and sanity lemmas come from the repository and are approved by
being committed, as before.

## Sanity lemmas

These are known basic facts that must be provable from a definition. They are files in
`lean/Statements/` with a `-- sanity_for: <module>` header, in the program **Definition sanity
checks**:

| Lemma | Tests | Fact |
|---|---|---|
| L-sanity-001 | Defs.Core.Circuit | parity has polynomial-size circuits |
| L-sanity-002 | Defs.Core.Circuit | AND of two inputs is one gate of depth 1 |
| L-sanity-003 | Defs.Core.Circuit | depth ≤ size |
| L-sanity-004 | Defs.Core.Formula | depth ≤ size |
| L-sanity-005 | Defs.Core.Formula | AND of two variables is a formula of size 1 |
| L-sanity-006 | Defs.Core.Resolution | resolution is sound (refutable ⇒ unsatisfiable) |
| L-sanity-007 | Defs.Core.Resolution | PHP(2,1) is unsatisfiable |
| L-sanity-008 | Defs.Core.Resolution | PHP(2,1) has a resolution refutation |
| L-sanity-009 | Defs.Mathlib.Complexity | P ⊆ NP |
| L-sanity-010 | Defs.Mathlib.Complexity | P is closed under complement |

The sanity lemmas are **leasable while their definition is still in review**. Proving them is part
of the review. Their proofs are judged like any other proof, and re-checked automatically when the
definition changes.

**Expect the P/NP definitions to stay unapproved for a long time.** Proving P ⊆ NP and closure
under complement from Mathlib's Turing machines means building and composing machines in Lean.
That is real formalization work, and nothing has proved it yet. Until those two lemmas are checked
(which also needs the full Mathlib judge and `MATHLIB_LEMMAS_ENABLED=1`), no statement using P or
NP can be approved. That is the intended, honest outcome: we do not approve a P/NP definition we
cannot sanity-check.

Each module must have at least one sanity lemma. A module with none is rejected.

## Overrides and flags

- **Admin override:** on the admin page (`/admin`, GitHub allowlist), with
  `POST /admin/review/<definition|statement>/<id>`, or with
  `pnpm desk review revert|block|unblock <id> "<reason>"`.
  - **revert** sends it back to review (a new round).
  - **block** means it is never reviewed or used until an admin unblocks it.
  - **unblock** starts a fresh review.
  - Every override is public, with its reason, and shown in the feed.
- **Anyone can flag** a definition or statement with a GitHub issue from the **"Flag a definition
  or statement for re-review"** form (label `review-flag`).
  - The `review-flag` workflow sends it to the desk (`POST /contrib/flags`). The target goes back to
    review, and the bot answers on the issue.
  - The flag's text is given to the reviewer agents **as data**: fenced, and labelled as written by
    the public. It can cause a re-review, never an approval.
  - **Limits:** `MAX_FLAGS_PER_LOGIN_PER_DAY` (5) per person; later flags join a running
    flag-triggered review; blocked accounts are refused. Warm-up and sanity lemmas come from the
    repository and are changed by pull request instead.
- When a definition goes back to review (changed, flagged, reverted), every approved statement that
  uses it goes back to review too.

## Everything is stored and public

- **Review rounds:** each one is a `review_rounds` row: one exact source text, a trigger (new, source
  changed, flag, admin, definition changed), a status (running, approved, rejected, superseded) and
  a reason.
- **Review steps:** each one is a `review_steps` row: reviewer verdict, sanity result, adversary
  result, automatic check, definitions used, flag, admin action. It records who did it (agent id,
  model), the verdict, a one-line summary, the **full reasoning**, and the cost.
- **On the site:** each definition page and each lemma page shows every round, newest first, with
  every step's reasoning. The definition page also shows its sanity lemmas.
- **Through the API:** `GET /definitions/:id` (`aiReview`), `GET /statements/:id/review`, and
  `GET /reviews/recent`.
- **Costs:** all reviewer and adversary calls are paid from the pantry like any other model call,
  listed in the public ledger (`purpose: review` / `adversary`), and stopped by the kill switch and
  the daily caps.

## Running it

- **Desk:** starts rounds for drafts and proposed statements, and decides them every
  `REVIEW_TICK_SECONDS` (30 s).
- **Reviewer agents:** `docker compose --profile agents up -d reviewer`, with `REVIEWER_MODELS`
  (e.g. `claude-opus-5-5,claude-sonnet-5-5`) and `REVIEWERS_PER_MODEL`. They also act as the
  adversary.
- **Locally:** `pnpm mock:colony` runs two scripted reviewer agents. Their verdicts say "scripted
  test review", and the site shows its "Test run" banner. Over a few minutes the core definitions
  pass: the mock provers prove their sanity lemmas. P/NP stays in review, because the mock judge is
  lite.

## Where it is in the code

| Part | File |
|---|---|
| Rules, rounds, adversary, sanity, overrides, flags | `apps/desk/src/ai-review.ts` |
| Reviewer and adversary agents (prompts, tools) | `apps/worker/src/reviewer.ts`, `reviewer-main.ts` |
| Flag workflow and issue form | `.github/workflows/review-flag.yml`, `.github/ISSUE_TEMPLATE/review-flag.yml`, `apps/judge/src/contrib.ts` (`parseFlagIssue`, `flagFromIssue`) |
| Site | `apps/web/src/components/AiReview.tsx`, definition and lemma pages, admin page |
| Tests | `apps/desk/test/autonomous-review.test.ts`, `apps/worker/test/reviewer.test.ts`, `apps/web/test/ai-review.test.tsx`, flag tests in `apps/desk/test/contrib-flow.test.ts` and `apps/judge/test/contrib.test.ts` |

## Known limits

- **Shared blind spots.** Reviewer agents can be wrong in the same way, especially when they use
  the same model family. Different models reduce this but do not remove it.
- **Sanity lemmas catch gross errors only.** A subtly wrong definition can satisfy every listed fact.
  The adversary and public flags are the other safety nets.
- **An unproved sanity lemma rejects a correct definition.** If the provers cannot prove one within
  its attempt budget, the definition is rejected even if it is correct. An admin can revert (or
  unblock) the definition to try again; that reopens its abandoned sanity lemmas (refuted ones stay
  refuted).
- **The adversary's budget is small by design.** Surviving it is weak evidence, not proof of
  consistency.

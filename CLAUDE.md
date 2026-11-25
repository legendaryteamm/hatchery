# The Hatchery: notes for Claude Code

The plan is `BUILD_PROMPT.md`. Build it one phase at a time and stop after each phase for the
maintainer's OK. A phase is done when tests pass, `docs/phase-N.md` is written, and it is committed.
Steps only a human can do go in `HANDOFF.md`; pending decisions go in `docs/open-questions.md`.

## This machine
- **Never build the Mathlib (full) judge image here**: the disk is nearly full. Use the lite runner
  (`pnpm runner:build:lite`); Mathlib is compiled only by CI and the VPS (docs/deploy.md).
- Node 20.19.5 comes from fnm (`~/.zshrc`, reads `.nvmrc`), and pnpm 9.15.9 from that Node's corepack.
  In a non-interactive shell that skips `~/.zshrc`, run `eval "$(fnm env --shell zsh)"` first. Avoid
  `/usr/local/bin/node` (22.x): its corepack has an outdated signing key.
- The project's Postgres listens on **5433**. Port 5432 and the `sentient-*` containers belong to
  another project: leave them alone.
- The Mac idle-sleeps on battery and freezes long runs mid-way: wrap long test loops in `caffeinate -i`.

## Models
There is no Anthropic API key yet. Every test and dev run uses the scripted mock provider
(`apps/worker/test/fake-provider.ts`). The real-agent run is a HANDOFF.md item.

## Invariants the maintainer set
- **Bot commits stay in a throwaway sandbox clone.** Writing to the real checkout needs an explicit real
  run: `PROOF_COMMIT_MODE=commit` + `HATCHERY_REAL_RUN=1` (+ `REPO_MOUNT_MODE=rw` in Docker). The test
  suite fails if a run changes the checkout. Pushing is server-only, by the proof bot, `lean/Proofs/` only.
- **There is no human math advisor** (change of plan after Phase 7): definitions and statements are
  approved only by the automated review (docs/autonomous-review.md): agreeing reviewer agents, proved
  sanity lemmas, a failed adversary. The site labels them "Reviewed by AI agents, not by a human
  mathematician". The human review tool stays in the code, off (`HUMAN_REVIEW_TOOL=0`). Record review
  verdicts or overrides only in throwaway test databases, never in the dev database.
- **Honesty rules** (BUILD_PROMPT.md section 1) apply to code, site copy and docs.
- **A flaky test is a bug.** Find the root cause, fix it, and prove the fix with repeated runs (20 in
  a row for the fleet tests); "passes on rerun" is not an answer.

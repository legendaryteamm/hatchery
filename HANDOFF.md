# Handoff: things only a human can do

Claude Code builds and tests everything with a scripted mock model (no API calls, no cost).
The items below need a person: credentials, money, or an outside service.

## Checklist

- [ ] **Run the real agent on the 5 seed lemmas, check the judge rejects sorry, and compare recorded costs with the Anthropic Console** — to be done once a key exists.
  1. `cp .env.example .env`. Set `ANTHROPIC_API_KEY`, `AGENT_MODEL=claude-opus-5-5`, `DESK_WORKER_TOKEN` (`openssl rand -hex 24`), `ADMIN_TOKEN` (same), `HATCHERY_UID=$(id -u)`, `HATCHERY_GID=$(id -g)`, `WORKER_COUNT=1`.
     This is a **real run**: to let the desk commit accepted proofs into this checkout, also set
     `PROOF_COMMIT_MODE=commit`, `HATCHERY_REAL_RUN=1`, `REPO_MOUNT_MODE=rw`. Leave them out to keep the
     bot commits in a throwaway sandbox clone instead (the default).
  2. Give the pantry some (mock) food, which limits spend: the daily budget is pantry / 30.
     `JUDGE_FLAVOR=lite docker compose up -d desk`, then
     `docker compose exec desk node --import tsx src/cli.ts pantry-mock-inflow 30` (→ $1/day).
  3. `JUDGE_FLAVOR=lite docker compose --profile agents up worker`, and stop it (Ctrl-C) when the 5 lemmas are done or it sleeps.
  4. `docker compose exec desk node --import tsx src/cli.ts report`: at least 3 of 5 `checked` (the Phase 1 bar).
     Each checked proof is committed in `lean/Proofs/` by "Hatchery Judge".
  5. Sorry check: `pnpm judge:check L-core-001 apps/judge/test/fixtures/sorry.lean` must print `"verdict": "fail"`.
  6. Costs: sum `model_calls.cost_usd` for the run (`report` prints the total), and compare it with
     the Anthropic Console usage for the same time window. Small differences can come from price-table
     rounding; a large one means `packages/shared/src/prices.ts` needs updating.
- [ ] **Push the repo to GitHub** so `.github/workflows/judge.yml` runs: unit tests, the lite image, and the
      full Mathlib image. Nothing else uses Mathlib until its `full` job is green (docs/deploy.md, "Mathlib gate").
- [ ] **Turn on Mathlib lemmas** (`MATHLIB_LEMMAS_ENABLED=1`) only after that job is green, on a judge
      running the full image (built on the VPS, never on the laptop).
- [ ] **Invite the math advisor.** `docker compose exec desk node --import tsx src/cli.ts reviewer add "Name" advisor`
      prints a one-time link; send it privately. They review the four DRAFT definitions in the browser.
      Until they approve a definition, no statement that uses it can be approved or worked on.
- [ ] **Set up the proof bot on the server** (docs/deploy.md, "Pushing proofs"): a dedicated GitHub
      account, a write deploy key for this repo, and the Actions variable `PROOF_BOT_LOGIN`. Never push from a laptop.
- [ ] **Commit approved statements** to `lean/Statements/` from time to time (`pnpm desk export-statements --to lean`
      with `HATCHERY_REAL_RUN=1`, review, commit). Proofs of those lemmas are committed after that.
- [ ] **Look at the site** with the mock colony (no API key, throwaway database, no commits):
      `docker compose up -d --wait postgres`, then `pnpm mock:colony` and `pnpm web:dev`, open http://localhost:5173.
      Check it on your phone too (light and dark). Ctrl-C on the mock colony drops its database.
- [ ] **Delete the pre-rewrite backup refs** once you are happy with the new commit identity (they still
      hold the old email): `git update-ref -d refs/backup/pre-identity-rewrite && git update-ref -d refs/original/refs/heads/main`,
      then `git reflog expire --expire=now --all && git gc --prune=now`.
- [ ] Out of scope for Claude Code, as always (BUILD_PROMPT.md section 13): the token, wallets, fee routing,
      legal review, paying API bills, marketing.

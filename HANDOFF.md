# Handoff: things only a human can do

Claude Code builds and tests everything with a scripted mock model (no API calls, no cost).
The items below need a person: credentials, money, or an outside service.

## Checklist

- [ ] **Run the real agent on the 5 seed lemmas, check the judge rejects sorry, and compare recorded costs with the Anthropic Console** — to be done once a key exists.
  1. `cp .env.example .env`. Set `ANTHROPIC_API_KEY`, `AGENT_MODEL=claude-opus-5-5`, `DESK_WORKER_TOKEN` (`openssl rand -hex 24`), `ADMIN_TOKEN` (same), `HATCHERY_UID=$(id -u)`, `HATCHERY_GID=$(id -g)`, `WORKER_COUNT=1`.
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
- [ ] **Decide where bot proof commits go.** The desk commits accepted proofs locally (`lean/Proofs/`).
      It never pushes. Pushing (and a bot account) belongs to Phase 6.
- [ ] Out of scope for Claude Code, as always (BUILD_PROMPT.md section 13): the token, wallets, fee routing,
      legal review, paying API bills, marketing.

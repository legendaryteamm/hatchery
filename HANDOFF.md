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
- [ ] **Real treasury adapter** (TODO; nothing is connected to a chain). The pantry runs on the mock
      adapter until a maintainer decides:
      1. which chain and which asset the fees arrive in, and the treasury's public address
         (the wallet itself and its keys stay with people, never in this repo or on the server);
      2. how many confirmations count as final on that chain;
      3. the USD price source (e.g. a named exchange API or an on-chain oracle) and how often to read it.
      Then a developer implements `TreasuryAdapter` and `PriceSource` (`apps/indexer/src/adapter.ts`),
      registers them in `apps/indexer/src/adapters.ts`, adds tests like `apps/indexer/test/indexer.test.ts`
      against recorded chain responses, and sets `TREASURY_CHAIN`, `TREASURY_ADDRESS`, `PRICE_SOURCE`
      on the server. The desk refuses inflows from any other chain, so mock money cannot leak in.
- [ ] **Record every top-up** (money moved from the treasury wallet to API billing) with its tx hash and
      invoice id: `pnpm desk pantry-outflow topup_transfer <usd> "tx <hash> / invoice <id>"` (or the admin page,
      Phase 6). Once a month, compare the ledger's API spend with the provider's invoices.
- [ ] **GitHub for outside contributors** (Phase 6). Do these in order, after the repository is on GitHub
      and the site has its domain (docs/deploy.md). `<site>` below is your `PUBLIC_SITE_URL`, e.g. `https://hatchery.example`.
      1. **OAuth app** (sign-in on the site). GitHub, logged in as the project owner or organisation:
         Settings, Developer settings, OAuth Apps, *New OAuth App*.
         - Application name: `The Hatchery`; Homepage URL: `<site>`;
         - Authorization callback URL: `<site>/api/auth/github/callback` (exactly this);
         - leave "Enable Device Flow" off. *Register application*, then *Generate a new client secret*.
         - On the server, in `.env`: `GITHUB_CLIENT_ID=<Client ID>`, `GITHUB_CLIENT_SECRET=<secret>`,
           `ADMIN_GITHUB_HANDLES=<your login>,<other maintainers>`, `CONTRIB_REPO=<owner>/<repo>`.
           Restart the desk. `<site>/join` now shows "Sign in with GitHub". Never set `DEV_LOGIN` on the server
           (the desk refuses to start with it on an https site anyway).
      2. **Proof bot account** (if you did not create it for "Set up the proof bot" above): a separate GitHub account,
         e.g. `hatchery-proof-bot`, with its own email and 2FA. Invite it to the repository with **Write** access.
         Logged in as the bot: Settings, Developer settings, Personal access tokens, *Fine-grained tokens*, *Generate new token*:
         - Resource owner: the repository's owner; Repository access: *Only select repositories* → this repository;
         - Permissions: **Contents: Read and write**, **Pull requests: Read and write** (Metadata: read is automatic); nothing else;
         - expiration: 90 days (put a reminder in your calendar to rotate it).
      3. **Repository settings** (Settings, Secrets and variables, Actions):
         - Secrets: `PROOF_BOT_TOKEN` = the bot's fine-grained token; `DESK_CONTRIB_TOKEN` = a new random value
           (`openssl rand -hex 24`), and the SAME value as `CONTRIB_TOKEN` in the server's `.env`.
         - Variables: `DESK_URL` = `<site>/api`; `SITE_URL` = `<site>`; `PROOF_BOT_LOGIN` = the bot's login;
           `CONTRIB_AUTO_MERGE` = `false` at first (only comments), `true` once you trust it.
      4. **Branch protection** for `main` (Settings, Rules, Rulesets, *New branch ruleset*): require a pull request
         for changes, require the status check **"Lean judge (same runner image as the colony)"**, block force pushes.
         Add the proof bot to the bypass list only if your plan needs it for the desk's own `lean/Proofs/` pushes.
         Settings, Actions, General: "Fork pull request workflows from outside collaborators": *Require approval for
         first-time contributors* (recommended), and keep the default read-only `GITHUB_TOKEN` permissions.
      5. **Acceptance run with a test account** (the Phase 6 bar): a second GitHub account signs in at `<site>/join`,
         creates a token, leases a lemma with `curl` (see `<site>/join.txt`), opens a PR from a fork that adds only
         `lean/Proofs/<L>.lean`. Expected: `contrib-check` comments a verdict; with a correct proof, `contrib-merge`
         reports "Desk … pass" and (with auto-merge on) the bot merges; the site shows the lemma as checked by `gh-<login>`.
         Also try a PR that changes a second file: it must be refused without being judged.
- [ ] Out of scope for Claude Code, as always (BUILD_PROMPT.md section 13): the token, wallets, fee routing,
      legal review, paying API bills, marketing.

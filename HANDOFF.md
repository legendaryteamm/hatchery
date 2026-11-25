# Handoff: things only a human can do

Claude Code built and tested everything with a scripted mock model (no API calls, no cost), a mock
treasury and a stand-in for GitHub. The steps below need a person: accounts, credentials, money, a
server, or a mathematician. They are **in order**; each group says who does it.

- **You** = the maintainer (owner of the project and its accounts).
- **Developer** = whoever runs the server (can be you). Their guide is [`docs/deploy.md`](docs/deploy.md).
- **Math advisor** = a mathematician who reviews definitions and statements in the browser.

## A. You, on your laptop (no accounts needed yet)

- [ ] **1. Look at the site** with the mock colony (no API key, throwaway database, no commits):
      `docker compose up -d --wait postgres`, then `pnpm mock:colony` and, in a second terminal, `pnpm web:dev`;
      open http://localhost:5173. Check it on your phone too (light and dark). `/join` offers a local test login
      (the name `admin` can open `/admin`). Ctrl-C on the mock colony drops its database.
- [ ] **2. Delete the pre-rewrite backup refs** once you are happy with the new commit identity (they still
      hold the old email): `git update-ref -d refs/backup/pre-identity-rewrite && git update-ref -d refs/original/refs/heads/main`,
      then `git reflog expire --expire=now --all && git gc --prune=now`.

## B. You: GitHub, the API account, and decisions

- [ ] **3. Push the repo to GitHub** (decide: organisation or personal account; public or private until launch).
      `.github/workflows/judge.yml` then runs the unit tests, the lite image and the full Mathlib image.
      Nothing uses Mathlib until its `full` job ("full image (pinned Mathlib)") is green.
      Then set `CONTRIB_REPO=<owner>/<repo>` in the server's `.env` later (step 10).
- [ ] **4. Anthropic API account:** create an API key for the project and set a **monthly spending limit** in
      the Anthropic Console (a hard ceiling independent of this project).
- [ ] **5. Real-agent check, once a key exists** (the Phase 1/2 checks with real money, a few dollars):
  1. `cp .env.example .env`. Set `ANTHROPIC_API_KEY`, `AGENT_MODEL=claude-opus-5-5`, `DESK_WORKER_TOKEN` (`openssl rand -hex 24`), `ADMIN_TOKEN` (same), `HATCHERY_UID=$(id -u)`, `HATCHERY_GID=$(id -g)`, `WORKER_COUNT=1`.
     This is a **real run**: to let the desk commit accepted proofs into this checkout, also set
     `PROOF_COMMIT_MODE=commit`, `HATCHERY_REAL_RUN=1`, `REPO_MOUNT_MODE=rw`. Leave them out to keep the
     bot commits in a throwaway sandbox clone instead (the default).
  2. Give the pantry some (mock) food, which limits spend: the daily budget is pantry / 30.
     `JUDGE_FLAVOR=lite docker compose up -d desk`, then
     `docker compose exec desk node --import tsx src/cli.ts pantry-mock-inflow 30` (→ $1/day).
  3. `JUDGE_FLAVOR=lite docker compose --profile agents up worker`, and stop it (Ctrl-C) when the 5 lemmas are done or it sleeps.
  4. `docker compose exec desk node --import tsx src/cli.ts report`: at least 3 of 5 `checked` (the Phase 1 bar).
  5. Sorry check: `pnpm judge:check L-core-001 apps/judge/test/fixtures/sorry.lean` must print `"verdict": "fail"`.
  6. Costs: compare the `report` total with the Anthropic Console usage for the same time window. Small
     differences can come from rounding; a large one means `packages/shared/src/prices.ts` needs updating.
- [ ] **6. Decide the treasury** (nothing is connected to a chain; the site says "Development pantry"):
      1. which chain and which asset the fees arrive in, and the treasury's public address
         (the wallet itself and its keys stay with people, never in this repo or on the server);
      2. how many confirmations count as final on that chain;
      3. the USD price source (e.g. a named exchange API or an on-chain oracle) and how often to read it.
      The developer then builds the adapter (step 15). The token itself, its launch, fee routing and the
      legal review stay with you (out of scope below).
- [ ] **7. Choose a domain and a server provider** (sizes in docs/deploy.md section 2), and pay for them.

## C. Developer: the server (follow docs/deploy.md)

- [ ] **8. Server, domain, HTTPS** (deploy.md sections 2-3): Ubuntu 24.04, firewall, Docker, DNS A record.
- [ ] **9. Proof bot account and deploy key** (deploy.md sections 4 and 13): a separate GitHub account,
      e.g. `hatchery-proof-bot`, with its own email and 2FA, invited to the repository with **Write** access.
      On the server: an SSH key pair added to the repository as a **deploy key with write access**; clone the
      repository with it to `/srv/hatchery/app`; Actions variable `PROOF_BOT_LOGIN` = the bot's login. Never push from a laptop.
- [ ] **10. Configure, build, start** (deploy.md sections 5-7): `.env` (secrets from `openssl rand -hex 24`),
      `docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml build lean-runner` (the Mathlib image,
      on the server only), then `up -d postgres judge desk web`; `https://<domain>/api/health` shows `ok: true`,
      `judge.flavor: "full"`, `judge.fresh: true`.
- [ ] **11. GitHub sign-in and contributor CI.** `<site>` is `https://<domain>`.
      1. **OAuth app** (as the project owner or organisation): Settings, Developer settings, OAuth Apps, *New OAuth App*.
         - Application name: `The Hatchery`; Homepage URL: `<site>`;
         - Authorization callback URL: `<site>/api/auth/github/callback` (exactly this);
         - leave "Enable Device Flow" off. *Register application*, then *Generate a new client secret*.
         - In the server's `.env`: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ADMIN_GITHUB_HANDLES=<your login>,<other maintainers>`,
           `CONTRIB_REPO=<owner>/<repo>`. Restart the desk. `<site>/join` now shows "Sign in with GitHub".
           Never set `DEV_LOGIN` on the server (the desk refuses it on an https site anyway).
      2. **The bot's fine-grained token** (logged in as the bot): Settings, Developer settings, Personal access tokens,
         *Fine-grained tokens*, *Generate new token*:
         - Resource owner: the repository's owner; Repository access: *Only select repositories* → this repository;
         - Permissions: **Contents: Read and write**, **Pull requests: Read and write** (Metadata: read is automatic); nothing else;
         - expiration: 90 days (calendar reminder to rotate it).
      3. **Repository settings** (Settings, Secrets and variables, Actions):
         - Secrets: `PROOF_BOT_TOKEN` = the bot's fine-grained token; `DESK_CONTRIB_TOKEN` = a new random value
           (`openssl rand -hex 24`), the SAME value as `CONTRIB_TOKEN` in the server's `.env`.
         - Variables: `DESK_URL` = `<site>/api`; `SITE_URL` = `<site>`; `PROOF_BOT_LOGIN` (step 9);
           `CONTRIB_AUTO_MERGE` = `false` at first (only comments), `true` once you trust it.
      4. **Protect `main`** (Settings, Rules, Rulesets, *New branch ruleset*, target `main`): block force pushes
         and deletions; require a pull request; require the status check **"unit + lite image (Lean core)"** (it runs
         on every pull request). Add **Deploy keys** to the bypass list, so the desk's proof commits (pushed with the
         deploy key, checked by the `bot-scope` job) can go straight to `main`. Do not make the contributor check a
         required check: it runs only on proof pull requests, and `contrib-merge` enforces it itself.
         Settings, Actions, General: fork pull request workflows need approval for first-time contributors (recommended);
         keep the default read-only `GITHUB_TOKEN`.
- [ ] **12. Mathlib gate:** set `MATHLIB_LEMMAS_ENABLED=1` only after the `full` job is green for the deployed commit,
      and restart the desk (deploy.md section 6).
- [ ] **13. Backups and monitoring** (deploy.md sections 10-12): `deploy/backup.sh` nightly by cron with an off-site
      `rclone` remote, `deploy/healthcheck.sh` every 5 minutes, `ALERT_WEBHOOK_URL`, an external uptime monitor on
      `<site>/api/health`, and **one test restore** before going public.
- [ ] **14. Contributor acceptance run with a test GitHub account** (the Phase 6 bar on real GitHub): a second account
      signs in at `<site>/join`, creates a token, leases a lemma with `curl` (see `<site>/join.txt`), and opens a PR from a
      fork that adds only `lean/Proofs/<L>.lean`. Expected: `contrib-check` comments a verdict; with a correct proof,
      `contrib-merge` reports "Desk … pass" and (with auto-merge on) the bot merges; the site shows the lemma as checked
      by `gh-<login>`. Also try a PR that changes a second file: it must be refused without being judged.
- [ ] **15. Real treasury adapter** (after step 6): implement `TreasuryAdapter` and `PriceSource`
      (`apps/indexer/src/adapter.ts`), register them in `apps/indexer/src/adapters.ts`, add tests like
      `apps/indexer/test/indexer.test.ts` against recorded chain responses, set `TREASURY_CHAIN`, `TREASURY_ADDRESS`,
      `PRICE_SOURCE` and `INDEXER_TOKEN` on the server, and run the `indexer` service (remove its `mock-pantry`
      profile for production). The desk refuses inflows from any other chain, so mock money cannot leak in.
- [ ] **16. Turn the agents on** when you (the maintainer) agree on the caps (deploy.md section 8):
      `ANTHROPIC_API_KEY`, `AGENT_MODEL`, `WORKER_COUNT`, then `--profile agents up -d worker`.

## D. Math advisor

- [ ] **17. Invite the advisor** (you or the developer): `docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml exec desk node --import tsx src/cli.ts reviewer add "Name" advisor`
      prints a one-time link; send it privately.
- [ ] **18. The advisor reviews** the four DRAFT definitions in the browser (no developer account needed), then
      the proposed statements in the review queue. Until a definition is approved, no statement that uses it can be
      approved or worked on, and the site shows it as a draft.

## E. Ongoing

- **Commit approved statements** to `lean/Statements/` from time to time (`pnpm desk export-statements --to lean`
  with `HATCHERY_REAL_RUN=1`, review, commit, push). Proofs of those lemmas are committed after that.
- **Record every top-up** (money moved from the treasury wallet to API billing) with its tx hash and invoice id on
  the admin page (or `pnpm desk pantry-outflow topup_transfer <usd> "tx <hash> / invoice <id>"`). Once a month,
  compare the ledger's API spend with the provider's invoices.
- **Rotate** the bot's fine-grained token before it expires; **test a restore** monthly; read the pantry alerts.

## Out of scope for Claude Code (BUILD_PROMPT.md section 13)

The token, the launchpad, fee routing, wallets and their keys, legal review (token disclosures, securities rules),
paying API bills and moving funds, marketing.

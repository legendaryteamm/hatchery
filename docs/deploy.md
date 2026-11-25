# Deploy guide: one VPS with Docker Compose

This guide takes a developer who has never seen the project from an empty server to a running
site. Nothing in this repository deploys anything by itself; every step below is done by a person.

**Read first:** [`README.md`](../README.md) (what the project is) and [`HANDOFF.md`](../HANDOFF.md)
(what still needs a human). The honesty rules in `BUILD_PROMPT.md` section 1 apply to the running
site too: it must never suggest that P vs NP is settled.

## Contents

1. [What runs where](#1-what-runs-where)
2. [The server](#2-the-server)
3. [Domain and HTTPS](#3-domain-and-https)
4. [Get the code (and the proof bot's key)](#4-get-the-code-and-the-proof-bots-key)
5. [Configuration (.env)](#5-configuration-env)
6. [Build the images, including Mathlib](#6-build-the-images-including-mathlib)
7. [First start and checks](#7-first-start-and-checks)
8. [Turning the agents on (this spends money)](#8-turning-the-agents-on-this-spends-money)
9. [The kill switch](#9-the-kill-switch)
10. [Backups and restoring](#10-backups-and-restoring)
11. [Logs](#11-logs)
12. [Monitoring and alerts](#12-monitoring-and-alerts)
13. [How proofs get into the repository (the proof bot)](#13-how-proofs-get-into-the-repository-the-proof-bot)
14. [Updating](#14-updating)
15. [Security checklist](#15-security-checklist)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. What runs where

Everything runs on one machine with `docker compose`, from two files: `docker-compose.yml` (the base,
also used for development) and `deploy/docker-compose.prod.yml` (production overrides).

```
 internet ──443/80──▶ web (Caddy)  ── static site (apps/web build)
                         │ /api/*, /join.txt
                         ▼
                       desk (Fastify, :4200, internal) ──▶ postgres (internal)
                         │ judge requests                    ▲
                         ▼                                   │
                       judge (:4100, internal) ──starts──▶ lean-runner sandbox containers
                         ▲                                  (one per check: no network, non-root, limits)
          worker(s), decomposer (profile "agents") ── call the Anthropic API, talk only to the desk
          indexer (profile "mock-pantry")          ── development only until a real chain adapter exists
```

| Service | What it does | Reachable from the internet |
|---|---|---|
| `web` | Caddy: HTTPS certificates, the site, reverse proxy to the desk | yes (80, 443) |
| `desk` | the API: leases, budget, kill switch, events, review tool, pantry, contributors; commits accepted proofs | only through `web` |
| `postgres` | the database (every event, attempt, dollar) | no |
| `judge` | the Lean checking service; starts a fresh sandbox container per check | no |
| `lean-runner` | builds the sandbox image (`full` = with Mathlib) and exits | no |
| `worker`, `decomposer` | the AI agents (opt-in profile `agents`; they spend API money) | no |
| `indexer` | pantry inflows; only a mock adapter exists (HANDOFF.md) | no |

The judge mounts the Docker socket to start its sandbox containers. Anything with that socket is
root on the host, which is why the judge service only runs trusted code and is never exposed
(details in [`docs/judge.md`](judge.md)).

## 2. The server

**Size.** The Lean judge is the heavy part: a check with Mathlib uses up to `JUDGE_MEMORY_MB`
(default 8 GB) and two CPUs, and building the Mathlib image needs about 20 GB of disk.

| | Minimum | Recommended |
|---|---|---|
| CPU | 4 vCPU | 8 vCPU (judge checks and agents in parallel) |
| RAM | 16 GB | 32 GB (allows `JUDGE_CONCURRENCY=2`) |
| Disk | 80 GB SSD | 160 GB SSD |
| OS | Ubuntu 24.04 LTS (x86_64) | same |

Any provider with dedicated or "CPU-optimized" instances works; avoid burstable/shared-CPU plans,
because Lean checks hit the CPU limit for minutes. ARM64 servers work for Docker, but the runner
image has only been built on x86_64 in CI.

**Base setup** (as root, once):

```bash
adduser --disabled-password hatchery && usermod -aG sudo hatchery
# SSH keys only:
mkdir -p /home/hatchery/.ssh && cp ~/.ssh/authorized_keys /home/hatchery/.ssh/ && chown -R hatchery: /home/hatchery/.ssh
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
# Firewall: only SSH and the web.
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
# Security updates automatically:
apt-get update && apt-get install -y unattended-upgrades git curl jq rclone && dpkg-reconfigure -f noninteractive unattended-upgrades
```

**Docker Engine and the Compose plugin**, from Docker's own apt repository (not the Ubuntu
`docker.io` package): follow <https://docs.docker.com/engine/install/ubuntu/>, then
`usermod -aG docker hatchery`. Check with `docker compose version` (v2.24 or newer, for `!reset`).

> Docker publishes ports through its own iptables rules, past `ufw`. That is fine here: in production
> only `web` publishes ports (the prod override removes the others' `ports:`). Never add a `ports:`
> line to postgres, the desk or the judge on the server.

**Folders:**

```bash
sudo mkdir -p /srv/hatchery/{app,secrets,backups} && sudo chown -R hatchery: /srv/hatchery && chmod 700 /srv/hatchery/secrets
```

## 3. Domain and HTTPS

1. Choose the domain, e.g. `hatchery.example`. At your DNS provider create an **A** record (and an
   **AAAA** record if the server has IPv6) pointing to the server's IP. Wait until
   `dig +short hatchery.example` returns it.
2. That is all for HTTPS: Caddy (the `web` service) gets and renews Let's Encrypt certificates by
   itself, as long as ports 80 and 443 reach it and `SITE_DOMAIN` / `ACME_EMAIL` are set in `.env`.
   The email gets expiry warnings from Let's Encrypt if renewal ever fails.
3. Optional hardening: a CAA record `0 issue "letsencrypt.org"`.

The site and the API share one origin (`https://<domain>` and `https://<domain>/api`), so cookies
stay `SameSite` and no CORS is needed. Caddy also sends HSTS, a Content Security Policy and other
security headers (`deploy/Caddyfile`).

## 4. Get the code (and the proof bot's key)

The desk commits accepted proofs into the checkout on the server, and the proof bot pushes them
(section 13). So the checkout is cloned with the bot's **deploy key**, not your personal key.

```bash
# as the hatchery user
ssh-keygen -t ed25519 -N "" -C "hatchery proof bot" -f /srv/hatchery/secrets/proof_bot_deploy_key
cat /srv/hatchery/secrets/proof_bot_deploy_key.pub
```

On GitHub, in the repository: Settings, Deploy keys, *Add deploy key*: paste the public key, tick
**Allow write access**. A deploy key works for this one repository only.

```bash
# GitHub's host keys, pinned (compare the fingerprints with
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints):
ssh-keyscan github.com > /srv/hatchery/secrets/known_hosts && ssh-keygen -lf /srv/hatchery/secrets/known_hosts
chmod 600 /srv/hatchery/secrets/*
# The desk container runs as the checkout's owner and reads these files:
id -u; id -g      # -> HATCHERY_UID / HATCHERY_GID in .env

GIT_SSH_COMMAND="ssh -i /srv/hatchery/secrets/proof_bot_deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/srv/hatchery/secrets/known_hosts" \
  git clone git@github.com:<owner>/<repo>.git /srv/hatchery/app
cd /srv/hatchery/app
git config user.name "Hatchery Judge" && git config user.email "<bot-login>@users.noreply.github.com"
```

Deploy a commit whose GitHub Actions run is green (section 6, "the Mathlib gate").

## 5. Configuration (.env)

```bash
cd /srv/hatchery/app && cp .env.example .env && chmod 600 .env
openssl rand -hex 24     # run once per secret below
```

`.env` holds secrets: it is in `.gitignore`, never commit or paste it. Values containing spaces must
be quoted. The tables list what production needs; `.env.example` documents every variable.

**Required**

| Variable | Value |
|---|---|
| `SITE_DOMAIN` | `hatchery.example` (no `https://`) |
| `ACME_EMAIL` | an address that receives certificate warnings |
| `POSTGRES_PASSWORD` | random (`openssl rand -hex 24`) |
| `DESK_WORKER_TOKEN` | random; workers authenticate with it |
| `JUDGE_API_TOKEN` | random; the desk authenticates to the judge with it |
| `HATCHERY_UID`, `HATCHERY_GID` | output of `id -u` / `id -g` (section 4) |
| `JUDGE_FLAVOR` | `full` (Mathlib) |
| `PUBLIC_SITE_URL` | not needed: the prod override sets it to `https://$SITE_DOMAIN` |

**Budget and safety** (defaults are safe; read section 8 before changing)

| Variable | Default | Meaning |
|---|---|---|
| `GLOBAL_DAILY_CAP_USD` | 100 | most the colony may spend per day, whatever the pantry holds |
| `RUNWAY_TARGET_DAYS` | 30 | daily budget = min(cap, pantry / this) |
| `KILL_SWITCH` | 0 | 1 = no model calls at all (see section 9) |
| `ADMIN_TOKEN` | empty | bearer token for admin calls from scripts; empty = only the admin page |
| `ADMIN_GITHUB_HANDLES` | empty | GitHub logins allowed into `/admin` (comma-separated) |
| `MATHLIB_LEMMAS_ENABLED` | 0 | 1 only after the Mathlib gate (section 6) |

**Agents** (only when you turn them on, section 8): `ANTHROPIC_API_KEY`, `AGENT_MODEL`
(e.g. `claude-opus-5-5`), `WORKER_COUNT`, `AGENT_MAX_TURNS`, `WORKER_MAX_RUN_USD`.

**Outside contributors** (HANDOFF.md, "GitHub for outside contributors"): `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `CONTRIB_TOKEN` (same value as the repository secret `DESK_CONTRIB_TOKEN`),
`CONTRIB_REPO`. Never set `DEV_LOGIN` on the server (the prod override forces it to 0, and the desk
refuses it on an https site).

**Pantry:** leave `TREASURY_CHAIN=mock` until a real adapter exists (HANDOFF.md). With `mock`, the
site labels the pantry "Development pantry", and no indexer runs in production. `ALERT_WEBHOOK_URL`
(a Slack or Discord incoming webhook) receives low-food alerts and the health check's alerts.

**Proof bot:** `PROOF_PUSH=1` (default in the prod override), `PROOF_PUSH_REMOTE=origin`,
`PROOF_PUSH_BRANCH=main`, `SECRETS_DIR=/srv/hatchery/secrets` (default).

## 6. Build the images, including Mathlib

The Mathlib (full) runner image is about 7-8 GB and is built **on the server** (never on a
development laptop). It needs about 20 GB of free disk during the build and takes 20-60 minutes.

```bash
cd /srv/hatchery/app
alias dc='docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml'
dc build lean-runner                    # JUDGE_FLAVOR=full: toolchain + Mathlib cache
dc run --rm lean-runner                 # prints: Lean (version 4.36.0 ...), flavor=full, trusted_sha=...
dc build judge desk web worker
```

Building from your laptop without using its disk: create a Docker context for the server
(`docker context create hatchery-vps --docker "host=ssh://hatchery@<server>"`) and run the same
commands with `docker --context hatchery-vps compose ...`. Only the small build context is uploaded.

CI (`.github/workflows/judge.yml`) also builds the full image on every push and records its id as the
`runner-full-digest` artifact, but does not publish it. To pull CI-built images instead of building
here, add a push step to a registry you control and pin `JUDGE_IMAGE=registry/...@sha256:...`.

### The Mathlib gate

Agents must not work on Mathlib lemmas until the **`full` job ("full image (pinned Mathlib)") of the
`judge` workflow is green** for the commit you deploy. Two independent switches enforce this:

1. `MATHLIB_LEMMAS_ENABLED=1` in `.env` (default 0). Set it only after checking that run.
2. The judge must report `flavor=full`. With the lite image, Mathlib lemmas are never leased and
   submissions for them are refused, whatever the flag says.

A statement counts as a Mathlib lemma when its file in `lean/Statements/` contains `import Mathlib…`.
The desk also refuses all leases and checks while the judge image is **stale** (the hash of
`lean-toolchain` and `Defs/` baked into the image differs from the checkout). `/api/health` shows
`judge.fresh`. After changing definitions or the toolchain, rebuild `lean-runner` and restart `judge`.

## 7. First start and checks

```bash
dc up -d postgres judge desk web     # migrations run automatically when the desk starts
dc ps                                # all "running" / "healthy"; lean-runner "exited (0)" is normal
curl -s https://$SITE_DOMAIN/api/health | jq     # ok: true, judge.flavor: "full", judge.fresh: true
```

Open `https://<domain>`: the colony is empty (no agents yet), the footer carries the honesty line,
and the Pantry page says "Development pantry". Then:

1. **Admin access:** set `ADMIN_GITHUB_HANDLES` and the GitHub OAuth app (HANDOFF.md), restart the
   desk (`dc up -d desk`), sign in at `/join`, open `/admin`.
2. **Math advisor:** `dc exec desk node --import tsx src/cli.ts reviewer add "Name" advisor` prints a
   one-time link; send it privately. Definitions stay DRAFT until the advisor approves them.
3. **Contributor CI:** set the repository's Actions secrets and variables (HANDOFF.md) so pull
   requests are judged and, if you choose, merged.

## 8. Turning the agents on (this spends money)

Agents call the Anthropic API, paid from your API account. Every call is recorded with its cost and
shown publicly. They eat only while the pantry has food and their daily cap allows:

- daily budget = min(`GLOBAL_DAILY_CAP_USD`, pantry / `RUNWAY_TARGET_DAYS`);
- per-agent cap = that budget / awake agents; an agent naps when its share is used;
- the pantry is real inflows minus recorded API spend. With the mock treasury, add food only with
  `dc exec desk node --import tsx src/cli.ts pantry-mock-inflow <usd>`, and it is labelled as mock.

Set a **spending limit in the Anthropic Console** as well, as a hard ceiling independent of this
project. Then:

```bash
# in .env: ANTHROPIC_API_KEY, AGENT_MODEL, WORKER_COUNT (start with 2)
dc --profile agents up -d worker      # and later: decomposer
dc logs -f worker
```

Record every top-up (money moved from the treasury wallet to API billing) on the admin page, and
compare the ledger's API spend with the provider's invoices once a month (HANDOFF.md).

## 9. The kill switch

The kill switch stops **all** model calls within one loop iteration, and outside leases too. Use
whichever is at hand:

| How | Effect | Undo |
|---|---|---|
| Admin page `/admin`: *Pause the colony* | shared switch in the database; recorded in the feed with your login | *Resume the colony* |
| `dc exec desk node --import tsx src/cli.ts kill-switch on` | same switch, from the server | `kill-switch off` |
| `curl -X POST https://<domain>/api/admin/kill-switch -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"on":true,"by":"<you>"}'` | same switch, from a script | `{"on":false,...}` |
| `KILL_SWITCH=1` in `.env`, then `dc up -d desk worker` | cannot be undone from the site | remove it, `dc up -d desk worker` |
| `dc stop worker decomposer` | stops the agent processes themselves | `dc --profile agents up -d worker` |
| Revoke the API key in the Anthropic Console | last resort: no call can succeed | new key in `.env` |

The site shows a "Paused" banner while the switch is on.

## 10. Backups and restoring

**What needs backing up:** the database (every event, attempt, message, review and dollar). Checked
proofs also live in Git (`lean/Proofs/`, pushed by the bot), and the code is on GitHub. Secrets
(`.env`, `/srv/hatchery/secrets`) belong in your password manager, not in a backup bucket.

`deploy/backup.sh` writes a compressed `pg_dump`, checks that it is complete, keeps 14 days, and
optionally copies it off the server with `rclone`:

```bash
rclone config        # once: create a remote, e.g. "b2" or "s3", with a bucket for backups
crontab -e           # as the hatchery user:
15 3 * * *  cd /srv/hatchery/app && BACKUP_REMOTE=b2:hatchery-backups deploy/backup.sh >> /srv/hatchery/backups/backup.log 2>&1
```

Use an off-site bucket with object versioning or a retention lock, so a compromised server cannot
delete the old backups.

**Restoring:** `deploy/restore.sh /srv/hatchery/backups/hatchery-<stamp>.sql.gz`. It verifies the
checksum, asks for confirmation, stops the services that write, restores, and starts the desk and
site. A restore never deletes proof files: the desk removes a proof from `lean/Proofs/` only when the
restored database explicitly says it is not checked.

**Test a restore** once a month on a scratch machine or a second compose project
(`docker compose -p hatchery-restore-test ...`): a backup you have never restored is a hope, not a backup.

## 11. Logs

Every service logs to stdout in JSON (the desk via Fastify/pino, Caddy in JSON). Docker keeps them,
rotated at 5 x 20 MB per service (`deploy/docker-compose.prod.yml`, `x-logging`).

```bash
dc logs -f desk                     # live
dc logs --since 1h desk | jq -r 'select(.level >= 40) | "\(.time) \(.msg)"'   # warnings and errors
dc logs --since 24h web | jq -r 'select(.status >= 500)'                     # server errors seen by Caddy
```

Worth knowing in the desk log:

| Message | Meaning |
|---|---|
| `where accepted proofs go` | at start: commit mode, target, push on/off |
| `Pantry alert: ...` | low food or empty pantry (also in the feed and the webhook) |
| `push failed (will retry ...)` | the bot could not push; see section 16 |
| `lemmas marked for re-check` / `re-checks done` | something a proof depends on changed |
| `GitHub sign-in failed` | OAuth misconfiguration (callback URL, secret) |

Agents' reasoning is not in the logs; what they did is in the database and on the site.

## 12. Monitoring and alerts

1. **Health check from the server**, every 5 minutes: `deploy/healthcheck.sh` checks the site,
   `/api/health` (desk up and judge image fresh), `/join.txt`, the live event stream, disk use and the
   certificate's expiry, and posts to `ALERT_WEBHOOK_URL` when the state changes.
   ```bash
   crontab -e
   */5 * * * *  cd /srv/hatchery/app && deploy/healthcheck.sh >> /srv/hatchery/health.log 2>&1
   ```
2. **Outside view:** add an external uptime monitor (any provider) on `https://<domain>/api/health`,
   so you also hear about it when the whole server is down.
3. **Pantry alerts** come from the desk itself (empty pantry, or under 3 days of food at the current
   pace): log, feed, and the same webhook.
4. **Spend:** the Pantry page and `dc exec desk node --import tsx src/cli.ts report` show recorded spend; the Anthropic Console
   shows the provider's view. A difference beyond rounding means the price table needs updating.
5. **CI:** watch the `judge`, `contrib-check` and `contrib-merge` workflows on GitHub. A red
   `check-repo` step means a committed proof no longer passes: investigate before anything else.

## 13. How proofs get into the repository (the proof bot)

When the judge accepts a proof, the desk writes `lean/Proofs/<L>.lean` and commits **only that file**
as "Hatchery Judge" (`git commit --only`).

| Setting | Where commits go | Used for |
|---|---|---|
| `PROOF_COMMIT_MODE=sandbox` (default) | a throwaway clone, never the checkout | tests, mock runs, dev runs |
| `PROOF_COMMIT_MODE=commit` + `HATCHERY_REAL_RUN=1` | the checkout (the prod override sets both, and mounts it read-write) | the server |
| `PROOF_COMMIT_MODE=off` | nowhere (database only) | |

A proof is committed only once its **approved statement file** is in the checkout with the same
content, because CI re-checks every proof against it. Approved statements reach the repository
through a maintainer, never the bot: `pnpm desk export-statements --to lean` on a development
machine (with `HATCHERY_REAL_RUN=1`), review the diff, commit, push, and pull on the server. The desk
commits the waiting proofs at its next start.

**Pushing.** With `PROOF_PUSH=1`, the desk pushes after each commit through the deploy key
(section 4). Before pushing it fetches the remote and, if contributor pull requests were merged in the
meantime, rebases its proof commits on top (they only add files under `lean/Proofs/`). Locally,
never push: `PROOF_PUSH` is refused unless `PROOF_COMMIT_MODE=commit` and `HATCHERY_REAL_RUN=1`.

**The bot touches only `lean/Proofs/`**, enforced three ways:
- the desk commits a single path with `git commit --only`;
- the `bot-scope` job in `.github/workflows/judge.yml` fails any push by `PROOF_BOT_LOGIN` (an
  Actions variable) that changes a file outside `lean/Proofs/` or creates a branch;
- optional: a push ruleset with a file-path restriction, if your GitHub plan offers it.

**Contributor pull requests** are merged by the same bot account (with its fine-grained token,
`PROOF_BOT_TOKEN`), only after the CI judge and the desk's own judge both pass
(`.github/workflows/contrib-*.yml`, [`docs/phase-6.md`](phase-6.md)). The desk then pins the lemma to
the merge commit.

**CI re-checks every pushed proof:** the lite and full jobs run `pnpm --filter @hatchery/judge cli
check-repo`, which re-judges every file in `lean/Proofs/` against its statement.

**Checked proofs and commits.** Every checked proof records its exact source, sha256, the commit that
added it, and a fingerprint of everything it depends on. When a statement, a definition, the
toolchain/Mathlib pin or an imported proof changes, the desk marks the lemma and everything that
imports it as `recheck`, re-judges them (dependencies first), and returns any that fail to `open`
(the old proof is kept in the `recheck_failed` event).

## 14. Updating

```bash
cd /srv/hatchery/app
git fetch && git log --oneline HEAD..origin/main     # read what changes
dc stop worker decomposer                             # let agents finish cleanly (optional)
git pull --ff-only                                    # the bot's commits are already on origin
dc build desk web worker judge
dc up -d desk web judge && dc --profile agents up -d worker
curl -s https://$SITE_DOMAIN/api/health | jq .judge
```

- **Changed `lean/Defs/` or `lean-toolchain`?** Rebuild `lean-runner` too (`dc build lean-runner`,
  then `dc up -d judge`), or the desk refuses work because the judge is stale. Changed definitions go
  back to DRAFT until the math advisor reviews them again.
- **Mathlib or Lean version bump:** deploy only a commit whose `full` CI job is green; every checked
  proof is re-checked automatically after the switch.
- **Database migrations** run automatically when the desk starts. Take a backup first
  (`deploy/backup.sh`) for any release that contains a new file in `apps/desk/drizzle/`.
- If `git pull --ff-only` fails, the server has a commit that is not on GitHub (a failed push).
  Run `git status` and `git log origin/main..HEAD`, and push or rebase by hand with the deploy key.

## 15. Security checklist

- [ ] Only ports 22, 80 and 443 are reachable (`ufw status`, and `ss -tlnp` shows nothing else on `0.0.0.0`).
- [ ] SSH: keys only, no root login.
- [ ] `.env` and `/srv/hatchery/secrets` are mode 600 and not in Git or backups.
- [ ] `DEV_LOGIN` is not set; `ADMIN_GITHUB_HANDLES` lists only maintainers.
- [ ] The Anthropic Console has a monthly spending limit; `GLOBAL_DAILY_CAP_USD` is what you can afford.
- [ ] The proof bot's deploy key has write access to this repository only; its fine-grained token
      has Contents + Pull requests on this repository only, with an expiry date in your calendar.
- [ ] Branch protection on `main` requires the contributor check; fork workflows from first-time
      contributors need approval.
- [ ] The judge's Docker socket is never exposed; no `ports:` on postgres, desk or judge.
- [ ] Backups run, are copied off-site, and a restore was tested.
- [ ] No wallet keys exist anywhere on this server (BUILD_PROMPT.md section 13: wallets are a human matter).

## 16. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Site has no certificate | DNS not pointing here yet, or port 80/443 blocked | `dig +short <domain>`; `ufw status`; `dc logs web` |
| `/api/health` shows `judge.fresh: false` | runner image built from older `Defs/` or toolchain | `dc build lean-runner && dc up -d judge` |
| Desk refuses leases: "needs Mathlib" | judge runs the lite image | `JUDGE_FLAVOR=full`, rebuild `lean-runner` |
| Agents asleep all day | pantry empty or cap used (feed says why) | add food / raise caps deliberately |
| `push failed` in the desk log | deploy key missing write access, known_hosts wrong, or a conflict | `dc exec desk git -C /repo push --dry-run origin HEAD:main` |
| Live colony does not move, feed does | proxy buffering the event stream | check that the `flush_interval -1` line is in `deploy/Caddyfile` |
| "GitHub sign-in did not work" | callback URL or secret mismatch | the OAuth app's callback must be exactly `https://<domain>/api/auth/github/callback` |
| Contributor PR not merged | see the bot's comment on the PR | `DESK_URL`, `DESK_CONTRIB_TOKEN`, `CONTRIB_AUTO_MERGE`, `PROOF_BOT_TOKEN` |
| Out of disk | old images and build cache | `docker system df`; `docker image prune`; keep the current `hatchery-lean-runner:full` |

# Phase 7: deploy guide

Nothing was deployed. This phase adds the guide and the files a developer needs to run the
project on one VPS with Docker Compose. Where possible, each piece was checked locally.

## What was built

- **[`docs/deploy.md`](deploy.md):** the full guide, written for a developer new to the project.
  It covers:
  - what runs where;
  - server size and base setup (firewall, SSH, Docker);
  - domain, DNS and automatic HTTPS;
  - the checkout and the proof bot's deploy key;
  - every production setting;
  - building the Mathlib image on the server, and the Mathlib gate;
  - the first start;
  - turning the agents on (with the budget rules);
  - the six ways to stop spending (kill switch);
  - backups and tested restores;
  - logs;
  - monitoring and alerts;
  - how the bot pushes proofs (and contributor merges);
  - updating;
  - a security checklist;
  - troubleshooting.
- **`deploy/docker-compose.prod.yml`:** production overrides.
  - Only Caddy publishes ports (80/443); postgres, the judge and the desk are internal.
  - Services restart on failure and after a reboot; logs rotate (5 x 20 MB per service).
  - Required secrets fail fast if missing. `DEV_LOGIN` is forced off and `TRUST_PROXY` on.
  - The desk runs a real run (commit and push) with the deploy key and pinned GitHub host keys,
    mounted read-only.
- **`apps/web/Dockerfile` and `deploy/Caddyfile`:** the static site served by Caddy (pinned by
  digest).
  - Automatic Let's Encrypt certificates.
  - `/api/*` goes to the desk, with the live stream unbuffered; `/join.txt` comes from the desk.
  - Single-page-app fallback.
  - Security headers: HSTS, CSP, nosniff, frame deny, referrer and permissions policies.
- **`deploy/backup.sh`:** nightly `pg_dump`. It checks that the dump is complete, writes a
  checksum, keeps 14 days, and can copy off-site with `rclone`.
- **`deploy/restore.sh`:** verifies the checksum, asks for confirmation, and stops the writers
  while it restores.
- **`deploy/healthcheck.sh`:** a cron check of the site, `/api/health` (judge fresh), `join.txt`,
  the event stream, disk and certificate expiry. It posts to the alert webhook when the state
  changes.
- **`HANDOFF.md`:** reorganised into one ordered list, by who does what (you, the developer, the
  math advisor).

## What was checked

| Check | Result |
|---|---|
| `docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml config` with all profiles | valid; only `web` publishes ports; desk gets `PROOF_COMMIT_MODE=commit`, `PUBLIC_SITE_URL=https://<domain>`, checkout read-write, keys read-only |
| Missing required secret | refused: "required variable JUDGE_API_TOKEN is missing a value: set JUDGE_API_TOKEN in .env" |
| `docker build -f apps/web/Dockerfile` | builds; `caddy validate`: "Valid configuration" |
| The production site image, run locally (`SITE_DOMAIN=localhost`, internal certificate) in front of the mock colony | site 200, SPA route 200, `/api/health` ok, `/join.txt` served, live stream through the proxy: `text/event-stream`, 106 events in 3 s; HSTS, CSP and frame headers present |
| The site under that Content Security Policy (headless Chromium) | colony renders and animates (5 pets), Join page loads, **no console errors** |
| Shell scripts | `bash -n` syntax check passes |
| Test suite | passes (unchanged code paths) |

Not checked here (needs a real server): Let's Encrypt issuance, the Mathlib image build, cron,
`rclone`, and a push with the deploy key. These are the first things the guide's section 7 has the
developer verify.

## Known gaps

- One VPS is a single point of failure. The guide covers restoring from backups, not failover.
- The full runner image is built on the server, not pulled from a registry (guide section 6
  explains how to switch).
- Fonts still come from Google Fonts (open question 27). The CSP allows exactly that origin.

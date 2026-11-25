# Deploy guide

> Phase 7 turns this into the full guide for one VPS (domain, TLS, backups, logs, monitoring).
> For now it covers building the Mathlib judge image away from your laptop, and the Mathlib gate.
> Nothing in this repo deploys anything by itself.

## Building the Mathlib (full) judge image off the laptop

The full runner image is about 7-8 GB (toolchain plus Mathlib's prebuilt cache). Build it where it
will run. Do not build it on a development laptop.

### Option A: build directly on the VPS

```bash
ssh you@vps
git clone <repo> hatchery && cd hatchery
git checkout <commit that is green in CI>
docker compose build lean-runner          # JUDGE_FLAVOR defaults to full
docker compose run --rm lean-runner       # prints: Lean (version 4.36.0 ...), flavor=full, trusted_sha=...
```

The VPS needs about 20 GB free disk for the build (layers plus Mathlib download), and 8 GB+ RAM for
the judge's default `JUDGE_MEMORY_MB=8192`.

### Option B: drive the VPS's Docker from your laptop (remote context)

The build context (this repo, a few MB) is uploaded. The build itself and the 8 GB image stay on the VPS.

```bash
docker context create hatchery-vps --docker "host=ssh://you@vps"
docker --context hatchery-vps compose build lean-runner
docker --context hatchery-vps compose up -d judge desk
docker context use default      # back to local
```

Your laptop's Docker disk usage does not change. `docker --context hatchery-vps images` lists the images on the VPS.

### Option C: use what CI built

`.github/workflows/judge.yml` builds the full image on every push and records its image id as the
`runner-full-digest` artifact. The workflow does not push images anywhere. If you later want to
pull a CI-built image instead of building on the VPS, add a push step to a registry you control
and pin the image by digest in the VPS's `.env` (`JUDGE_IMAGE=registry/...@sha256:...`).

## The Mathlib gate

Real agents must not work on Mathlib lemmas until the `full` job of the `judge` workflow is green.
Two independent switches enforce this in the desk:

1. `MATHLIB_LEMMAS_ENABLED=1` must be set (default `0`). Set it only after checking that the
   workflow run for the commit you are deploying is green, including the job named
   **"full image (pinned Mathlib)"**.
2. The judge must report `flavor=full` on `/health`. With the lite image, Mathlib lemmas are never
   leased, and any submission for one is refused, whatever the flag says.

A statement counts as a Mathlib lemma when its file in `lean/Statements/` contains `import Mathlib…`.

The desk also refuses all leases and checks when the judge image is **stale**: the hash of
`lean-toolchain`, `Defs/` and `Statements/` baked into the image must equal the hash of the
desk's checkout. `GET /health` on the desk shows `judge.fresh`. After changing statements or
definitions, rebuild the runner image and restart the judge.

## Where bot commits go

When the judge accepts a proof, the desk writes `lean/Proofs/<L>.lean` and commits **only that file**
as "Hatchery Judge". Where that commit lands:

| Setting | Where | Used for |
|---------|-------|----------|
| `PROOF_COMMIT_MODE=sandbox` (**default**) | a throwaway clone (`PROOF_SANDBOX_DIR`, default a new temp dir; never inside the checkout) | tests, mock runs, dev runs |
| `PROOF_COMMIT_MODE=commit` + `HATCHERY_REAL_RUN=1` (+ `REPO_MOUNT_MODE=rw` in Docker) | the real checkout | a real run you start on purpose, and the server |
| `PROOF_COMMIT_MODE=off` | nowhere (database only) | |

The desk refuses to start in `commit`/`write` mode without `HATCHERY_REAL_RUN=1`. In Docker the
checkout is mounted read-only unless `REPO_MOUNT_MODE=rw`. The test suite fails if a run changes
the real checkout at all (HEAD, files, contents, directories).

A proof is committed only once its **approved statement file** is in that checkout with the same
content, because CI re-checks every proof against it. Approved statements reach the repo through a
maintainer, never the bot: `pnpm desk export-statements --to <lean dir>`, review the diff, commit,
push. The desk commits the waiting proofs at its next start (or the next accepted proof).

To run the desk as the checkout's owner (so its commits are yours on disk), set `HATCHERY_UID` /
`HATCHERY_GID` (`id -u`, `id -g`) in `.env`.

## Pushing proofs (who pushes)

**Locally: never push.** `PROOF_PUSH` defaults to 0 and is refused unless `PROOF_COMMIT_MODE=commit`
and `HATCHERY_REAL_RUN=1`. Do not set it on a laptop.

**On the server**, a dedicated bot GitHub account pushes:
1. Create a GitHub account for the bot (e.g. `hatchery-proof-bot`), and give it write access to
   this repository only.
2. Create an SSH key pair on the server (`ssh-keygen -t ed25519 -f /srv/hatchery/secrets/proof_bot_deploy_key -N ""`)
   and add the public key as a **deploy key with write access** on this repository
   (Settings → Deploy keys). A deploy key works for one repository only.
3. Mount the private key read-only into the desk container and point git at it:
   `GIT_SSH_COMMAND="ssh -i /run/secrets/proof_bot_deploy_key -o IdentitiesOnly=yes"`, plus
   `PROOF_COMMIT_MODE=commit`, `HATCHERY_REAL_RUN=1`, `REPO_MOUNT_MODE=rw`, `PROOF_PUSH=1`,
   `PROOF_PUSH_REMOTE=origin` (an `git@github.com:…` remote), `PROOF_PUSH_BRANCH=main`.
4. In the repository settings, set the Actions variable `PROOF_BOT_LOGIN` to the bot's GitHub login.

**The bot touches only `lean/Proofs/`**, enforced three ways:
- the desk commits a single path, `lean/Proofs/<L>.lean`, with `git commit --only`;
- the `bot-scope` job in `.github/workflows/judge.yml` fails any push by `PROOF_BOT_LOGIN` that
  changes a file outside `lean/Proofs/` (or creates a branch);
- optional: if your GitHub plan offers push rulesets with file-path restrictions, restrict the bot's
  pushes to `lean/Proofs/**` there too.

**CI re-checks every pushed proof.** The lite and full jobs run `pnpm --filter @hatchery/judge cli check-repo`,
which re-judges every file in `lean/Proofs/` against its statement in `lean/Statements/`, with
imported checked proofs resolved from the repo. Proofs that need Mathlib are checked by the full job.
A failure makes the workflow red. A proof the desk thought was fine but CI rejects is a bug to investigate.

## Checked proofs and commits

Every checked proof records the exact source, its sha256, the commit that added it to
`lean/Proofs/` (with `PROOF_COMMIT_MODE=commit`; otherwise the checkout's commit, `GIT_COMMIT` or
`git rev-parse HEAD` with `+dirty`), and a fingerprint of everything it depends on.

When a statement, a definition, the toolchain/Mathlib pin, or an imported checked proof changes,
the desk marks the lemma and everything that imports it as `recheck` (on start and every
`RECHECK_INTERVAL_SECONDS`). It then re-judges them, dependencies first. A failed re-check returns
the lemma to `open`, and the old proof is kept in the `recheck_failed` event.

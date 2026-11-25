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

## Checked proofs and commits

Every checked proof records the exact source, its sha256, the commit of the desk's checkout
(`GIT_COMMIT`, or `git rev-parse HEAD` with `+dirty` when `lean/` has uncommitted changes), and a
fingerprint of everything it depends on. In Docker there is no `.git`, so pass it explicitly:

```bash
GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d desk
```

When a statement, a definition, the toolchain/Mathlib pin, or an imported checked proof changes,
the desk marks the lemma and everything that imports it as `recheck` (on start and every
`RECHECK_INTERVAL_SECONDS`). It then re-judges them, dependencies first. A failed re-check returns
the lemma to `open`, and the old proof is kept in the `recheck_failed` event.

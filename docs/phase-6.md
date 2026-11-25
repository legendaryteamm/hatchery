# Phase 6: outside contributors

Built without a GitHub repository or OAuth app. Locally, a **dev login** stands in for GitHub
sign-in: it works only when the site runs on localhost. A **stand-in GitHub API** in the tests plays
the pull-request side. The exact steps to create the real OAuth app, bot account and repository
settings are in HANDOFF.md.

## What was built

**Sign-in and tokens** (`apps/desk/src/contrib.ts`):
- **GitHub OAuth.** It asks for no scopes, so only the public login and id are read. A state cookie
  (HttpOnly, SameSite=Lax, 10 min) is checked on the callback. The GitHub access token is used once
  and never stored. A login renamed to someone else on GitHub is never merged with the old account.
- **Dev login** (`DEV_LOGIN=1`): any GitHub-style name, for local testing. The desk refuses to start
  with it unless `PUBLIC_SITE_URL` is `http://localhost` or `http://127.0.0.1`. It cannot take a name
  that already belongs to a real GitHub account in the database.
- **Sessions** are HttpOnly cookies (`Secure` on https). Every cookie-authenticated write must carry
  the `x-hatchery: 1` header, which a cross-site form cannot send.
- **API tokens** for a contributor's own agent:
  - created in the browser only;
  - shown once and stored as a hash;
  - at most 5 active;
  - can be revoked;
  - used as `Authorization: Bearer hx_…`.

**Lease API** (`POST /api/lease`, `/api/heartbeat`, `/api/release`):
- One lemma per GitHub handle. A lease ends 6 hours after it starts, or 60 minutes after the last
  heartbeat (heartbeat every 45 min, plus 15 min grace).
- At most `MAX_EXTERNAL_LEASES` outside leases at once (default 20), so outsiders cannot block the colony.
- Outsiders spend nothing from the pantry, so an empty pantry does not stop them. The kill switch does.
- Only statements whose file is in the repository with the approved text can be leased, because a
  proof is checked against the repository.
- Outsiders' release notes are **not stored**. No text from outside ever reaches the agents'
  prompts (prompt-injection hygiene).
- An outside agent is a pet with a striped shell (`kind: external`, id `gh-<login>`). Its moves come
  from its real events, like any other pet's.

**Pull requests** (`.github/workflows/contrib-check.yml`, `contrib-merge.yml`, `apps/judge/src/contrib.ts`):
- **`contrib-check`** runs for untrusted PRs, also from forks. It has no secrets and a read-only
  token.
  - It checks out the **base** commit, so the PR's own code never runs.
  - It requires **exactly one new file** `lean/Proofs/L_*.lean` and nothing else.
  - It takes that one file from the PR as data and judges it with the **same runner image** as
    the colony: lite, or full when the statement needs Mathlib.
  - It uploads `result.json`.
- **`contrib-merge`** is trusted: it runs from the default branch after the check.
  - It treats the artifact as data and re-reads the head commit, the file list and the proof itself
    from GitHub. It refuses a mismatch: a tampered file, a moved head, extra files, or a wrong base
    branch.
  - It sends the proof to the desk (`POST /contrib/submissions`, `CONTRIB_TOKEN`), which judges it
    **again with its own judge**. The PR's author must hold the lease, or the lemma must be free (it
    is then leased to them).
  - It comments the result. Judge output, which contains PR text, can only appear inside a code
    block it cannot close.
  - The **proof bot** merges (squash, pinned to the checked commit) only if CI and the desk both
    passed and `CONTRIB_AUTO_MERGE=true`. The desk then pins the lemma to the merge commit.
- The desk does not commit PR proofs itself: the merge brings the file. On the server, the desk now
  fetches and rebases its own proof commits onto the remote before pushing, so merged PRs never
  block its pushes.

**Admin by GitHub allowlist** (`ADMIN_GITHUB_HANDLES`):
- The `/admin` page has the kill switch, recording top-ups and outflows for the ledger, outside
  leases, contributors (with **block**: their sessions and tokens end and their lease is released),
  and the pull-request log.
- Everything is recorded as `github:<login>`. `ADMIN_TOKEN` still works for the CLI and scripts.

**`/join.txt`:** plain-text instructions for another person's coding agent, served by the desk at
the site root. It uses the real URLs and limits from the configuration, has the honesty line, and
promises no payment or token reward.

**Site:**
- **Join page:** sign-in (the dev login appears only when the server allows it), the current
  lease, and API tokens (shown once).
- **Admin page:** described above.
- **Text inputs:** styled to match the site.

## How to run

```bash
pnpm test
# try the contributor flow locally (throwaway database, dev login on):
docker compose up -d --wait postgres
pnpm mock:colony                # desk on :4200
pnpm web:dev                    # http://localhost:5173/join: "Sign in for testing", create a token
curl -X POST http://localhost:5173/api/lease -H "Authorization: Bearer hx_..." -H 'content-type: application/json' -d '{}'
# (204 = all lemmas are taken by the mock agents right now; try again in a few seconds)
# the test name "admin" can open http://localhost:5173/admin
curl http://localhost:5173/join.txt
```

## Acceptance (section 12)

"A test GitHub account can lease, submit a PR and get it checked and merged." No GitHub account or
repository exists yet, so this was shown locally, with each GitHub part replaced by a stand-in:

| Step | Evidence | Result |
|------|----------|--------|
| Sign in, get a token, lease | Browser (headless Chromium, phone size, mock colony): dev login; token shown once; the agent leased `L-core-001` with the token and sent a heartbeat; the Join page shows the lease; a striped pet "Working on L-core-001" appeared in the roster. No horizontal overflow at phone width. | pass |
| PR judged with the same runner image | `contrib check` (the command the workflow runs) on the real **lite** runner: a correct proof passes, `sorry` fails. | pass |
| Checked and merged | `contrib-flow.test.ts`: lease with a token, then a PR on a stand-in GitHub API, the CI result, the trusted `contrib report`, the desk judging it again, the bot merging the exact checked commit, and the lemma recorded as checked by `gh-alice`, pinned to the merge commit. The pet's events: leased, submitted, checked, proof_committed. | pass (stand-in GitHub) |
| Nothing untrusted is believed | A tampered artifact, a moved PR head, a PR that also changes the judge, and a CI "pass" that the desk's judge rejects are each refused or left unmerged. | pass |
| Admin allowlist | Browser: a non-admin sees "not on the admin list"; the allowlisted login paused and resumed the colony, recorded in the feed as `github:admin`. | pass |

The real-GitHub run (a test account opens a real PR) is a HANDOFF.md item.

## Known gaps

- **Not run on real GitHub yet.** The workflow YAML was checked with a YAML parser only;
  `actionlint` was not run.
- A statement that needs Mathlib makes the PR check build the full image (about 90 minutes on a
  GitHub runner).
- GitHub account age or reputation is not checked. The slot limit, one lease per handle, rate
  limits and the block button are the defences for now (open question 35).
- When an internal agent and a pull request finish the same lemma at nearly the same moment, the
  second one is refused ("already checked"). If both commits reach the remote, the desk's push
  needs a maintainer to rebase.

# Phase 3: programs and review

All of Phase 3 was built and tested with the mock model provider (no API calls, no cost). The Lean
parts used the real judge (lite image). Nothing here was compiled with Mathlib: that happens in CI.

## What was built

### Definitions: DRAFT until a math advisor approves them
`lean/Defs/`, one module per concept:

| Module | Contents | Compiled here? |
|--------|----------|----------------|
| `Defs.Core.Formula` | Boolean formulas: evaluation, size, depth | yes (lite image) |
| `Defs.Core.Circuit` | Boolean circuits (unbounded fan-in AND/OR, NOT), size, depth, well-formedness, `InAC0`, monotone circuits, `parity` | yes |
| `Defs.Core.Resolution` | literals, clauses, CNF, satisfiability, resolution derivations and refutations, the pigeonhole CNF `php m n` | yes |
| `Defs.Mathlib.Complexity` | decision problems, polynomial-time computability via Mathlib's `Turing.TM2ComputableInPolyTime`, the classes `P` and `NP` (verifier definition) | **no**: needs Mathlib, built only by the full image (CI or the VPS). API names were taken from Mathlib v4.36.0's source, but the file has not been compiled. |

Each module starts with a `title:` and a plain-language `summary:` for the advisor. The core
definitions were sanity-checked with `decide` on small cases (parity, circuit evaluation and depth,
formulas, the PHP clause count).

**Rules:**
- A definition is a DRAFT unless an advisor approved **its exact current source**, and every
  definition it imports is approved too. Editing the file makes it a draft again.
- A statement that uses a draft definition cannot be approved. If a definition becomes a draft
  again, every approved statement that uses it goes back to "proposed", and its lemma is not leased.
- Only an **advisor** can approve a definition. Statements can be approved by an advisor or a maintainer.
- Every decision is bound to the hash of the text the reviewer saw; a stale page is refused.
- The public API (`GET /definitions`, `/statements`) and the web pages show drafts as drafts.

### Programs (section 7)
`circuit-lower-bounds` (ids `L-circ-…`), `monotone-circuits` (`L-mono-…`), `proof-complexity`
(`L-pc-…`), `barriers` (`L-bar-…`), plus `core-warmup` for calibration.

### Statements and the review queue
- Repo statements that import no definition (the core warm-up) are approved by the commit itself.
  Anything that imports a definition enters the queue as **proposed**.
- **Automatic check** (judge `POST /statement-check`, two sandboxed Lean runs):
  1. well-formed: allowed imports only, no banned words, exactly one `def Statement.<L> : Prop`;
  2. elaborates in Lean with `sorry` as the proof;
  3. not trivial: auto-rejected if `trivial`, `decide`, `simp`, `omega` (or `aesop` in the full image)
     closes it within 10 s;
  4. not a duplicate of an existing statement (normalized text).
- Statements are no longer baked into the judge image. The desk sends the approved statement source
  (and those of imported proofs) with each judge request, so a newly approved statement is leasable
  without rebuilding the image. The image's trusted hash now covers the toolchain pin and `Defs/`.

### Decomposer
`pnpm decomposer:start` (Docker: the `decomposer` service, profile `agents`). It reads the programs,
definitions (with their review state), existing statements and open split requests, and proposes
statements with a `propose_statement` tool. The desk assigns the id, writes the statement file, runs
the automatic check, and either queues the proposal or auto-rejects it with a reason. Proposals are
rate-limited (`MAX_PROPOSALS_PER_HOUR`), go through the budget gate before every model call, and are
recorded as spend with purpose `decompose`.

**Split requests (section 6b):** proving agents have a `request_split` tool. The decomposer answers
open requests first, with smaller statements linked by `parent_id`. They still need human approval.

### The review tool (`apps/web`, for a non-developer advisor)
`pnpm web:dev`, then open the invite link.
- **Sign-in:** the maintainer runs `pnpm desk reviewer add "Dr. Name" advisor` and sends the printed
  one-time link. Opening it signs the advisor in for 30 days, with no account or password. Used or
  expired links are refused with a plain message. Links can be reissued and reviewers disabled.
- **Queue:** definitions (drafts marked) with their plain-language summaries, and proposed statements,
  marked "ready" or "blocked" with the reasons.
- **Definition page:**
  - a draft banner explaining what "draft" means;
  - the summary, then each Lean declaration with its doc comment;
  - the whole file on request;
  - what it builds on, and which statements use it;
  - the review history.
- **Statement page:**
  - the proposition and the decomposer's rationale;
  - the definitions it uses, with their status;
  - the automatic checks as ✓/✗;
  - the decision form.
- **Decisions:** Approve / Request changes / Reject / Comment, each with its consequence spelled out.
  Approve is disabled, with the reason shown, when the rules forbid it, e.g. "only a math advisor can
  approve a definition", or a draft definition still blocks the statement. Changes and rejections
  need a comment. A stale page shows "reload".
- **Security:** a session cookie (httpOnly, SameSite=Strict, Secure on https). Every write needs an
  `x-hatchery-review` header that a cross-site form can't send. Only the invite token's hash is
  stored, and the token is removed from the address bar immediately.
- **Public pages:** `/definitions` and `/definitions/:id` show every definition with Draft / Reviewed.

### Safety of bot commits (maintainer question, Phase 3)
- The default is a **sandbox clone**. Writing to the real checkout needs
  `PROOF_COMMIT_MODE=commit|write` **and** `HATCHERY_REAL_RUN=1` (and `REPO_MOUNT_MODE=rw` in Docker).
- Pushing (`PROOF_PUSH=1`) is server-only, touches only `lean/Proofs/`, and CI re-checks every pushed
  proof (`check-repo`) and fails any bot push outside `lean/Proofs/` (`bot-scope` job).
  See [deploy.md](deploy.md).
- Tests cannot construct a committer that writes into this repository. Every desk and worker test run
  snapshots the whole checkout (HEAD, status, contents of changed and untracked files, directories)
  and fails if anything changed.

## How to run

```bash
npx -y pnpm@9.15.9 install
npx -y pnpm@9.15.9 runner:build:lite
npx -y pnpm@9.15.9 test

# review tool against a local stack (no model calls):
echo "DESK_WORKER_TOKEN=$(openssl rand -hex 24)" >> .env
JUDGE_FLAVOR=lite docker compose up -d desk
docker compose exec desk node --import tsx src/cli.ts reviewer add "Your Name" advisor   # prints the invite link
npx -y pnpm@9.15.9 web:dev      # http://localhost:5173 , then open the invite link
```

## Acceptance (section 12)

> "Done when proposed statements appear in the review queue and only approved ones get leased."

| Check | Test | Result |
|-------|------|--------|
| Proposed statements appear in the queue | decomposer proposals (mock model) and repo statements that use definitions are listed in `/review/queue`; trivial, broken and duplicate ones are auto-rejected with a reason (desk tests, plus real Lean in `apps/worker/test/e2e.test.ts`) | pass |
| Only approved ones get leased | before approval nothing is leasable (no lemma row exists); with an approved statement whose definition is still a draft, nothing is leasable; after the advisor approves the definition and the statement, it is leased (desk tests and the mock end-to-end fleet test) | pass |
| Drafts | definitions start as drafts; statements over drafts cannot be approved; edits make them drafts again and send statements back to review; transitive drafts | pass |
| Review tool | invite, cookie and CSRF over HTTP (desk tests); 7 component tests of the pages (decision rules, stale page, plain errors, drafts on public pages); production build | pass |

## Known gaps

- `Defs.Mathlib.Complexity` (P, NP) has never been compiled. It is checked by the CI full job.
  Until that is green (and an advisor approves it), nothing can use it.
- Definitions for the monotone-circuits program (sunflowers, CLIQUE) and the barriers program
  (oracle machines, natural proofs) are not written yet. Those programs exist but have nothing to
  build on.
- The review tool has not been clicked through in a real browser here: it is covered by component
  tests, API tests and a served-build smoke test. It is plain and functional; the colony look comes
  in Phase 4.
- Approved decomposer statements reach `lean/Statements/` only through a maintainer
  (`desk export-statements`). Their proofs are committed after that.
- Reviewer sign-in is invite links; Phase 6 adds GitHub OAuth for maintainers.

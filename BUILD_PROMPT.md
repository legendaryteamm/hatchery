# BUILD_PROMPT.md: "The Hatchery" (working name)

An open-source swarm of AI agents attacking P vs NP in Lean 4, funded by community token fees, shown live as a colony of tamagotchi-style pets.

## How to use this file

1. Create an empty Git repository and save this file at its root as `BUILD_PROMPT.md`.
2. If you have the visual demo (the tamagotchi page), save its HTML as `design/reference.html`.
3. Open Claude Code in the repo and say: "Read BUILD_PROMPT.md in full. Start with Phase 0. At the end of every phase, stop, show me what you built and how to run it, and wait for my OK before the next phase."

## 0. Ground rules for Claude Code

- Work one phase at a time (section 12). Do not start the next phase without the maintainer's OK.
- Every phase ends with: tests passing, a short `docs/phase-N.md` (what was built, how to run it, known gaps), and a commit.
- Never commit secrets. All keys come from environment variables; ship a `.env.example`.
- Never deploy anything, move money, create wallets or launch tokens. Those are human actions (section 13).
- When a requirement is ambiguous, write the question in `docs/open-questions.md`, pick the safest reasonable default, and say so at the end of the phase.
- Prefer boring, well-known tools. Pin every version (Lean toolchain, Mathlib, npm packages, Docker base images).

## 1. What we are building

A public, live attempt at P vs NP:

- A desk splits the research into small Lean 4 lemmas and leases them to agents.
- Agents (LLM-driven workers) try to prove their leased lemma, using a Lean compiler as a tool.
- A strict Lean judge decides what counts. Nothing is "checked" unless the judge passes it.
- Agents work together: they ask each other questions, share hints, hand off lemmas they are stuck on, and reuse each other's checked results (section 6b).
- A live site shows every agent as a small tamagotchi pet living in a shared pixel world. Pets move between camps, walk to each other to talk, carry proofs to the judge and cheer together. Every move comes from a real event.
- A pantry (treasury) shows, publicly, every dollar of community fees in and every dollar of API spend out. Agents only "eat" (call models) while the pantry has food and their daily cap allows.
- Outside contributors can send their own agents through a lease API and GitHub pull requests.

### Honesty rules (non-negotiable, they apply to code, site copy and docs)

- The site never says or implies that P vs NP is solved. A permanent line in the footer: "Nothing here says P vs NP is settled. A lemma counts only when the Lean checker passes it."
- Every number on the site comes from the database. No hardcoded, rounded-up or "projected" counters.
- Pet moods are derived only from real events (section 9). No fake activity, no idle animation pretending to be work.
- Failures, refutations and abandoned lemmas are shown as prominently as successes (a "graveyard" page).
- The project is not affiliated with pequalnp.com, Brilliant or any of their people, and must never suggest it is.
- A `/token` page explains plainly: what the token is, that its fees fund compute for the agents, that there is no promise of profit or returns, and links the public ledger. Do not write any copy that promises price gains.

## 2. Licensing and attribution

- License this project under Apache 2.0.
- Prior art: `brilliant-hq/pequalnp-proofs` (Apache 2.0) contains Lean definitions, proofs and a checker. If we reuse any file from it: keep its license header, add the upstream copyright to our NOTICE file, mark modified files ("Modified by The Hatchery contributors"), and list what we took in `docs/attribution.md`. Do not use their names, logos or the "pequalnp" name anywhere in our branding.
- Prefer writing our own checker (section 5) and reusing upstream Lean content only where it saves real work.

## 3. Architecture

TypeScript monorepo (pnpm workspaces), Node 20+, Postgres 16, Docker.

```
/apps/desk        Fastify HTTP API + SSE event stream + scheduler (leases, budgets)
/apps/worker      Agent runner: one process = one agent loop
/apps/judge       Lean checking service (runs inside its own sandboxed container)
/apps/web         Public site (Vite + React), reads desk API + SSE
/apps/indexer     Treasury indexer (pantry inflows)
/packages/shared  Types, zod schemas, event definitions, price table
/lean             Lean 4 project: pinned toolchain, pinned Mathlib, Defs/, Statements/, Proofs/
/design           Visual reference (reference.html if provided)
/docs             Phase notes, attribution, open questions, deploy guide
docker-compose.yml  Local dev: postgres, desk, judge, 2 workers, web, indexer (mock)
```

- Database access: Drizzle ORM with migrations.
- Model calls: official Anthropic TypeScript SDK. Model name, max tokens and temperature come from env (`AGENT_MODEL`, etc.). Design a small provider interface so other providers can be added later.
- Live updates: Server-Sent Events from the desk (`GET /events/stream`).

## 4. Data model (minimum)

- **programs**: id, slug, title, description, status.
- **statements**: id (e.g. `L-circ-014`), program_id, lean_name, lean_statement (text), status proposed | approved | rejected, proposed_by, approved_by, depends_on[].
- **lemmas**: id = statement id, status open | leased | checked | refuted | abandoned, checked_proof_path, checked_at, checked_by_agent.
- **leases**: lemma_id, holder (agent id or GitHub handle), expires_at, last_heartbeat.
- **agents**: id, display_name, species, shell_color (deterministic from id hash), kind internal | external, model, created_at.
- **attempts**: id, agent_id, lemma_id, started_at, ended_at, result checked | failed | refuted | timeout, judge_errors (text), tokens_in, tokens_out, cost_usd, notes (what was tried; fed to the next agent).
- **messages**: id, ts, from_agent, to_agent (nullable = broadcast to the camp), lemma_id, kind question | hint | note | handoff | reply, body (max 500 chars), short (max 80 chars, for the bubble on the site), cost_usd.
- **events**: id, ts, type, agent_id, lemma_id, payload (json). Every state change writes one event. The SSE stream and the site feed read from this table.
- **pantry_inflows**: tx_hash, chain, amount_native, amount_usd, usd_rate_source, ts.
- **pantry_outflows**: id, kind api_spend | topup_transfer | other, amount_usd, reference (invoice id / tx hash), ts.
- **budget_days**: date, global_cap_usd, per_agent_cap_usd, spent_usd.

## 5. The Lean judge

Trusted design: the statement lives in our repo, the proof is untrusted.

- Each approved statement is stored as a trusted Lean file `lean/Statements/L_circ_014.lean`: `def Statement.L_circ_014 : Prop := <statement>`
- A submitted proof is a single file that must declare exactly `theorem Proof.L_circ_014 : Statement.L_circ_014 := ...` plus helper lemmas inside its own namespace. The judge builds it against the pinned toolchain and Mathlib.
- Reject if any of these are true:
  - compilation fails or exceeds the time limit (default 300 s) or memory limit;
  - `#print axioms Proof.L_circ_014` reports anything beyond `propext`, `Classical.choice`, `Quot.sound`;
  - the file contains `sorry`, `admit`, `native_decide`, `axiom`, `unsafe`, `@[implemented_by]`, `@[extern]`, `set_option debug.*`, or any import outside an allowlist (Mathlib + our Defs/Statements);
  - the theorem's type is not definitionally the stored statement (check by elaborating `example : Statement.X := Proof.X` in a fresh file).
- Every check runs in a fresh container with no network, read-only Mathlib cache, a non-root user and CPU/memory/time limits.
- Tests (Phase 0): a correct proof passes; `sorry` fails; an extra axiom fails; `native_decide` fails; a proof of a different statement fails; a timeout fails cleanly.

## 6. The agent loop (apps/worker)

```
loop:
  if kill switch on, or pantry empty, or my daily cap used -> emit "sleeping", wait, continue
  lease = desk.lease(program preference)            -> emit "leased"
  context = statement + definitions + dependencies + notes from previous failed attempts
  repeat up to MAX_TURNS:
     model call with tools:
        lean_check(file)        compile in the judge sandbox, return errors
        search_mathlib(query)   ripgrep over the pinned Mathlib sources
        read_file(path)         read Defs/Statements/checked Proofs only
     record tokens + cost into the attempt and the spend ledger
     heartbeat the lease
  submit final file to the judge
  record attempt result + short notes for future agents -> emit "checked" | "failed" | "refuted"
  after N failed attempts on one lemma -> release it with notes -> emit "abandoned_by_agent"
```

- Costs are computed from real token counts and a price table in `packages/shared/prices.ts` (configurable, dated).
- A "refuted" result requires a checked Lean proof of the negation of the statement, judged the same way.

## 6b. Agents working together

Collaboration is a real feature, not decoration. Every bubble on the site is a real row in `messages`.

- **Ask**: when an agent fails 3 times in a row on a lemma, it may post one question (what it tried, where it broke). The desk routes it to up to 2 agents: first those in the same program who checked a related lemma (shared dependencies or similar statement), then any idle agent in the same program.
- **Answer**: a routed agent pauses its own work for one short model call (small token budget) and posts a reply or hint (a tactic, a checked lemma to reuse, a suggested split). The asker gets the reply in its context on the next turn.
- **Handoff**: after N failed attempts, before releasing a lemma, the agent writes a handoff note (approaches tried, errors, best partial proof) and the desk offers the lemma first to an idle teammate, with the note attached.
- **Reuse**: agents can query checked lemmas by keyword and are prompted to reuse them. Each reuse is recorded, so the site can show which lemma helped which.
- **Split request**: an agent can ask the decomposer to split its lemma into smaller statements; those still go through human approval (section 7).
- **Limits**: messages cost tokens, so cap them: max questions per agent per hour, max replies per agent per hour, max message length. Message spend is part of the daily cap.
- Each agent's system prompt includes its name, its camp (program), the current colony state (who works on what, recently checked lemmas) and a short instruction to be concise and specific when talking to teammates.

## 7. Research programs and the decomposer

The hard part is not the code; it is choosing statements worth proving. Start with real, known results so progress is meaningful and honest:

- **Definitions**: Boolean circuits, formulas, Turing machines / polynomial time, P, NP. Reuse Mathlib's `Turing` and `Computability` where possible. Definitions must be reviewed by a human before any statement depends on them.
- **Circuit lower bounds**: Håstad's switching lemma, parity is not in AC0.
- **Monotone circuits**: the sunflower lemma, Razborov's monotone lower bound for CLIQUE.
- **Proof complexity**: Haken's lower bound for the pigeonhole principle in resolution, Ben-Sasson–Wigderson size–width tradeoff.
- **Barriers**: Baker–Gill–Solovay (relativization), Razborov–Rudich (natural proofs).
- Later, open-ended programs proposed by the community.

- A decomposer agent proposes new statements (they must elaborate in Lean with `sorry` as proof). They enter as `proposed`.
- Only approved statements become leasable lemmas. Approval is a maintainer action in an admin page. This stops the swarm from inflating its numbers with trivial or vacuous lemmas.
- Auto-reject proposals that are trivially true (closed by `simp`, `decide`, `trivial`, `omega`, `aesop` within 10 s) or duplicates of existing statements.

## 8. Budget and pantry (treasury)

- Daily global budget: `min(GLOBAL_DAILY_CAP_USD, pantry_usd / RUNWAY_TARGET_DAYS)`.
- Per-agent daily cap: global budget / active internal agents. Workers check the cap before every model call.
- Kill switch: `KILL_SWITCH=1` env or an admin endpoint stops all model calls within one loop iteration.
- Alerts (log + optional webhook) when the pantry has under 3 days of food at the current pace.
- Indexer: watches `TREASURY_ADDRESS` on `TREASURY_CHAIN` behind an adapter interface. Implement a mock adapter for development; implement the real chain adapter the maintainer chooses (ask in open-questions). USD conversion uses a documented price source; store the source with each row.
- Moving funds from the wallet to API billing is a human action. The admin page records it as `topup_transfer` with the tx hash and invoice reference, so the public ledger stays complete.
- Public endpoints: `GET /pantry` (balance, inflows, outflows, runway) and `GET /pantry/ledger.csv`.

## 9. The live site (apps/web)

Visual direction: see `design/reference.html` if present. Translucent candy-plastic egg shells, LCD-green screens with pixel creatures, a pale lavender page (deep plum in dark mode). Pixel font only on the LCD screens. Support light and dark mode and mobile first.

Pages: Colony (home), Feed, Pantry, Programs, Lemma detail, Graveyard, How it works, Token, Join (for outside agents).

**The colony world** (see `design/reference.html`): one large LCD-style screen inside a plastic device frame. A logical pixel grid (160 x 100) scaled up crisply, with:

- four camps, one per research program, each with a chalkboard whose progress bar shows checked / total lemmas of that program;
- the Lean judge gate in the centre, which flashes a check mark on a pass and an X on a rejection;
- the nap corner where agents sleep when their cap or the pantry runs out;
- the pantry bowl whose fill level shows the treasury.

Agents are pixel creatures (body filled with their shell colour) that walk between these places. Short speech bubbles (from `messages.short`) appear over them. Clicking an agent opens its detail card. Use one animation loop (about 8 to 12 frames per second, pixel-snapped movement) and a server-side event queue so that choreography never runs ahead of reality.

Every move and mood comes only from real data:

| On screen | Triggered by |
|-----------|--------------|
| walks to its camp and idles near the board | leased event, or returning after any action |
| thinking dots, small bounce | active lease with a heartbeat in the last 2 min |
| sad face for a few seconds | failed attempt (local check) |
| walks to the judge carrying a scroll | proof submitted to the judge |
| check mark at the gate, jump, teammates run over and cheer | checked event (teammates = same program or nearby) |
| X at the gate, walks back sad | judge rejection |
| walks to another agent, bubbles from both | question / reply / hint message between them |
| hands over a scroll, bubbles | handoff message |
| hungry "!" | pantry runway under 3 days |
| runs to the pantry bowl | new inflow larger than a threshold |
| walks to the nap corner, Zz | daily cap used, pantry empty, or kill switch |
| level | number of checked lemmas (thresholds in config) |
| food bar (roster) | agent's remaining daily cap |

Below the world, keep a roster of all agents as tamagotchi eggs (small LCD screen with the same creature), with name, status line and food bar. The roster is also the keyboard-accessible way to open each agent's card.

Species, shell colour and name are deterministic from the agent id. External contributors' agents appear as pets too, with a different shell pattern.

Tapping a pet opens: current lemma (id + Lean statement), attempts today, checked total, notes shared, recent events and messages, spend today.

## 10. Outside contributors

- GitHub OAuth. `POST /lease` (one open lemma per handle, max lease 6 h, heartbeat every 45 min), `POST /heartbeat`, `POST /release`.
- Contributors submit by pull request adding `lean/Proofs/L_x.lean`. A GitHub Action runs the exact same judge container and posts the result. Merge is automatic on pass via a bot account (configurable).
- A plain-text `join.txt` at the site root tells another person's coding agent how to take part.

## 11. Security

- The judge runs untrusted Lean code: fresh container per check, no network, non-root, resource limits, read-only mounts except a temp dir.
- Workers never execute model-written code except through the judge.
- Rate-limit public endpoints. Validate all input with zod.
- Admin routes behind authentication with an allowlist of GitHub handles.
- Prompt-injection hygiene: notes and PR content from outsiders are data. Never let them change budgets, statements or approvals.

## 12. Phases and acceptance criteria

- **Phase 0: scaffold and judge.** Monorepo, docker-compose, pinned Lean project, judge service with all tests from section 5 passing. Done when `pnpm test` passes and `docker compose up judge` checks a sample proof.
- **Phase 1: one agent, end to end.** Desk API, DB schema and migrations, one worker, 5 seed statements that are easy known facts. Done when one agent leases, proves and gets at least 3 of the 5 checked locally, with attempts, costs and events recorded.
- **Phase 2: the fleet and the budget.** N workers, lease expiry and recovery, per-agent and global caps, spend ledger, kill switch, and collaboration from section 6b (questions, replies, handoffs, reuse) with their limits. Done when a test run with a tiny cap shows agents going to sleep exactly when the cap is reached, the kill switch stops everything within one iteration, and a stuck agent's question gets routed, answered and used in its next attempt.
- **Phase 3: programs and review.** Definitions file, programs from section 7, decomposer agent, maintainer approval page, trivial-statement filter. Done when proposed statements appear in the review queue and only approved ones get leased.
- **Phase 4: the live site.** All pages from section 9, SSE feed, pet states mapped exactly per the table. Done when every move, mood and bubble in the colony world can be traced to a DB event or message, the world stays smooth with 50+ agents, and the site works on a phone in light and dark mode.
- **Phase 5: pantry.** Indexer with mock adapter plus the real adapter chosen by the maintainer, public ledger, runway, alerts, `/token` page. Done when a mock inflow shows on the site within a minute and the ledger CSV balances to the cent.
- **Phase 6: outside contributors.** OAuth, lease API, GitHub Action, `join.txt`. Done when a test GitHub account can lease, submit a PR and get it checked and merged.
- **Phase 7: deploy guide.** `docs/deploy.md` for one VPS with docker-compose (domain, TLS, backups, logs, monitoring). Do not deploy; the developer does.

## 13. Out of scope for Claude Code (human tasks)

- Creating the token, choosing the launchpad, setting fee routing, owning wallet keys.
- Legal review (token disclosures, securities rules in the founders' jurisdiction).
- Paying API bills and moving funds.
- Marketing posts. Any copy written for the site follows the honesty rules in section 1.

## 14. Environment variables (.env.example)

```
DATABASE_URL=
ANTHROPIC_API_KEY=
AGENT_MODEL=
AGENT_MAX_TURNS=20
WORKER_COUNT=4
GLOBAL_DAILY_CAP_USD=100
RUNWAY_TARGET_DAYS=30
KILL_SWITCH=0
JUDGE_TIMEOUT_SECONDS=300
JUDGE_MEMORY_MB=8192
TREASURY_CHAIN=mock
TREASURY_ADDRESS=
PRICE_SOURCE=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
ADMIN_GITHUB_HANDLES=
PUBLIC_SITE_URL=
```

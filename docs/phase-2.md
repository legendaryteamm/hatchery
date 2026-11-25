# Phase 2: the fleet and the budget

Everything in this phase was built and tested with a **scripted mock model** (no API calls, no cost).
The real-model run is on the [HANDOFF.md](../HANDOFF.md) checklist.

## What was built

**Fleet.** `pnpm --filter @hatchery/worker fleet` (Docker: the `worker` service) starts `WORKER_COUNT`
processes, one agent loop each (`agent-1` … `agent-N`), and restarts a crashed agent with backoff.
Leases expire after `LEASE_TTL_SECONDS` without a heartbeat. The desk recovers the lemma, closes the
open attempt as `timeout`, and the agent that lost it moves on.

**Budget (section 8).** The desk owns every money rule (`apps/desk/src/budget.ts`):
- pantry = mock inflows − API spend (`model_calls`) − other outflows (topups are transfers, not spend);
- daily global budget = `min(GLOBAL_DAILY_CAP_USD, (pantry + spent today) / RUNWAY_TARGET_DAYS)`;
- per-agent cap = global budget / internal agents active in the last `ACTIVE_AGENT_WINDOW_SECONDS`.

Workers ask `GET /internal/budget` **before every model call** (proving and replying). When it is not
allowed, the agent pauses its attempt (`timeout`, "paused: <reason>", not counted as a failure),
releases its lemma, emits `sleeping` once with the reason (`agent_cap`, `global_cap`, `pantry_empty`,
`kill_switch`), and polls until it is allowed again. An agent overshoots its cap by at most the call
that crossed it.

**Kill switch.** `KILL_SWITCH=1` on the desk, `POST /admin/kill-switch {on, by}` (Bearer `ADMIN_TOKEN`),
or `pnpm desk kill-switch on|off`. It is stored in the `settings` table, so every desk instance and
worker sees it at its next check. `KILL_SWITCH=1` on a worker stops that worker.

**Spend ledger.** One `model_calls` row per model that served a call. A refusal fallback is priced
**by the model that actually served each part** (`usage.iterations`), and the row carries
`served_by_fallback` and `part`. A call that was in flight when its lease expired is still recorded.
Unpriced models are refused. The price table now also lists the models a fallback can route to.

**Collaboration (section 6b).** Every bubble is a `messages` row.
- *Ask*: after `ASK_AFTER_CONSECUTIVE_FAILURES` (3) failed checks/submissions in a row, an agent may
  `ask_teammates` once per lease. The desk routes the question to up to 2 live agents: first
  same-program agents who checked a related lemma (shared `depends_on`, imports, or statement overlap),
  then other agents in the same program, idle ones first. Agents over their reply limit or out of
  budget are skipped.
- *Answer*: a routed agent checks its inbox before each of its own calls, answers in one short call
  (`AGENT_REPLY_MAX_TOKENS`, effort low), and the reply's cost is stored on the message and in
  `model_calls` (`purpose = reply`).
- *Delivery*: answers are delivered to the asker in its next turn, or its next attempt. An agent with
  an unanswered question waits up to `WORKER_REPLY_WAIT_SECONDS` before starting another attempt.
  Delivery is recorded (`delivered_in_attempt`, `reply_delivered`).
- *Handoff*: after its max attempts, an agent releases the lemma with a handoff note (approaches,
  last errors, best partial proof) built from its own record (no extra model call). The desk offers the
  lemma first to an idle teammate for `HANDOFF_OFFER_SECONDS`.
- *Reuse*: `search_checked` finds checked lemmas. Every `import Proofs.L_x` in a checked proof is
  recorded in `reuses` and as a `lemma_reused` event.
- *Limits*: `MAX_QUESTIONS_PER_HOUR`, `MAX_REPLIES_PER_HOUR`, and message body ≤ 500 / short ≤ 80
  characters. Message spend counts toward the daily caps (it is in `model_calls`).
- The system prompt now carries the agent's name, its camp, and the colony state (who works on what,
  recently checked lemmas).

**Accepted proofs are committed (resolves open question 15).** On a pass, the desk writes
`lean/Proofs/<L>.lean` and commits **only that file** as "Hatchery Judge <judge@hatchery.invalid>". The
message records lemma, agent, attempt, source sha256, checkers and axioms. That commit becomes the
lemma's pinned `checked_commit`. A failed re-check removes the file in a commit. At startup the
desk reconciles `lean/Proofs/` with the database. It never pushes. `PROOF_COMMIT_MODE=commit|write|off`.

**Judge infrastructure errors** (verdicts whose only reason is `runner_error`) are not proof failures:
the desk returns 503, the worker retries the submission, and nothing lands in the agent's failed attempts.

## How to run

```bash
npx -y pnpm@9.15.9 install
npx -y pnpm@9.15.9 runner:build:lite
npx -y pnpm@9.15.9 test                       # everything, with the mock model
cd apps/worker && npx vitest run test/fleet.test.ts   # the Phase 2 acceptance tests alone
```
Real agents: [HANDOFF.md](../HANDOFF.md).

## Acceptance (section 12)

| Criterion | Test (`apps/worker/test/fleet.test.ts`, mock model) | Result |
|-----------|-----------------------------------------------------|--------|
| Agents go to sleep **exactly** when the cap is reached | 3 agents, cap = 3 calls each: every agent makes exactly 3 calls (spend == cap to the micro-dollar), then emits `sleeping/agent_cap`, and makes no calls after it | pass |
| Kill switch stops everything within one iteration | flipped via the admin endpoint while 3 agents work: each makes at most the 1 call already in flight, then sleeps with `kill_switch`; no further calls | pass |
| A stuck agent's question is routed, answered and used in its next attempt | asker fails 3 checks and asks; the question is routed to the idle teammate, who answers with a hint (cost recorded); the hint is delivered into the asker's **next** attempt, which proves the lemma | pass |
| Handoff, reuse, lease expiry and recovery, judge outage | handoff offered to the idle teammate, with the note; reuse recorded; hung agent's lease recovered on an injected clock; runner errors not counted as failures | pass |

Desk-level tests (`apps/desk/test/phase2.test.ts`) cover the budget math, admin auth, per-part pricing,
routing tiers and limits, bot commits in a temporary Git repo (only the proof file; other staged and
unstaged work is untouched), removal on a failed re-check, reconcile, and lock-wait timeouts.

## The intermittent hang: root cause and fix

**Symptom.** One full worker run took 255 s (with an extra attempt) and one fleet run took 208 s and
failed. Reruns passed.

**Trigger.** The macOS power log (`pmset -g log`) shows the Mac in `Idle Sleep` / `Maintenance Sleep`
with only 45-second `DarkWake` windows from 13:37 to 14:01. The failing run overlapped a 241 s sleep.
Wall-clock time (`Date.now()`, which the desk uses for leases and budgets) jumps over a suspend, while
Node's timers and the Docker VM freeze.

**Why that became a failure or stall instead of a slow pass (the real defects):**
1. The lease-expiry test used a **1-second lease for every agent** plus fixed `setTimeout` sleeps, so
   any pause over 1 s expired every agent's lease, not only the "hung" one's, and its assertions
   broke. *Fix:* the test now runs the desk on an **injected clock** and opens a gate instead of
   sleeping. It has no wall-clock dependence and takes 0.3 s.
2. **Nothing bounded a wait.** Desk ↔ Postgres had no lock/statement/idle-transaction timeouts, and
   worker → desk requests had no timeout, so a stuck request could wait until the 10-minute test
   timeout. *Fix:* `lock_timeout` 10 s, `statement_timeout` 30 s and `idle_in_transaction_session_timeout`
   60 s on every connection (tested: a lock wait fails in ~300 ms); `AbortSignal.timeout` on every
   worker request (60 s; 15 min for judge runs); a 60 s per-test limit in the fleet file.
3. **Judge infrastructure errors were charged to the agent** (most likely the 255 s run's extra
   attempt: a judge run interrupted by the frozen Docker VM; its database was already dropped, so this
   is not certain). *Fix:* `runner_error`-only verdicts become a 503 and are retried, never a failed attempt.
4. **Test databases leaked** when setup failed after creating them: 10 empty databases were left from
   Phase 1 development. *Fix:* cleanup on setup failure, plus a sweep of leftovers in global setup.
   Agents are now always stopped and awaited before their desk is torn down.
5. After a wake or a paused container, Postgres reports `unhealthy` until its next probe, and
   `docker compose up --wait` failed on it. *Fix:* global setup retries for up to 60 s.

**Proof.** The fleet file was run 20 times in a row (under `caffeinate -i`, so the Mac could not sleep
mid-measurement), twice: before the last fix 20 / 20 (6.0–6.9 s each), and on the final code 20 / 20 (5.9–7.3 s each), with 0 leftover test databases and 0 open connections after each series.
To test the failure mode itself, it was also run 5 times while **pausing Postgres for 5 s** at different
moments (setup and tests): 5 / 5 passed, 10.5–18.6 s.

## Known gaps

- Real-model run pending: HANDOFF.md.
- *Split request* (section 6b) needs the decomposer and human approval: Phase 3.
- Leases and the per-agent "active" window use wall-clock time. A host that sleeps longer than
  `LEASE_TTL_SECONDS` loses its leases on wake. That is the intended lease semantics, but expect it
  on a laptop.
- Admin auth is a bearer token until Phase 6 (GitHub OAuth allowlist). No rate limiting until Phase 4.
- Pantry outflows are computed from `model_calls`; Phase 5 materializes the public ledger rows.

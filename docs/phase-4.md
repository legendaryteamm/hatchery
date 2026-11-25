# Phase 4: the live site

Built and tested with the mock model provider only (no API calls, no cost). Browser checks used a
headless Chromium installed in a temporary folder, against the **mock colony** (`pnpm mock:colony`:
55 scripted agents, a throwaway database, bot commits off).

## What was built

**Pages** (`apps/web`, Vite + React, visual language from `design/reference.html`):

| Page | Contents |
|------|----------|
| Colony (`/`) | hero and LCD bar from live numbers, the colony world, the roster of eggs, the live feed, the pantry panel, how it works |
| Feed | every feed event, newest first, with paging |
| Programs | the four research programs plus the warm-up, with progress, lemmas and statements in review |
| Lemma detail | statement, definitions used (drafts marked), checked proof with commit, attempts with costs and judge errors, conversation, history |
| Pantry | balance, money in, API spend, runway, today's caps, kill switch, inflows (mock inflows labelled) |
| Graveyard | refuted and abandoned lemmas, rejected statements with reasons, failed re-checks, failed attempts |
| How it works, Token, Join | plain copy. Token: "has not launched", no promise of profit or price. Join: "not open yet" |
| Definitions, Review | from Phase 3, restyled |

Every page carries the footer line: "Nothing here says P vs NP is settled. A lemma counts only when
the Lean checker passes it." Light, dark and auto themes. Mobile first. Pixel font only on LCD screens.

**The colony world**: one 160 x 100 logical-pixel canvas, scaled crisply, one loop at 10 frames per
second, pixel-snapped. It has:
- four research camps with chalkboards (progress = checked / total from the data);
- the warm-up bench under the judge (the core lemmas are not a research program);
- the Lean judge gate in the centre, the nap corner, and the pantry bowl (fill = runway / 30 days).

**The choreographer** (`apps/web/src/colony/choreographer.ts`) is the only source of pet behaviour:

| On screen | Triggered by (implemented) |
|-----------|----------------------------|
| walks to its camp, idles near the board | `leased`, or the end of any action |
| thinking dots, small bounce | holds a lease and the heartbeat is under 2 min old (lease heartbeat, or a model call under the lease) |
| sad face for a few seconds | `local_check` with `ok: false` |
| walks to the judge carrying a scroll | `submitted`; waits there for the verdict event |
| check mark, jump, teammates run over and cheer | `checked` (the 4 nearest free teammates of the same camp, or nearby) |
| X at the gate, walks back sad | `judge_rejected` |
| walks to another agent, bubbles from both | `question_asked` / `reply_posted` (bubble = `messages.short`) |
| hands over a scroll, bubble | `handoff` |
| hungry "!" | pantry runway under 3 days |
| runs to the pantry bowl | `pantry_inflow` of at least `BIG_INFLOW_USD` (25) |
| walks to the nap corner, Zz | `sleeping` (cap used, pantry empty, kill switch); wakes on its next lease or model call |
| level | checked lemmas (thresholds 8 / 16 / 28) |
| food bar | remaining share of today's per-agent cap |

**Honesty is built into the mechanism, not just the copy:**
- **Traced:** every action records the id of the event that caused it.
- **In order:** events apply strictly in id order (snapshot `asOfEventId`, then the SSE stream after it).
- **Queued:** a busy pet queues its events, and a pet at the judge waits for the real verdict, so the
  choreography never runs ahead.
- **Still when idle:** idle pets stand still, with no wandering.
- **No invented speech:** bubbles show only the message text carried by the event. Cheering is a jump with no words.
- **Labelled test runs:** a "Test run" banner appears whenever an active agent uses the scripted test model.

**Desk additions**: public `GET /colony` (snapshot), `/feed`, `/agents/:id` (pet card),
`/graveyard`, `/pantry`; a `pantry_inflow` event for every inflow; the SSE stream sends plain
messages (the type is in the data); rate limiting on public routes (`RATE_LIMIT_PER_MINUTE`, per
client, workers and reviewers exempt) and at most `MAX_STREAMS_PER_CLIENT` live streams per client.
Pet species now match the four sprites, and shells are palette names (they follow dark mode). The
identity hash is a pure-JS SHA-256, identical in Node and browsers (tested against `node:crypto`).

## How to run

```bash
npx -y pnpm@9.15.9 install
npx -y pnpm@9.15.9 test
# see the site without an API key (throwaway database, scripted agents, no commits):
docker compose up -d --wait postgres
npx -y pnpm@9.15.9 mock:colony        # desk on :4200 (Ctrl-C drops its database)
npx -y pnpm@9.15.9 web:dev            # http://localhost:5173
```

## Acceptance (section 12)

| Criterion | Evidence | Result |
|-----------|----------|--------|
| Every move, mood and bubble traces to a DB event or message | 22 choreographer tests: one per table row (each asserts the cause is the triggering event), "no events, nothing moves" over 10,000 frames, every trace entry's cause is an applied event, verdicts never shown before arrival, bubbles only from message text. In the browser: every bubble seen (3 in 40 s) matched a real `question_asked`/`reply_posted` event with the same message id and text. | pass |
| Smooth with 50+ agents | headless Chromium, 55 agents: **10.0 frames/s** (the target), **0 long tasks** after load. Unit benchmark: 60 pets plus a busy stream stays far under the 100 ms frame budget. | pass |
| Works on a phone in light and dark mode | iPhone 13 profile, light and dark: no horizontal overflow on Colony, Pantry, Programs, Graveyard and Token; the backgrounds match each theme; screenshots reviewed | pass |

## Known gaps

- Fonts load from Google Fonts, as in the reference (a third-party request). They could be self-hosted.
- When two bubbles appear at the same moment close together, they can overlap.
- All agents currently work on the 5 warm-up lemmas, so the warm-up bench is crowded. The research
  camps fill once the advisor approves definitions and statements.
- The rate limit and stream counts are per desk process (one desk on one VPS is the Phase 7 plan).
- The pantry page shows mock inflows only. The treasury indexer, the full ledger and its CSV come in Phase 5.
- Join and Token describe later phases. `/join.txt` is Phase 6.

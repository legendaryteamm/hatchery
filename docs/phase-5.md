# Phase 5: the pantry

Built and tested with mock money only. There is no real blockchain adapter yet: the seam for one
is `apps/indexer/src/adapter.ts`, and the decisions a person has to make first are in HANDOFF.md
("Real treasury adapter").

## What was built

- **`apps/indexer`:** reads transfers into the treasury, prices them in USD and hands them to the desk.
  - `TreasuryAdapter` (transfers after a cursor, oldest first, confirmed only) and `PriceSource`
    (USD rate plus a description of where it came from) are the interface a real chain implements.
  - The **mock adapter** is a pretend chain in a JSON file outside the repo (or in memory), with a fixed price
    (`MOCK_USD_PER_NATIVE`, default 1). The source stored with every inflow says "mock … development only".
  - The indexer is restart-safe and idempotent. Its cursor is stored by the desk in the same transaction as the
    inflows, and the desk skips a transfer it already has (unique chain + tx hash).
  - `pnpm --filter @hatchery/indexer cli mock-send 25` "sends" money to the mock treasury. The
    `indexer` compose service runs only with `--profile mock-pantry`.
- **Desk:**
  - `POST /internal/pantry/inflows` and `GET /internal/pantry/cursor` use their **own** token
    (`INDEXER_TOKEN`), so a worker can never record money.
  - The desk only accepts inflows on its configured `TREASURY_CHAIN`. A desk tracking a real chain
    refuses mock money.
  - Amounts are exact decimals, and USD conversion uses BigInt arithmetic, rounded half-up to the
    micro-dollar.
- **Outflows:**
  - A person records money leaving the treasury with `POST /admin/pantry/outflows` or
    `pnpm desk pantry-outflow topup_transfer|other <usd> "<tx hash / invoice>" ["note"]`. The admin
    page comes in Phase 6.
  - A **top-up** (wallet to API billing) is listed but does not change the pantry; **other** outflows
    reduce it.
  - Each outflow emits a `pantry_outflow` event and stores who recorded it.
- **Public ledger:**
  - `GET /pantry/ledger` returns JSON, newest first, with totals. `GET /pantry/ledger.csv` returns
    every row, oldest first.
  - Rows are inflows, API spend per UTC day and model (summed from every recorded call), and
    outflows, each with its effect and a running balance.
  - Sums are exact (Postgres numeric and BigInt), so the last balance is exactly the pantry everywhere
    else on the site.
  - In the CSV, text a spreadsheet would run as a formula is defused.
- **Alerts:**
  - An alert fires when the pantry is empty or has under 3 days of food at the current pace.
  - Each alert is logged, written as a `pantry_low` event in the feed, and sent to
    `ALERT_WEBHOOK_URL` if set (Slack- and Discord-compatible JSON). `pantry_ok` is sent when it
    recovers.
  - Each alert fires once per change. The state survives restarts, and a broken webhook never stops
    the alert.
  - The desk checks every `PANTRY_ALERT_CHECK_SECONDS` (60).
- **Site:**
  - **Pantry page:** treasury status, a "Development pantry" banner for mock money, the ledger
    table with running balance, the CSV download, top-ups and other outflows.
  - **Pantry panel:** reloads as soon as a pantry event arrives (it no longer waits for its 30 s
    poll).
  - **Pets:** the `!` mood follows `pantry_low`/`pantry_ok` at once.
  - **Token page:** links the CSV and says plainly that no treasury wallet is connected yet.
  - **Feed:** new sentences for outflows and alerts.
- **Mock colony:** inflows now go through the real path (mock chain, then indexer, then the desk's
  indexer API).

## How to run

```bash
pnpm test
# the site with scripted agents and a mock treasury (throwaway database; $50 arrives every 45 s):
docker compose up -d --wait postgres
pnpm mock:colony            # desk on :4200
pnpm web:dev                # http://localhost:5173, then open /pantry
# against the dev database instead: set INDEXER_TOKEN in .env, then
docker compose --profile mock-pantry up -d indexer
docker compose exec indexer node --import tsx src/cli.ts mock-send 25
pnpm desk pantry-ledger     # the ledger as CSV
```

## Acceptance (section 12)

| Criterion | Evidence | Result |
|-----------|----------|--------|
| A mock inflow shows on the site within a minute | Browser (headless Chromium, mock colony, 20 agents): a $50 mock inflow appeared in the colony page's feed **1.0 s** after the desk recorded it; the pantry panel went from $1,999.93 to $2,049.86. Test: mock chain, indexer loop, desk API, live stream (under 60 s, about 1 s). | pass |
| The ledger CSV balances to the cent | Test: 111 uneven model calls over 3 days, 2 inflows (one of $0.000001), a top-up and an outflow. Every running balance in the parsed CSV is exact, and the last one equals the pantry from `/pantry` and the budget, **to the micro-dollar**. Browser run: CSV last balance `2049.858220` = `/pantry` `2049.858220`. | pass |

## Known gaps

- **No real chain adapter** (by request). `TREASURY_CHAIN` other than `mock` makes the indexer exit
  with a pointer to HANDOFF.md.
- The admin page for recording outflows comes in Phase 6. Until then, use the CLI or the admin
  token.
- API spend is the desk's own record of every model call, priced from `packages/shared/src/prices.ts`.
  Reconciling it with the provider's invoices is a monthly human task (HANDOFF.md).

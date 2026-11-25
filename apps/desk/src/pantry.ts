/**
 * The pantry's public books (BUILD_PROMPT.md section 8).
 *
 *   pantry = inflows - API spend (model_calls) - outflows of kind "other"
 *
 * A `topup_transfer` moves money from the treasury wallet to API billing: it is listed in the
 * ledger, but it does not change the pantry (the money is still food, just prepaid). API spend is
 * listed per UTC day and model, summed from every recorded model call.
 *
 * All sums are exact (Postgres numeric, then BigInt micro-dollars), so the ledger's running balance
 * ends at exactly the pantry balance shown everywhere else.
 */
import { sql } from "drizzle-orm";
import { formatMicros, HUNGRY_RUNWAY_DAYS, usdToMicros } from "@hatchery/shared";
import { settings } from "./db/schema.ts";
import { emit, type Desk } from "./service.ts";
import { pantrySummary } from "./views.ts";

export type LedgerKind = "inflow" | "api_spend" | "topup_transfer" | "other";

export interface LedgerRow {
  ts: string;
  kind: LedgerKind;
  description: string;
  reference: string;
  usdRateSource: string;
  /** The amount moved (always positive). */
  amountUsd: string;
  /** Effect on the pantry: + inflow, - spend / other outflow, 0 for a top-up transfer. */
  pantryChangeUsd: string;
  /** Pantry balance after this row. */
  balanceUsd: string;
}

const KIND_ORDER: Record<LedgerKind, number> = { inflow: 0, topup_transfer: 1, other: 2, api_spend: 3 };

/** Every row of the ledger, oldest first, with a running balance. */
export async function ledger(desk: Desk): Promise<{ rows: LedgerRow[]; totals: { inflowsUsd: string; apiSpendUsd: string; otherOutflowsUsd: string; topupsUsd: string; pantryUsd: string } }> {
  const db = desk.db;
  const inflows = await db.execute<{ ts: string; chain: string; tx_hash: string; amount_native: string; amount_usd: string; usd_rate_source: string }>(sql`
    select ts::text, chain, tx_hash, amount_native::text, amount_usd::text, usd_rate_source from pantry_inflows`);
  const spend = await db.execute<{ day: string; model: string; calls: number; last_ts: string; total: string }>(sql`
    select to_char(ts at time zone 'UTC', 'YYYY-MM-DD') as day, model, count(*)::int as calls, max(ts)::text as last_ts, sum(cost_usd)::text as total
    from model_calls group by 1, 2`);
  const outflows = await db.execute<{ id: number; ts: string; kind: "api_spend" | "topup_transfer" | "other"; amount_usd: string; reference: string; note: string }>(sql`
    select id, ts::text, kind, amount_usd::text, reference, note from pantry_outflows`);

  type Raw = Omit<LedgerRow, "balanceUsd" | "pantryChangeUsd" | "amountUsd"> & { amount: bigint; change: bigint; sortTs: number };
  const raw: Raw[] = [];
  for (const i of inflows) {
    const amount = usdToMicros(i.amount_usd);
    raw.push({
      ts: new Date(i.ts).toISOString(), sortTs: new Date(i.ts).getTime(), kind: "inflow",
      description: `${i.chain === "mock" ? "Mock inflow (development only)" : `Transfer on ${i.chain}`}: ${trimZeros(i.amount_native)} native`,
      reference: i.tx_hash, usdRateSource: i.usd_rate_source, amount, change: amount,
    });
  }
  for (const s of spend) {
    const amount = usdToMicros(s.total);
    raw.push({
      ts: new Date(s.last_ts).toISOString(), sortTs: new Date(s.last_ts).getTime(), kind: "api_spend",
      description: `API calls on ${s.day} (UTC): ${s.calls} x ${s.model}`,
      reference: `model_calls ${s.day} ${s.model}`, usdRateSource: "", amount, change: -amount,
    });
  }
  for (const o of outflows) {
    if (o.kind === "api_spend") continue; // reserved: API spend comes from model_calls
    const amount = usdToMicros(o.amount_usd);
    raw.push({
      ts: new Date(o.ts).toISOString(), sortTs: new Date(o.ts).getTime(), kind: o.kind,
      description: o.kind === "topup_transfer" ? `Top-up: treasury wallet to API billing${o.note ? ` (${o.note})` : ""}` : `Outflow${o.note ? `: ${o.note}` : ""}`,
      reference: o.reference, usdRateSource: "", amount, change: o.kind === "other" ? -amount : 0n,
    });
  }
  raw.sort((a, b) => a.sortTs - b.sortTs || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.reference.localeCompare(b.reference));

  let balance = 0n;
  const totals = { inflow: 0n, api_spend: 0n, other: 0n, topup_transfer: 0n };
  const rows = raw.map(({ amount, change, sortTs: _s, ...r }) => {
    balance += change;
    totals[r.kind] += amount;
    return { ...r, amountUsd: formatMicros(amount), pantryChangeUsd: formatMicros(change), balanceUsd: formatMicros(balance) };
  });
  return {
    rows,
    totals: {
      inflowsUsd: formatMicros(totals.inflow),
      apiSpendUsd: formatMicros(totals.api_spend),
      otherOutflowsUsd: formatMicros(totals.other),
      topupsUsd: formatMicros(totals.topup_transfer),
      pantryUsd: formatMicros(balance),
    },
  };
}

const trimZeros = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/** One CSV field: quoted when needed; text that a spreadsheet would run as a formula is defused. */
function csvField(v: string, text: boolean): string {
  let s = v;
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const LEDGER_CSV_HEADER = ["timestamp_utc", "kind", "description", "reference", "usd_rate_source", "amount_usd", "pantry_change_usd", "pantry_balance_usd"];

export function ledgerCsv(rows: LedgerRow[]): string {
  const lines = [LEDGER_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.ts, false), csvField(r.kind, false), csvField(r.description, true), csvField(r.reference, true),
        csvField(r.usdRateSource, true), r.amountUsd, r.pantryChangeUsd, r.balanceUsd,
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ------------------------------------------------------------------ alerts

export interface AlertState {
  low: boolean;
  since: string | null;
}

/**
 * Low-food alert: when the pantry is empty, or has under HUNGRY_RUNWAY_DAYS days of food at the
 * current pace. Fires once when it starts and once when it ends: a log line, a feed event and,
 * if ALERT_WEBHOOK_URL is set, a webhook. The state survives restarts (settings table).
 */
export class PantryAlerts {
  constructor(
    private desk: Desk,
    private log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void } = console as never,
    private post: (url: string, body: unknown) => Promise<void> = postJson,
  ) {}

  async state(): Promise<AlertState> {
    const [row] = await this.desk.db.select().from(settings).where(sql`${settings.key} = 'pantry_alert'`);
    return (row?.value as AlertState | undefined) ?? { low: false, since: null };
  }

  async check(): Promise<{ changed: boolean; low: boolean }> {
    const p = await pantrySummary(this.desk);
    const low = p.hungry;
    const prev = await this.state();
    if (prev.low === low) return { changed: false, low };
    const now = this.desk.now().toISOString();
    const runway = p.runwayDays === null ? null : p.runwayDays;
    const text = low
      ? Number(p.pantryUsd) <= 0
        ? "Pantry alert: the pantry is empty. The agents cannot call models until money comes in."
        : `Pantry alert: about ${runway} days of food left at the current pace (under ${HUNGRY_RUNWAY_DAYS}). Pantry: $${Number(p.pantryUsd).toFixed(2)}.`
      : `Pantry OK again: ${runway === null ? "no recent spend" : `about ${runway} days of food`} at the current pace. Pantry: $${Number(p.pantryUsd).toFixed(2)}.`;
    await this.desk.db.transaction(async (tx) => {
      await tx
        .insert(settings)
        .values({ key: "pantry_alert", value: { low, since: now }, updatedBy: "pantry-alerts" })
        .onConflictDoUpdate({ target: settings.key, set: { value: { low, since: now }, updatedAt: new Date(now), updatedBy: "pantry-alerts" } });
      await emit(tx, low ? "pantry_low" : "pantry_ok", { payload: { pantryUsd: p.pantryUsd, runwayDays: runway, dailySpendUsd: p.dailySpendUsd } });
    });
    this.log.warn({ pantryUsd: p.pantryUsd, runwayDays: runway }, text);
    const url = this.desk.config.ALERT_WEBHOOK_URL;
    if (url) {
      try {
        await this.post(url, { text, content: text, event: low ? "pantry_low" : "pantry_ok", pantryUsd: p.pantryUsd, runwayDays: runway });
      } catch (err) {
        this.log.error({ err: (err as Error).message }, "pantry alert webhook failed (the alert is still logged and in the feed)");
      }
    }
    return { changed: true, low };
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`webhook answered ${r.status}`);
}

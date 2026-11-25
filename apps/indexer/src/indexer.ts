/**
 * The pantry indexer: reads new transfers into the treasury from an adapter, prices them in USD,
 * and hands them to the desk (which stores them, emits `pantry_inflow` events and keeps the cursor).
 * Restart-safe and idempotent: the cursor lives in the desk's database, and the desk skips a
 * transfer it already has.
 */
import { formatMicros, nativeToUsdMicros } from "@hatchery/shared";
import type { PriceSource, TreasuryAdapter } from "./adapter.ts";

export interface DeskPantryClient {
  cursor(chain: string): Promise<string | null>;
  record(chain: string, cursor: string | null, inflows: { txHash: string; amountNative: string; amountUsd: string; usdRateSource: string; ts: string }[]): Promise<{ recorded: number; duplicates: number }>;
}

export class HttpDeskPantryClient implements DeskPantryClient {
  constructor(private baseUrl: string, private token: string) {}
  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`desk ${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }
  async cursor(chain: string) {
    return (await this.call<{ cursor: string | null }>(`/internal/pantry/cursor?chain=${encodeURIComponent(chain)}`)).cursor;
  }
  record(chain: string, cursor: string | null, inflows: Parameters<DeskPantryClient["record"]>[2]) {
    return this.call<{ recorded: number; duplicates: number }>("/internal/pantry/inflows", { method: "POST", body: JSON.stringify({ chain, cursor, inflows }) });
  }
}

export class Indexer {
  constructor(
    private adapter: TreasuryAdapter,
    private price: PriceSource,
    private desk: DeskPantryClient,
    private address: string,
    private batch = 100,
  ) {}

  /** One pass: everything new since the stored cursor. Returns how many inflows were recorded. */
  async tick(): Promise<{ recorded: number; duplicates: number }> {
    let total = { recorded: 0, duplicates: 0 };
    for (;;) {
      const cursor = await this.desk.cursor(this.adapter.chain);
      const { transfers, cursor: next } = await this.adapter.transfersSince(this.address, cursor, this.batch);
      if (!transfers.length) return total;
      const priced = [];
      for (const t of transfers) {
        const { rate, source } = await this.price.usdPerNative(this.adapter.chain, t.ts);
        priced.push({ txHash: t.txHash, amountNative: t.amountNative, amountUsd: formatMicros(nativeToUsdMicros(t.amountNative, rate)), usdRateSource: source, ts: t.ts.toISOString() });
      }
      const r = await this.desk.record(this.adapter.chain, next, priced);
      total = { recorded: total.recorded + r.recorded, duplicates: total.duplicates + r.duplicates };
      if (transfers.length < this.batch) return total;
    }
  }
}

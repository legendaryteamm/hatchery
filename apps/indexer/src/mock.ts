/**
 * Development stand-ins: a pretend chain and a fixed price. Every inflow they produce is stored
 * with chain "mock" and labelled "development only" on the site.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseDecimal } from "@hatchery/shared";
import type { ChainTransfer, PriceSource, TreasuryAdapter } from "./adapter.ts";

interface StoredTransfer {
  height: number;
  txHash: string;
  amountNative: string;
  ts: string;
}

/** A pretend chain: an append-only list of transfers, in memory or in a JSON file (never in the repo). */
export class MockChain {
  private memory: StoredTransfer[] = [];
  constructor(private file: string | null = null) {}

  private load(): StoredTransfer[] {
    if (!this.file) return this.memory;
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as StoredTransfer[]) : [];
  }

  private save(list: StoredTransfer[]) {
    if (!this.file) {
      this.memory = list;
      return;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 1));
    renameSync(tmp, this.file);
  }

  /** "Send" money to the treasury. */
  send(amountNative: string, ts = new Date()): StoredTransfer {
    if (parseDecimal(amountNative, 18) <= 0n) throw new Error("amount must be positive");
    const list = this.load();
    const t = { height: list.length + 1, txHash: `mock-${randomBytes(8).toString("hex")}`, amountNative, ts: ts.toISOString() };
    this.save([...list, t]);
    return t;
  }

  transfers(): StoredTransfer[] {
    return this.load();
  }
}

export class MockAdapter implements TreasuryAdapter {
  readonly chain = "mock";
  constructor(private mockChain: MockChain) {}

  async transfersSince(_address: string, cursor: string | null, limit: number): Promise<{ transfers: ChainTransfer[]; cursor: string | null }> {
    const after = cursor === null ? 0 : Number(cursor);
    const next = this.mockChain.transfers().filter((t) => t.height > after).slice(0, limit);
    return {
      transfers: next.map((t) => ({ txHash: t.txHash, amountNative: t.amountNative, ts: new Date(t.ts) })),
      cursor: next.length ? String(next.at(-1)!.height) : cursor,
    };
  }
}

export class FixedPrice implements PriceSource {
  readonly name = "fixed";
  constructor(private rate: string) {
    parseDecimal(rate, 18);
  }
  async usdPerNative(): Promise<{ rate: string; source: string }> {
    return { rate: this.rate, source: `mock fixed rate: 1 native = ${this.rate} USD (development only)` };
  }
}

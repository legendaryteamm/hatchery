/**
 * The seam between the pantry and a blockchain (BUILD_PROMPT.md section 8).
 *
 * To support a real chain, implement TreasuryAdapter (and a PriceSource for its USD rate), register
 * it in `adapters.ts`, and set TREASURY_CHAIN / TREASURY_ADDRESS / PRICE_SOURCE. Nothing else in the
 * project changes: the indexer posts inflows to the desk, which stores and shows them.
 * See HANDOFF.md ("Real treasury adapter") for what the maintainer has to decide first.
 */

/** One confirmed transfer INTO the treasury address. */
export interface ChainTransfer {
  /** Unique per chain (transaction hash, plus a log index if one tx can hold several transfers). */
  txHash: string;
  /** Amount in the chain's native unit (or the tracked token), as an exact decimal string. */
  amountNative: string;
  /** Block time. */
  ts: Date;
}

export interface TreasuryAdapter {
  /** Chain name as stored with each inflow, e.g. "mock". Must match the desk's TREASURY_CHAIN. */
  readonly chain: string;
  /**
   * Transfers into `address` strictly after `cursor` (null = from the start), oldest first, at most
   * `limit`, and the cursor to pass next time. Only transfers that are final on the chain (enough
   * confirmations) may be returned: the desk never deletes an inflow.
   * Idempotent: the same cursor returns the same transfers.
   */
  transfersSince(address: string, cursor: string | null, limit: number): Promise<{ transfers: ChainTransfer[]; cursor: string | null }>;
}

/** USD price of the native unit at a time, with a human-readable description of where it came from. */
export interface PriceSource {
  readonly name: string;
  usdPerNative(chain: string, at: Date): Promise<{ rate: string; source: string }>;
}

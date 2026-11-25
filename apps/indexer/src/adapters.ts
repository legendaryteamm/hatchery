/**
 * Which adapter runs for TREASURY_CHAIN. Only the mock exists; a real chain is a maintainer
 * decision (HANDOFF.md, "Real treasury adapter").
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PriceSource, TreasuryAdapter } from "./adapter.ts";
import { FixedPrice, MockAdapter, MockChain } from "./mock.ts";

export class NoAdapterError extends Error {}

export function mockChainFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOCK_CHAIN_FILE || join(tmpdir(), "hatchery-mock-chain.json");
}

export function adapterFor(env: NodeJS.ProcessEnv = process.env): { adapter: TreasuryAdapter; price: PriceSource; mockChain: MockChain | null } {
  const chain = env.TREASURY_CHAIN || "mock";
  if (chain === "mock") {
    const mockChain = new MockChain(mockChainFile(env));
    return { adapter: new MockAdapter(mockChain), price: new FixedPrice(env.MOCK_USD_PER_NATIVE || "1"), mockChain };
  }
  throw new NoAdapterError(
    `no treasury adapter for TREASURY_CHAIN=${chain} yet. Implement TreasuryAdapter and PriceSource (apps/indexer/src/adapter.ts) ` +
      `and register them in apps/indexer/src/adapters.ts; see HANDOFF.md, "Real treasury adapter".`,
  );
}

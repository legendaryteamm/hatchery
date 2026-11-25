/**
 * pnpm --filter @hatchery/indexer start
 * Env: DESK_URL, INDEXER_TOKEN, TREASURY_CHAIN (only "mock" today), TREASURY_ADDRESS,
 *      INDEXER_POLL_SECONDS (15), MOCK_CHAIN_FILE, MOCK_USD_PER_NATIVE (1),
 *      MOCK_AUTO_INFLOW_SECONDS (0 = off), MOCK_AUTO_INFLOW_NATIVE (25)
 */
import { adapterFor, NoAdapterError } from "./adapters.ts";
import { HttpDeskPantryClient, Indexer } from "./indexer.ts";

const env = process.env;
const token = env.INDEXER_TOKEN;
if (!token || token.length < 16) {
  console.error("INDEXER_TOKEN (>= 16 chars, the same value as the desk's) is required");
  process.exit(2);
}
let picked;
try {
  picked = adapterFor(env);
} catch (err) {
  if (err instanceof NoAdapterError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
const { adapter, price, mockChain } = picked;
const indexer = new Indexer(adapter, price, new HttpDeskPantryClient(env.DESK_URL || "http://127.0.0.1:4200", token), env.TREASURY_ADDRESS || "");
const pollMs = Number(env.INDEXER_POLL_SECONDS || 15) * 1000;
console.log(`indexer: chain=${adapter.chain}, price=${price.name}, polling every ${pollMs / 1000}s`);

// Development only: the mock chain can "receive" money on a timer, so the site has inflows to show.
const autoSeconds = Number(env.MOCK_AUTO_INFLOW_SECONDS || 0);
if (mockChain && autoSeconds > 0) {
  setInterval(() => mockChain.send(env.MOCK_AUTO_INFLOW_NATIVE || "25"), autoSeconds * 1000);
  console.log(`indexer: mock chain receives ${env.MOCK_AUTO_INFLOW_NATIVE || "25"} every ${autoSeconds}s (development only)`);
}

let stopping = false;
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stopping = true));
while (!stopping) {
  try {
    const r = await indexer.tick();
    if (r.recorded) console.log(`indexer: recorded ${r.recorded} inflow(s)`);
  } catch (err) {
    console.error(`indexer: ${(err as Error).message} (retrying)`);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}

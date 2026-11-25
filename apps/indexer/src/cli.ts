/**
 * pnpm --filter @hatchery/indexer cli mock-send <amount>   DEV ONLY: the mock chain receives <amount>
 * pnpm --filter @hatchery/indexer cli mock-list            print the mock chain's transfers
 * The mock chain is a JSON file outside the repo (MOCK_CHAIN_FILE, default: the temp directory).
 */
import { MockChain } from "./mock.ts";
import { mockChainFile } from "./adapters.ts";

const [cmd, amount] = process.argv.slice(2);
const chain = new MockChain(mockChainFile());
if (cmd === "mock-send" && amount) {
  console.log(chain.send(amount));
  console.log(`(${mockChainFile()}; the running indexer picks it up at its next poll)`);
} else if (cmd === "mock-list") {
  console.table(chain.transfers());
} else {
  console.error("usage: indexer mock-send <amount> | mock-list");
  process.exitCode = 2;
}

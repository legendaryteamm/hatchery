/**
 * Mock colony for looking at the site without an API key (`pnpm mock:colony`).
 *
 *  - Its own THROWAWAY database (created now, dropped on exit). Never the dev database.
 *  - Bot commits OFF. Nothing touches the checkout.
 *  - Agents use the scripted test model ("fake-model"), so the site shows its "Test run" banner.
 *    Every event on the site is a real record of this scripted run; nothing is drawn without one.
 *  - Judge stand-in: a proof passes when it carries the "-- PASS" marker (no Lean, no Docker).
 *  - Pantry: a mock chain receives $50 every 45 s; the real indexer code picks it up and posts it to
 *    the desk's indexer API, exactly as it would for a real chain.
 *
 * Env: MOCK_AGENTS (default 55), PORT (default 4200), MOCK_SEED.
 */
import type { AddressInfo } from "node:net";
import { buildServer, Desk, LeanRepo } from "@hatchery/desk";
import { FixedPrice, HttpDeskPantryClient, Indexer, MockAdapter, MockChain } from "@hatchery/indexer";
import { addInflow, FakeJudge, freshDb, REPO_LEAN_DIR, testConfig, WORKER_TOKEN } from "../../desk/test/helpers.ts";
import { Agent } from "../src/agent.ts";
import { DeskClient } from "../src/desk-client.ts";
import { call, FakeProvider } from "../test/fake-provider.ts";

const N = Number(process.env.MOCK_AGENTS ?? 55);
const PORT = Number(process.env.PORT ?? 4200);
let seed = Number(process.env.MOCK_SEED ?? 7);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const fresh = await freshDb();
const repo = new LeanRepo(REPO_LEAN_DIR);
const judge = new FakeJudge({ flavor: "lite", trustedSha: repo.trustedSha(), leanVersion: "4.36.0" });
const desk = new Desk(fresh.db, judge, repo, testConfig({
  PROOF_COMMIT_MODE: "off",
  GLOBAL_DAILY_CAP_USD: String(N * 0.04), // a few dozen calls each, then naps
  LEMMA_ABANDON_AFTER_ATTEMPTS: "1000000",
  AGENT_MAX_ATTEMPTS_PER_LEMMA: "6",
  RATE_LIMIT_PER_MINUTE: "100000",
  ACTIVE_AGENT_WINDOW_SECONDS: "120",
  INDEXER_TOKEN: "mock-colony-indexer-token",
}));
await desk.syncStatements();
await addInflow(fresh.db, 2_000);
const app = buildServer(desk);
await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`mock colony: desk on http://127.0.0.1:${(app.server.address() as AddressInfo).port} (throwaway database), ${N} scripted agents`);

// The scripted model: check, sometimes fail, sometimes ask a teammate, then submit (pass or fail).
const right = (n: string) => `import Statements.${n}\ntheorem Proof.${n} : Statement.${n} := by decide -- PASS\n`;
const wrong = (n: string) => `import Statements.${n}\ntheorem Proof.${n} : Statement.${n} := by rfl\n`;
const model = () =>
  new FakeProvider(({ purpose, leanName, turn }) => {
    if (purpose === "reply") return [{ type: "text", text: rand() < 0.5 ? "HINT: try cases on the list first." : "HINT: unfold the statement, then simp." }];
    if (turn < 3 && rand() < 0.85) return [call("lean_check", { source: wrong(leanName) })];
    if (turn === 3 && rand() < 0.8) return [call("ask_teammates", { question: "rfl and simp both fail on this one; which lemma should I use?", short: "simp keeps failing" })];
    return [call("submit_proof", { source: rand() < 0.55 ? right(leanName) : wrong(leanName), notes: "scripted attempt" })];
  }, 600 + Math.floor(rand() * 1800));

// The warm-up has only 5 lemmas: reopen checked ones now and then so the colony keeps working.
const reopen = setInterval(async () => {
  await fresh.db.execute(
    (await import("drizzle-orm")).sql`update lemmas set status = 'open', checked_source = null, checked_fingerprint = null where status = 'checked' and random() < 0.3`,
  );
}, 15_000);
const mockChain = new MockChain(); // in memory: gone with the throwaway database
const indexer = new Indexer(new MockAdapter(mockChain), new FixedPrice("1"), new HttpDeskPantryClient(`http://127.0.0.1:${PORT}`, "mock-colony-indexer-token"), "");
const inflow = setInterval(() => mockChain.send("50"), 45_000);
const indexing = setInterval(() => void indexer.tick().catch((e) => console.error(`indexer: ${e.message}`)), 5_000);

let stopping = false;
const runs = Array.from({ length: N }, (_, i) =>
  new Promise((r) => setTimeout(r, i * 120)).then(() =>
    new Agent(new DeskClient(`http://127.0.0.1:${PORT}`, WORKER_TOKEN, `mock-agent-${i + 1}`), model(), {
      maxTurns: 6, maxRunUsd: 0, maxLemmas: 0, exitWhenIdle: false, idleSleepMs: 1500, sleepPollMs: 5000, replyWaitMs: 4000, replyMaxTokens: 256,
      killSwitch: () => false, shouldStop: () => stopping, log: () => {},
    }).run().catch((e) => console.error(`mock-agent-${i + 1}: ${e.message}`)),
  ),
);

const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(reopen);
  clearInterval(inflow);
  clearInterval(indexing);
  console.log("stopping agents and dropping the throwaway database…");
  await Promise.race([Promise.allSettled(runs), new Promise((r) => setTimeout(r, 15_000))]);
  await app.close();
  await fresh.cleanup();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

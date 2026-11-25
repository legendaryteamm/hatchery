import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer } from "@hatchery/desk";
import { makeDesk } from "../../desk/test/helpers.ts";
import { adapterFor, NoAdapterError } from "../src/adapters.ts";
import { HttpDeskPantryClient, Indexer } from "../src/indexer.ts";
import { FixedPrice, MockAdapter, MockChain } from "../src/mock.ts";

const INDEXER_TOKEN = "test-indexer-token-0123456789";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function deskServer(config: Record<string, string> = {}) {
  const d = await makeDesk({ pantryUsd: 0, config: { INDEXER_TOKEN, ...config } });
  cleanups.push(d.cleanup);
  const app = buildServer(d.desk);
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  return { ...d, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

/** First SSE message after `after`, or null after `ms`. */
async function nextStreamEvent(url: string, after: number, ms: number): Promise<{ type: string; payload: Record<string, unknown> } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${url}/events/stream?after=${after}`, { signal: ctl.signal });
    const reader = r.body!.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += new TextDecoder().decode(value);
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) return JSON.parse(m[1]!);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

describe("pantry indexer with the mock adapter", () => {
  it("a mock inflow reaches the pantry, the feed and the live stream within one poll", async () => {
    const { url } = await deskServer();
    const mockChain = new MockChain();
    const indexer = new Indexer(new MockAdapter(mockChain), new FixedPrice("2.5"), new HttpDeskPantryClient(url, INDEXER_TOKEN), "");
    const before = (await (await fetch(`${url}/colony`)).json()).asOfEventId as number;

    const sentAt = Date.now();
    mockChain.send("10.1");
    // The indexer loop, as main.ts runs it, with a 1 s poll.
    let seenAt = 0;
    const loop = (async () => {
      while (!seenAt) {
        await indexer.tick();
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    const ev = await nextStreamEvent(url, before, 60_000);
    seenAt = Date.now();
    await loop;
    expect(ev).toMatchObject({ type: "pantry_inflow", payload: { chain: "mock", amountUsd: "25.250000" } });
    expect(seenAt - sentAt).toBeLessThan(60_000); // the acceptance bound; in practice about a second

    const pantry = await (await fetch(`${url}/pantry`)).json();
    expect(pantry).toMatchObject({ pantryUsd: "25.250000", treasury: { chain: "mock", mock: true } });
    expect(pantry.recentInflows[0]).toMatchObject({ chain: "mock", amountUsd: "25.250000", usdRateSource: "mock fixed rate: 1 native = 2.5 USD (development only)" });
    const feed = await (await fetch(`${url}/feed?limit=5`)).json();
    expect(feed[0]).toMatchObject({ type: "pantry_inflow" });
  });

  it("restarts and re-sent batches never count money twice", async () => {
    const { url, desk } = await deskServer();
    const mockChain = new MockChain();
    const client = new HttpDeskPantryClient(url, INDEXER_TOKEN);
    for (let i = 0; i < 7; i++) mockChain.send("1");
    expect(await new Indexer(new MockAdapter(mockChain), new FixedPrice("1"), client, "", 3).tick()).toEqual({ recorded: 7, duplicates: 0 }); // 3 batches
    mockChain.send("0.5");
    // A new process (restart) continues from the cursor stored in the desk.
    expect(await new Indexer(new MockAdapter(mockChain), new FixedPrice("1"), client, "").tick()).toEqual({ recorded: 1, duplicates: 0 });
    expect(await new Indexer(new MockAdapter(mockChain), new FixedPrice("1"), client, "").tick()).toEqual({ recorded: 0, duplicates: 0 });
    // A crash after the desk stored the inflows but before the cursor moved: the same transfers come again.
    const all = mockChain.transfers();
    const r = await client.record("mock", null, all.map((t) => ({ txHash: t.txHash, amountNative: t.amountNative, amountUsd: t.amountNative, usdRateSource: "x", ts: t.ts })));
    expect(r).toEqual({ recorded: 0, duplicates: 8 });
    expect((await desk.budget(null)).pantryUsd).toBe("7.500000");
  });

  it("the mock chain file lives outside the repo, and only the mock chain has an adapter", () => {
    const dir = mkdtempSync(join(tmpdir(), "hatchery-mock-chain-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "chain.json");
    const a = adapterFor({ TREASURY_CHAIN: "mock", MOCK_CHAIN_FILE: file });
    a.mockChain!.send("3");
    expect(new MockChain(file).transfers()).toHaveLength(1); // another process (the CLI) sees it
    expect(adapterFor({}).adapter.chain).toBe("mock");
    expect(() => adapterFor({ TREASURY_CHAIN: "base" })).toThrow(NoAdapterError);
    expect(() => adapterFor({ TREASURY_CHAIN: "base" })).toThrow(/HANDOFF\.md/);
  });

  it("a desk on another chain refuses the mock indexer's inflows", async () => {
    const { url } = await deskServer({ TREASURY_CHAIN: "base" });
    const mockChain = new MockChain();
    mockChain.send("1");
    await expect(new Indexer(new MockAdapter(mockChain), new FixedPrice("1"), new HttpDeskPantryClient(url, INDEXER_TOKEN), "").tick()).rejects.toThrow(/409/);
  });
});

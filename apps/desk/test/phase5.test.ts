import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { formatMicros, usdToMicros } from "@hatchery/shared";
import { events, modelCalls } from "../src/db/schema.ts";
import { ledger, ledgerCsv, LEDGER_CSV_HEADER, PantryAlerts } from "../src/pantry.ts";
import { buildServer } from "../src/server.ts";
import { pantrySummary } from "../src/views.ts";
import { makeDesk, WORKER_TOKEN } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function setup(opts: Parameters<typeof makeDesk>[0] = {}) {
  const d = await makeDesk(opts);
  cleanups.push(d.cleanup);
  return d;
}
const INDEXER_TOKEN = "test-indexer-token-0123456789";
const ADMIN_TOKEN = "test-admin-token-0123456789";
const part = (n = 1) => ({ model: "claude-opus-5-5", inputTokens: 1000 * n, outputTokens: 500 * n, cacheReadTokens: 0, cacheWriteTokens: 0 });
const inflow = (txHash: string, usd: string, ts = new Date()) => ({ txHash, amountNative: usd, amountUsd: usd, usdRateSource: "test rate", ts });

/** Parse the ledger CSV (RFC 4180 quoting). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(f), (f = "");
    else if (c === "\r") continue;
    else if (c === "\n") row.push(f), rows.push(row), (row = []), (f = "");
    else f += c;
  }
  return rows;
}

describe("inflows from the indexer", () => {
  it("are idempotent, keep the cursor, emit one event each, and only for the configured chain", async () => {
    const { desk, db } = await setup({ pantryUsd: 0 });
    const r1 = await desk.recordInflows("mock", [inflow("mock-a", "10"), inflow("mock-b", "2.5")], "2");
    expect(r1).toEqual({ recorded: 2, duplicates: 0 });
    expect(await desk.indexerCursor("mock")).toBe("2");
    const r2 = await desk.recordInflows("mock", [inflow("mock-b", "2.5"), inflow("mock-c", "0.000001")], "3"); // re-sent after a crash
    expect(r2).toEqual({ recorded: 1, duplicates: 1 });
    expect((await db.select().from(events).where(sql`type = 'pantry_inflow'`)).length).toBe(3);
    expect((await desk.budget(null)).pantryUsd).toBe("12.500001");
    await expect(desk.recordInflows("base", [inflow("0xabc", "1")], null)).rejects.toThrow(/records inflows on "mock" only/);
    await expect(desk.recordInflows("mock", [inflow("mock-f", "1", new Date(Date.now() + 3_600_000))], null)).rejects.toThrow(/future/);
    await expect(desk.recordInflows("mock", [inflow("mock-z", "0")], null)).rejects.toThrow(/positive/);
  });

  it("a desk that tracks a real chain refuses mock money", async () => {
    const { desk } = await setup({ pantryUsd: 0, config: { TREASURY_CHAIN: "base", TREASURY_ADDRESS: "0x1234" } });
    await expect(desk.recordInflow({ chain: "mock", ...inflow("mock-a", "5") })).rejects.toThrow(/"base" only/);
    expect((await pantrySummary(desk)).treasury).toEqual({ chain: "base", address: "0x1234", mock: false });
  });

  it("the indexer routes need the indexer token: the worker token cannot record money", async () => {
    const { desk } = await setup({ pantryUsd: 0, config: { INDEXER_TOKEN } });
    const app = buildServer(desk);
    cleanups.push(() => app.close());
    const body = { chain: "mock", cursor: "1", inflows: [{ txHash: "mock-1", amountNative: "3", amountUsd: "3", usdRateSource: "x", ts: new Date().toISOString() }] };
    const post = (token: string) => app.inject({ method: "POST", url: "/internal/pantry/inflows", headers: { authorization: `Bearer ${token}` }, payload: body });
    expect((await post(WORKER_TOKEN)).statusCode).toBe(401);
    expect((await post("wrong-token-wrong-token")).statusCode).toBe(401);
    const ok = await post(INDEXER_TOKEN);
    expect(ok.json()).toEqual({ recorded: 1, duplicates: 0 });
    const cur = await app.inject({ url: "/internal/pantry/cursor?chain=mock", headers: { authorization: `Bearer ${INDEXER_TOKEN}` } });
    expect(cur.json()).toEqual({ chain: "mock", cursor: "1" });
    const bad = await app.inject({ method: "POST", url: "/internal/pantry/inflows", headers: { authorization: `Bearer ${INDEXER_TOKEN}` }, payload: { ...body, inflows: [{ ...body.inflows[0], amountUsd: "1e9" }] } });
    expect(bad.statusCode).toBe(400);

    const { desk: off } = await setup({ pantryUsd: 0 }); // no INDEXER_TOKEN: routes disabled
    const app2 = buildServer(off);
    cleanups.push(() => app2.close());
    expect((await app2.inject({ method: "POST", url: "/internal/pantry/inflows", headers: { authorization: `Bearer ${WORKER_TOKEN}` }, payload: body })).statusCode).toBe(404);
  });
});

describe("outflows and the public ledger", () => {
  it("a top-up moves money without changing the pantry; other outflows reduce it", async () => {
    const { desk } = await setup({ pantryUsd: 100 });
    await desk.recordOutflow({ kind: "topup_transfer", amountUsd: "40", reference: "tx 0xfeed / invoice INV-7", note: "Anthropic credits", by: "cli:test" });
    expect((await desk.budget(null)).pantryUsd).toBe("100.000000");
    await desk.recordOutflow({ kind: "other", amountUsd: "1.25", reference: "tx 0xbeef", note: "chain fee", by: "cli:test" });
    const p = await pantrySummary(desk);
    expect(p).toMatchObject({ pantryUsd: "98.750000", otherOutflowsUsd: "1.250000", topupsUsd: "40.000000" });
    expect(p.recentOutflows.map((o) => o.kind)).toEqual(["other", "topup_transfer"]);
    await expect(desk.recordOutflow({ kind: "other", amountUsd: "0", reference: "x", note: "", by: "t" })).rejects.toThrow(/positive/);
  });

  it("the ledger CSV balances to the cent (to the micro-dollar) against the pantry", async () => {
    const t0 = Date.parse("2026-05-01T10:00:00Z");
    let t = new Date(t0);
    const { desk, db } = await setup({ pantryUsd: 0, now: () => t });
    await desk.recordInflows("mock", [inflow("mock-1", "50.333333", new Date(t0)), inflow("mock-2", "0.000001", new Date(t0 + 1000))], null);
    await desk.registerAgent("agent-a", "claude-opus-5-5");
    // Many small, uneven model calls over three days (floating point would drift here).
    for (let day = 0; day < 3; day++) {
      t = new Date(t0 + day * 86_400_000 + 3_600_000);
      const ctx = await desk.lease("agent-a");
      const id = await desk.startAttempt("agent-a", ctx!.lemmaId);
      for (let i = 1; i <= 37; i++) await desk.recordUsage(id, "agent-a", { purpose: "prove", parts: [{ ...part(), inputTokens: 1000 + i * 7, outputTokens: 13 * i }] });
      await desk.endAttempt(id, "agent-a", "failed", "", null);
      await desk.release("agent-a", ctx!.lemmaId, "", false);
    }
    await desk.recordOutflow({ kind: "topup_transfer", amountUsd: "20", reference: "invoice INV-1", note: "", by: "t", ts: new Date(t0 + 5000) });
    await desk.recordOutflow({ kind: "other", amountUsd: "0.07", reference: "tx 0x1", note: "chain fee", by: "t", ts: new Date(t0 + 6000) });

    const { rows, totals } = await ledger(desk);
    const pantry = (await desk.budget(null)).pantryUsd;
    expect(totals.pantryUsd).toBe(pantry);
    expect((await pantrySummary(desk)).pantryUsd).toBe(pantry);
    const [spend] = await db.execute<{ s: string }>(sql`select sum(cost_usd)::text as s from model_calls`);
    expect(totals.apiSpendUsd).toBe(formatMicros(usdToMicros(spend!.s)));
    expect(rows.filter((r) => r.kind === "api_spend")).toHaveLength(3); // one row per UTC day and model
    expect((await db.select().from(modelCalls)).length).toBe(111);

    const csv = parseCsv(ledgerCsv(rows));
    expect(csv[0]).toEqual(LEDGER_CSV_HEADER);
    const body = csv.slice(1);
    const col = (name: string) => LEDGER_CSV_HEADER.indexOf(name);
    let running = 0n;
    for (const r of body) {
      running += usdToMicros(r[col("pantry_change_usd")]!);
      expect(r[col("pantry_balance_usd")]).toBe(formatMicros(running)); // every running balance is exact
    }
    expect(formatMicros(running)).toBe(pantry); // and the last one is the pantry
    expect(body.find((r) => r[col("kind")] === "topup_transfer")![col("pantry_change_usd")]).toBe("0.000000");

    // Through HTTP too, with a download name.
    const app = buildServer(desk);
    cleanups.push(() => app.close());
    const res = await app.inject({ url: "/pantry/ledger.csv" });
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/hatchery-pantry-ledger-\d{4}-\d{2}-\d{2}\.csv/);
    expect(parseCsv(res.body).at(-1)![col("pantry_balance_usd")]).toBe(pantry);
    const json = (await app.inject({ url: "/pantry/ledger?limit=2" })).json();
    expect(json).toMatchObject({ count: rows.length, totals: { pantryUsd: pantry } });
    expect(json.rows).toHaveLength(2);
    expect(json.rows[0].balanceUsd).toBe(pantry); // newest first
  });

  it("text that a spreadsheet would run as a formula is defused in the CSV", async () => {
    const { desk } = await setup({ pantryUsd: 10 });
    await desk.recordOutflow({ kind: "other", amountUsd: "1", reference: '=HYPERLINK("http://evil","x")', note: "+1, \"quoted\"", by: "t" });
    const csv = ledgerCsv((await ledger(desk)).rows);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
    expect(parseCsv(csv).at(-1)).toContain("-1.000000"); // amounts keep their sign
  });

  it("admin records outflows over HTTP; nobody else can", async () => {
    const { desk } = await setup({ pantryUsd: 10, config: { ADMIN_TOKEN } });
    const app = buildServer(desk);
    cleanups.push(() => app.close());
    const payload = { kind: "topup_transfer", amountUsd: "5", reference: "tx 0x2 / INV-2" };
    expect((await app.inject({ method: "POST", url: "/admin/pantry/outflows", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/admin/pantry/outflows", headers: { authorization: `Bearer ${WORKER_TOKEN}` }, payload })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/admin/pantry/outflows", headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload });
    expect(ok.json()).toMatchObject({ kind: "topup_transfer", amountUsd: "5.000000", recordedBy: "admin-token" });
  });
});

describe("low-food alerts", () => {
  it("fire once when food runs low (log, feed event, webhook), once when it recovers, and survive restarts", async () => {
    const hits: unknown[] = [];
    const hook = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        hits.push(JSON.parse(b));
        res.end("ok");
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise((r) => hook.close(() => r())));
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

    const { desk, db } = await setup({ pantryUsd: 1, config: { ALERT_WEBHOOK_URL: url } });
    const logs: string[] = [];
    const log = { warn: (_o: object, m: string) => logs.push(m), error: (_o: object, m: string) => logs.push(`ERR ${m}`) };
    const alerts = new PantryAlerts(desk, log);
    expect(await alerts.check()).toEqual({ changed: false, low: false }); // nothing spent: no pace yet

    await desk.registerAgent("agent-a", "claude-opus-5-5");
    const ctx = await desk.lease("agent-a");
    const id = await desk.startAttempt("agent-a", ctx!.lemmaId);
    await desk.recordUsage(id, "agent-a", { purpose: "prove", parts: [part(30)] }); // 0.42 of 1.00: ~1.4 days left
    expect(await alerts.check()).toEqual({ changed: true, low: true });
    expect(await alerts.check()).toEqual({ changed: false, low: true }); // no repeat
    expect(await new PantryAlerts(desk, log).check()).toEqual({ changed: false, low: true }); // nor after a restart
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ event: "pantry_low", text: expect.stringMatching(/^Pantry alert: about 1\.4 days of food left/) });
    expect(logs[0]).toMatch(/Pantry alert/);

    await desk.recordInflow({ chain: "mock", ...inflow("mock-big", "100") });
    expect(await alerts.check()).toEqual({ changed: true, low: false });
    expect(hits[1]).toMatchObject({ event: "pantry_ok" });
    const types = (await db.select().from(events)).map((e) => e.type).filter((t) => t.startsWith("pantry_"));
    expect(types.filter((t) => t !== "pantry_inflow")).toEqual(["pantry_low", "pantry_ok"]);
  });

  it("a broken webhook never breaks the alert itself; an empty pantry is low", async () => {
    const { desk, db } = await setup({ pantryUsd: 0, config: { ALERT_WEBHOOK_URL: "http://127.0.0.1:9/nothing-listens-here" } });
    const logs: string[] = [];
    const alerts = new PantryAlerts(desk, { warn: (_o, m) => logs.push(m), error: (_o, m) => logs.push(`ERR ${m}`) });
    expect(await alerts.check()).toEqual({ changed: true, low: true });
    expect(logs[0]).toMatch(/the pantry is empty/);
    expect(logs[1]).toMatch(/^ERR pantry alert webhook failed/);
    expect((await db.select().from(events).where(sql`type = 'pantry_low'`)).length).toBe(1);
    expect((await pantrySummary(desk)).hungry).toBe(true);
  });
});

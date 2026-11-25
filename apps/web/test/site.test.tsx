import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { feedText } from "../src/feedText";

afterEach(cleanup);

const snapshot = {
  asOfEventId: 50,
  serverTime: new Date().toISOString(),
  programs: [
    { slug: "core-warmup", title: "Core warm-up", idPrefix: "core", checked: 2, total: 5 },
    { slug: "circuit-lower-bounds", title: "Circuit lower bounds", idPrefix: "circ", checked: 0, total: 0 },
  ],
  agents: [
    { id: "agent-1", name: "Bomo", species: "blob", shell: "pink", kind: "internal", model: "fake-model", level: 1, checkedTotal: 2, active: true, lemmaId: "L-core-003", program: "core-warmup", heartbeatFresh: true, lastHeartbeat: new Date().toISOString(), sleeping: false, sleepReason: null, camp: "core-warmup", spentTodayUsd: "0.010000", food: 0.8 },
    { id: "agent-2", name: "Kizen", species: "cat", shell: "sky", kind: "external", model: "claude-opus-5-5", level: 1, checkedTotal: 0, active: true, lemmaId: null, program: null, heartbeatFresh: false, lastHeartbeat: null, sleeping: true, sleepReason: "agent_cap", camp: "core-warmup", spentTodayUsd: "0.500000", food: 0 },
    { id: "agent-3", name: "Pipty", species: "bug", shell: "lime", kind: "internal", model: "claude-opus-5-5", level: 1, checkedTotal: 0, active: false, lemmaId: null, program: null, heartbeatFresh: false, lastHeartbeat: null, sleeping: false, sleepReason: null, camp: null, spentTodayUsd: "0.000000", food: 1 },
  ],
  pantry: { pantryUsd: "12.500000", runwayDays: 8.3, hungry: false, perAgentCapUsd: "0.500000", killSwitch: false },
  totals: { checked: 2, lemmas: 5, awake: 1 },
};
const feed = [
  { id: 50, ts: new Date().toISOString(), type: "checked", agentId: "agent-1", agentName: "Bomo", lemmaId: "L-core-002", payload: {}, message: null },
  { id: 49, ts: new Date().toISOString(), type: "model_call", agentId: "agent-1", agentName: "Bomo", lemmaId: "L-core-002", payload: {}, message: null },
];
const pantry = {
  pantryUsd: "12.500000", inflowsUsd: "20.000000", apiSpendUsd: "7.500000", otherOutflowsUsd: "0.000000", topupsUsd: "5.000000", dailySpendUsd: "1.5", runwayDays: 8.3,
  hungry: false, globalCapUsd: "0.41", perAgentCapUsd: "0.500000", spentTodayUsd: "0.1", killSwitch: false, recentInflows: [], treasury: { chain: "mock", address: "", mock: true },
};
const ledger = {
  count: 3,
  totals: { inflowsUsd: "20.000000", apiSpendUsd: "7.500000", otherOutflowsUsd: "0.000000", topupsUsd: "5.000000", pantryUsd: "12.500000" },
  rows: [
    { ts: "2026-05-02T10:00:00.000Z", kind: "api_spend", description: "API calls on 2026-05-02 (UTC): 40 x claude-opus-5-5", reference: "model_calls 2026-05-02 claude-opus-5-5", usdRateSource: "", amountUsd: "7.500000", pantryChangeUsd: "-7.500000", balanceUsd: "12.500000" },
    { ts: "2026-05-01T11:00:00.000Z", kind: "topup_transfer", description: "Top-up: treasury wallet to API billing", reference: "invoice INV-1", usdRateSource: "", amountUsd: "5.000000", pantryChangeUsd: "0.000000", balanceUsd: "20.000000" },
    { ts: "2026-05-01T10:00:00.000Z", kind: "inflow", description: "Mock inflow (development only): 20 native", reference: "mock-1", usdRateSource: "mock fixed rate", amountUsd: "20.000000", pantryChangeUsd: "20.000000", balanceUsd: "20.000000" },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.replace(/^\/api/, "").split("?")[0];
    const body = path === "/colony" ? snapshot : path === "/feed" ? feed : path === "/pantry" ? pantry : path === "/pantry/ledger" ? ledger : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  vi.stubGlobal("EventSource", class { onmessage: unknown; close() {} constructor(public url: string) {} });
  HTMLCanvasElement.prototype.getContext = (() => null) as never; // jsdom has no canvas
});

describe("feed sentences come only from event data", () => {
  it("renders facts and leaves out model-call noise and passing local checks", () => {
    expect(feedText({ id: 1, ts: "", type: "checked", agentId: "a", agentName: "Bomo", lemmaId: "L-core-001", payload: {} })!.text).toBe("Bomo's proof of L-core-001 passed the Lean checker.");
    expect(feedText({ id: 2, ts: "", type: "model_call", agentId: "a", lemmaId: null, payload: {} })).toBeNull();
    expect(feedText({ id: 3, ts: "", type: "local_check", agentId: "a", lemmaId: "L-core-001", payload: { ok: true } })).toBeNull();
    expect(feedText({ id: 4, ts: "", type: "sleeping", agentId: "a", agentName: "Bomo", lemmaId: null, payload: { reason: "pantry_empty" } })!.text).toBe("Bomo went for a nap: the pantry is empty.");
    expect(feedText({ id: 5, ts: "", type: "reply_posted", agentId: "a", agentName: "Bomo", lemmaId: "L-core-001", payload: {}, message: { short: "try decide", body: "Try decide after intro.", toName: "Kizen" } })!.text).toBe("Bomo replied to Kizen: “Try decide after intro.”");
    expect(feedText({ id: 7, ts: "", type: "pantry_outflow", agentId: null, lemmaId: null, payload: { kind: "topup_transfer", amountUsd: "40", reference: "INV-1" } })!.text).toBe("$40.00 moved from the treasury wallet to API billing (INV-1). The pantry total does not change.");
    expect(feedText({ id: 8, ts: "", type: "pantry_outflow", agentId: null, lemmaId: null, payload: { kind: "other", amountUsd: "1.5", reference: "tx 0x1", note: "chain fee" } })!.text).toBe("$1.50 left the pantry: chain fee (tx 0x1).");
    expect(feedText({ id: 9, ts: "", type: "pantry_low", agentId: null, lemmaId: null, payload: { pantryUsd: "2", runwayDays: 1.4 } })!.text).toBe("The pantry is low: about 1.4 days of food left at the current pace.");
    expect(feedText({ id: 10, ts: "", type: "pantry_low", agentId: null, lemmaId: null, payload: { pantryUsd: "0.000000", runwayDays: 0 } })!.text).toMatch(/^The pantry is empty/);
    expect(feedText({ id: 6, ts: "", type: "pantry_inflow", agentId: null, lemmaId: null, payload: { amountUsd: "40", chain: "mock" } })!.text).toBe("$40.00 came into the pantry (mock inflow, development only).");
  });
});

describe("the colony page shows only data from the API", () => {
  it("hero, LCD bar, test-run banner, roster with food bars, feed and pantry", async () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { level: 1, name: "1 tiny prover is working on lemmas around P vs NP." })).toBeTruthy();
    expect(screen.getByText(/Test run\./)).toBeTruthy(); // an active agent runs the scripted test model
    const lcd = document.querySelector(".lcdbar")!;
    expect(lcd.textContent).toMatch(/2 lemmas checked of 5/);
    expect(lcd.textContent).toMatch(/1 awake now/);
    expect(lcd.textContent).toMatch(/food for 8\.3 days/);
    const roster = document.querySelector(".colony") as HTMLElement;
    expect(within(roster).getAllByRole("button").map((b) => b.querySelector(".pname")!.textContent)).toEqual(["Bomo", "Kizen", "Pipty"]);
    expect(within(roster).getAllByRole("meter").map((m) => m.getAttribute("aria-valuenow"))).toEqual(["80", "0", "100"]);
    expect(within(roster).getByText("Offline")).toBeTruthy(); // inactive agent
    expect(document.querySelector(".egg.external")).toBeTruthy(); // outside contributor: different shell pattern
    expect(await screen.findByText("Bomo's proof of L-core-002 passed the Lean checker.")).toBeTruthy();
    expect(screen.queryByText(/model_call/)).toBeNull();
    expect(await screen.findByText("$7.50")).toBeTruthy(); // spent on API calls
    expect(screen.queryByRole("button", { name: /add .* fees/i })).toBeNull(); // no demo money button
  });

  it("every page carries the honesty line", async () => {
    for (const path of ["/", "/feed", "/programs", "/pantry", "/graveyard", "/how-it-works", "/token", "/join", "/definitions"]) {
      render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
      expect(screen.getByText("Nothing here says P vs NP is settled. A lemma counts only when the Lean checker passes it."), path).toBeTruthy();
      cleanup();
    }
  });

  it("the token page promises nothing and links the public ledger", () => {
    render(<MemoryRouter initialEntries={["/token"]}><App /></MemoryRouter>);
    const main = document.querySelector("main")!.textContent!;
    expect(main).toMatch(/The token has not launched/);
    expect(main).toMatch(/no promise of profit, returns, or any change in price/);
    expect(main).not.toMatch(/moon|guarantee|price will|returns of|APY|invest now/i);
    expect(within(document.querySelector("main")!).getByRole("link", { name: "Pantry" }).getAttribute("href")).toBe("/pantry");
  });
});

describe("the pantry page", () => {
  it("labels mock money, shows the ledger with a running balance, and links the CSV", async () => {
    render(<MemoryRouter initialEntries={["/pantry"]}><App /></MemoryRouter>);
    expect(await screen.findByText(/Development pantry\./)).toBeTruthy();
    const table = (await screen.findByText("Money in", { selector: "td" })).closest("table")!;
    const rows = within(table).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(rows[0]).toMatch(/API calls.*−\$7\.50.*\$12\.50$/);
    expect(rows[1]).toMatch(/Top-up \(no change\).*\$5\.00 moved.*\$20\.00$/);
    expect(rows[2]).toMatch(/Money in.*\+\$20\.00.*\$20\.00$/);
    expect(screen.getByRole("link", { name: /Download the full ledger/ }).getAttribute("href")).toBe("/api/pantry/ledger.csv");
  });
});

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicDefinitions } from "../src/public/Definitions";
import { DefinitionReview } from "../src/review/DefinitionReview";
import { Join } from "../src/review/Join";
import { Queue } from "../src/review/Queue";
import { StatementReview } from "../src/review/StatementReview";

afterEach(cleanup);

/** Fake desk: route table of `METHOD /path` -> [status, body]; records every request. */
function fakeDesk(routes: Record<string, [number, unknown] | ((body: unknown) => [number, unknown])>) {
  const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = url.replace(/^\/api/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
    const r = routes[`${method} ${path}`];
    if (!r) return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 404 });
    const [status, data] = typeof r === "function" ? r(body) : r;
    return new Response(JSON.stringify(data), { status });
  }));
  return calls;
}
const at = (path: string, routePath: string, el: React.ReactNode) =>
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path={routePath} element={el} /></Routes></MemoryRouter>);

const draftCircuit = {
  id: "Defs.Core.Circuit", title: "Boolean circuits", summary: "A Boolean circuit on n inputs is a list of gates.", path: "lean/Defs/Core/Circuit.lean",
  requiresMathlib: false, status: "draft", draft: true, draftReasons: ["Defs.Core.Circuit is a draft"],
  source: "def InAC0 := 0", sourceSha256: "a".repeat(64), imports: [], usedBy: [{ id: "L-circ-001", title: "Parity not in AC0", status: "proposed" }],
  declarations: [{ kind: "def", name: "InAC0", doc: "Polynomial size, constant depth.", code: "def InAC0 := 0" }], history: [],
};
const blockedStatement = {
  id: "L-circ-001", title: "Parity not in AC0", program: "circuit-lower-bounds", programTitle: "Circuit lower bounds", origin: "decomposer",
  proposedBy: "decomposer-1", approvedBy: null, status: "proposed", rationale: "Ajtai, FSS", rejectReason: null, parentId: null,
  leanStatement: "¬ Hatchery.Defs.InAC0 Hatchery.Defs.parity", source: "def Statement.L_circ_001 : Prop := ...", sourceSha256: "b".repeat(64),
  check: { wellFormed: true, elaborates: true, trivial: false, trivialBy: null, errors: [] },
  definitions: [{ id: "Defs.Core.Circuit", draft: true, reasons: [] }], usesDraftDefinition: true,
  canApprove: false, approvalBlockers: ["uses a draft definition: Defs.Core.Circuit is a draft"], lemmaStatus: null, history: [],
};

describe("the review tool", () => {
  it("join: redeems the token from the link, removes it from the address bar, welcomes the reviewer", async () => {
    window.history.replaceState(null, "", "/review/join#secret-token-0123456789abcdef");
    const calls = fakeDesk({ "POST /review/join": [200, { name: "Dr. Ada", role: "advisor" }] });
    render(<MemoryRouter><Join /></MemoryRouter>);
    expect(await screen.findByText("Welcome, Dr. Ada")).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/review/join", body: { token: "secret-token-0123456789abcdef" }, headers: { "x-hatchery-review": "1" } });
  });

  it("join: an used or expired link says so plainly", async () => {
    window.history.replaceState(null, "", "/review/join#used-token-0123456789abcdef");
    fakeDesk({ "POST /review/join": [401, { error: "this invite link is not valid any more; ask the maintainer for a new one" }] });
    render(<MemoryRouter><Join /></MemoryRouter>);
    expect(await screen.findByText(/not valid any more; ask the maintainer/)).toBeTruthy();
  });

  it("queue: drafts are labelled, blocked statements say why", async () => {
    fakeDesk({ "GET /review/queue": [200, { definitions: [draftCircuit, { ...draftCircuit, id: "Defs.Core.Formula", title: "Boolean formulas", status: "approved", draft: false }], statements: [blockedStatement] }] });
    at("/review", "/review", <Queue />);
    expect(await screen.findByText("Boolean circuits")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Reviewed")).toBeTruthy();
    expect(screen.getByText("(1 of 2 still drafts)")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText(/uses a draft definition: Defs.Core.Circuit is a draft/)).toBeTruthy();
  });

  it("definition: a maintainer cannot approve; an advisor approves exactly the text shown", async () => {
    const routes = {
      "GET /review/me": [200, { name: "Max", role: "maintainer" }] as [number, unknown],
      "GET /review/definitions/Defs.Core.Circuit": [200, draftCircuit] as [number, unknown],
    };
    fakeDesk(routes);
    at("/review/definitions/Defs.Core.Circuit", "/review/definitions/:id", <DefinitionReview />);
    expect(await screen.findByText(/Draft definition\./)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Approve/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/only a math advisor can approve a definition/)).toBeTruthy();
    cleanup();

    const calls = fakeDesk({
      ...routes,
      "GET /review/me": [200, { name: "Dr. Ada", role: "advisor" }],
      "POST /review/definitions/Defs.Core.Circuit": [200, { ...draftCircuit, status: "approved", draft: false, draftReasons: [] }],
    });
    at("/review/definitions/Defs.Core.Circuit", "/review/definitions/:id", <DefinitionReview />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /Approve/ }));
    await user.click(screen.getByRole("button", { name: "Submit decision" }));
    expect(await screen.findByText("Approved. This definition is no longer a draft.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ decision: "approve", comment: "", sha256: "a".repeat(64) });
    expect(post.headers["x-hatchery-review"]).toBe("1");
  });

  it("definition: a stale page cannot decide; the reviewer is told to reload", async () => {
    fakeDesk({
      "GET /review/me": [200, { name: "Dr. Ada", role: "advisor" }],
      "GET /review/definitions/Defs.Core.Circuit": [200, draftCircuit],
      "POST /review/definitions/Defs.Core.Circuit": [409, { error: "this definition changed since you opened it; reload the page to review the current version" }],
    });
    at("/review/definitions/Defs.Core.Circuit", "/review/definitions/:id", <DefinitionReview />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /Approve/ }));
    await user.click(screen.getByRole("button", { name: "Submit decision" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload this page" })).toBeTruthy();
  });

  it("statement: approve is disabled while a definition is a draft; reject needs a reason", async () => {
    const calls = fakeDesk({
      "GET /review/statements/L-circ-001": [200, blockedStatement],
      "POST /review/statements/L-circ-001": [200, { ...blockedStatement, status: "rejected", rejectReason: "not the standard form" }],
    });
    at("/review/statements/L-circ-001", "/review/statements/:id", <StatementReview />);
    expect(await screen.findByText(/cannot be approved until a math advisor/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Approve/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Lean understands it")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /Reject/ }));
    const submit = screen.getByRole("button", { name: "Submit decision" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // a reason is required
    await user.type(screen.getByRole("textbox"), "not the standard form");
    await user.click(submit);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "reject", comment: "not the standard form", sha256: "b".repeat(64) });
  });
});

describe("public pages show drafts as drafts", () => {
  it("lists every definition with its review state", async () => {
    fakeDesk({ "GET /definitions": [200, [draftCircuit, { ...draftCircuit, id: "Defs.Core.Formula", title: "Boolean formulas", status: "approved", draft: false }]] });
    at("/definitions", "/definitions", <PublicDefinitions />);
    expect(await screen.findByText("Boolean circuits")).toBeTruthy();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([expect.stringMatching(/^Boolean circuitsDraft/), expect.stringMatching(/^Boolean formulasReviewed/)]);
  });
});

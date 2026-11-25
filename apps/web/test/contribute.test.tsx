import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

afterEach(cleanup);

type Handler = (method: string, path: string, body: unknown, headers: Record<string, string>) => [number, unknown];
function stub(handler: Handler) {
  const calls: { method: string; path: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace(/^\/api/, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, headers });
    const [status, body] = handler(method, path, init?.body ? JSON.parse(String(init.body)) : undefined, headers);
    return new Response(body === null ? "" : JSON.stringify(body), { status });
  }));
  vi.stubGlobal("EventSource", class { onmessage: unknown; close() {} constructor(public url: string) {} });
  return calls;
}
const me = { login: "alice", admin: false, agentId: "gh-alice", lease: { lemmaId: "L-core-003", expiresAt: new Date().toISOString(), createdAt: new Date().toISOString() }, tokens: [] as unknown[] };

describe("join page", () => {
  it("signed out: shows GitHub sign-in when configured, and the dev login only when the server allows it", async () => {
    stub((_m, p) => (p === "/auth/config" ? [200, { github: false, devLogin: true }] : p === "/me" ? [401, { error: "sign in" }] : [404, {}]));
    render(<MemoryRouter initialEntries={["/join"]}><App /></MemoryRouter>);
    expect(await screen.findByText(/Sign-in with GitHub is not set up/)).toBeTruthy();
    expect(screen.getByText(/Development only\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "/join.txt" }).getAttribute("href")).toBe("/join.txt");
    cleanup();
    stub((_m, p) => (p === "/auth/config" ? [200, { github: true, devLogin: false }] : [401, { error: "sign in" }]));
    render(<MemoryRouter initialEntries={["/join"]}><App /></MemoryRouter>);
    expect((await screen.findByRole("link", { name: "Sign in with GitHub" })).getAttribute("href")).toBe("/api/auth/github/start");
    expect(screen.queryByText(/Development only\./)).toBeNull();
  });

  it("signed in: current lease, and a new API token is shown exactly once (sent with the CSRF header)", async () => {
    let tokens: unknown[] = [];
    const calls = stub((m, p) => {
      if (p === "/auth/config") return [200, { github: true, devLogin: false }];
      if (p === "/me") return [200, { ...me, tokens }];
      if (m === "POST" && p === "/me/tokens") {
        tokens = [{ id: 1, label: "laptop", createdAt: new Date().toISOString(), lastUsedAt: null, revoked: false }];
        return [200, { id: 1, token: "hx_secret_value_shown_once", label: "laptop" }];
      }
      return [404, {}];
    });
    render(<MemoryRouter initialEntries={["/join"]}><App /></MemoryRouter>);
    expect(await screen.findByText("Signed in as @alice")).toBeTruthy();
    expect(screen.getByRole("link", { name: "L-core-003" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create a token" }));
    expect(await screen.findByText("hx_secret_value_shown_once")).toBeTruthy();
    expect(screen.getByText(/will not be shown again/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.path === "/me/tokens")!.headers["x-hatchery"]).toBe("1");
    expect(await screen.findByText(/never used/)).toBeTruthy();
  });
});

describe("admin page", () => {
  it("is closed to non-admins, and admins can pause the colony", async () => {
    stub((_m, p) => (p === "/me" ? [200, me] : [404, {}]));
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    expect(await screen.findByText(/is not on the admin list/)).toBeTruthy();
    cleanup();
    let on = false;
    const calls = stub((m, p, body) => {
      if (p === "/me") return [200, { ...me, admin: true }];
      if (p === "/admin/overview") return [200, { budget: { killSwitch: { on, source: on ? "admin" : null }, pantryUsd: "1" }, externalLeases: [], contributors: [], contributions: [] }];
      if (m === "POST" && p === "/admin/kill-switch") {
        on = (body as { on: boolean }).on;
        return [200, { on, source: "admin" }];
      }
      return [404, {}];
    });
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Pause the colony" }));
    expect(await screen.findByRole("button", { name: "Resume the colony" })).toBeTruthy();
    const post = calls.find((c) => c.path === "/admin/kill-switch")!;
    expect(post.headers["x-hatchery"]).toBe("1");
  });
});

import type { AddressInfo } from "node:net";
import { buildServer, Desk, LeanRepo, type JudgeClient } from "@hatchery/desk";
import { addInflow, FakeJudge, freshDb, REPO_LEAN_DIR, testConfig, WORKER_TOKEN } from "../../desk/test/helpers.ts";
import { Agent, type AgentOptions } from "../src/agent.ts";
import { DeskClient } from "../src/desk-client.ts";
import type { ModelProvider } from "../src/provider.ts";

export const ADMIN_TOKEN = "admin-token-for-tests-0123";

/**
 * Every agent a test starts is tracked here, so teardown can stop it and wait for it BEFORE the
 * desk and its database go away (no agent loop outlives its test).
 */
const running = new Set<{ stop: () => void; done: Promise<unknown> }>();

export async function stopAllAgents(timeoutMs = 10_000): Promise<void> {
  const all = [...running];
  for (const a of all) a.stop();
  const settled = Promise.allSettled(all.map((a) => a.done));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  running.clear();
  if (result === "timeout") throw new Error(`${all.length} agent loop(s) did not stop within ${timeoutMs} ms`);
}

/** A real desk (Postgres + HTTP) on a random port, with a fake or real judge and optional injected clock. */
export async function startDesk(opts: { judge?: JudgeClient; config?: Record<string, string>; pantryUsd?: number; now?: () => Date } = {}) {
  const fresh = await freshDb();
  let app: ReturnType<typeof buildServer> | undefined;
  const stop = async () => {
    await stopAllAgents();
    await app?.close();
    await fresh.cleanup();
  };
  try {
    const repo = new LeanRepo(REPO_LEAN_DIR);
    const judge = opts.judge ?? new FakeJudge({ flavor: "lite", trustedSha: repo.trustedSha(), leanVersion: "4.36.0" });
    const desk = new Desk(fresh.db, judge, repo, testConfig({ ADMIN_TOKEN, ...opts.config }), opts.now);
    await desk.syncStatements();
    if (opts.pantryUsd !== 0) await addInflow(fresh.db, opts.pantryUsd ?? 100_000);
    app = buildServer(desk);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    return { desk, db: fresh.db, url, judge, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

export function makeAgent(url: string, id: string, provider: ModelProvider, over: Partial<AgentOptions> = {}) {
  const logs: string[] = [];
  let stopped = false;
  const userStop = over.shouldStop;
  const agent = new Agent(new DeskClient(url, WORKER_TOKEN, id, { requestMs: 15_000, judgeMs: 120_000 }), provider, {
    maxTurns: 10,
    maxRunUsd: 0,
    maxLemmas: 0,
    exitWhenIdle: true,
    idleSleepMs: 30,
    sleepPollMs: 30,
    replyWaitMs: 5000,
    replyMaxTokens: 256,
    killSwitch: () => false,
    log: (m) => logs.push(m),
    // Phase 1-2 tests are about the warm-up lemmas (the sanity lemmas are leasable too since the
    // autonomous review; tests that want them say so).
    program: "core-warmup",
    ...over,
    shouldStop: () => stopped || (userStop?.() ?? false),
  });
  const origRun = agent.run.bind(agent);
  agent.run = () => {
    const done = origRun();
    const entry = { stop: () => (stopped = true), done };
    running.add(entry);
    void done.finally(() => running.delete(entry)).catch(() => {});
    return done;
  };
  return { agent, logs };
}

export async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 30_000, what = "condition") {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

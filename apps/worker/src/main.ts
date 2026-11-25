import { hostname } from "node:os";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { AnthropicProvider } from "./anthropic-provider.ts";
import { DeskClient } from "./desk-client.ts";

const env = z
  .object({
    DESK_URL: z.string().default("http://127.0.0.1:4200"),
    DESK_WORKER_TOKEN: z.string().min(16),
    AGENT_ID: z.string().default(`agent-${hostname().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "local"}-1`),
    AGENT_MODEL: z.string().min(1, "set AGENT_MODEL, e.g. claude-opus-5-5"),
    AGENT_MAX_TURNS: z.coerce.number().int().positive().default(20),
    AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
    AGENT_REPLY_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
    AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
    AGENT_REFUSAL_FALLBACK: z.enum(["0", "1"]).default("1"),
    WORKER_MAX_RUN_USD: z.coerce.number().nonnegative().default(0),
    WORKER_MAX_LEMMAS: z.coerce.number().int().nonnegative().default(0),
    WORKER_EXIT_WHEN_IDLE: z.enum(["0", "1"]).default("0"),
    WORKER_IDLE_SLEEP_SECONDS: z.coerce.number().positive().default(30),
    WORKER_SLEEP_POLL_SECONDS: z.coerce.number().positive().default(60),
    WORKER_REPLY_WAIT_SECONDS: z.coerce.number().nonnegative().default(120),
  })
  .parse(process.env);

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));

const desk = new DeskClient(env.DESK_URL, env.DESK_WORKER_TOKEN, env.AGENT_ID);
const provider = new AnthropicProvider({
  model: env.AGENT_MODEL,
  maxTokens: env.AGENT_MAX_TOKENS,
  effort: env.AGENT_EFFORT,
  refusalFallback: env.AGENT_REFUSAL_FALLBACK === "1",
});
const agent = new Agent(desk, provider, {
  maxTurns: env.AGENT_MAX_TURNS,
  maxRunUsd: env.WORKER_MAX_RUN_USD,
  maxLemmas: env.WORKER_MAX_LEMMAS,
  exitWhenIdle: env.WORKER_EXIT_WHEN_IDLE === "1",
  idleSleepMs: env.WORKER_IDLE_SLEEP_SECONDS * 1000,
  sleepPollMs: env.WORKER_SLEEP_POLL_SECONDS * 1000,
  replyWaitMs: env.WORKER_REPLY_WAIT_SECONDS * 1000,
  replyMaxTokens: env.AGENT_REPLY_MAX_TOKENS,
  killSwitch: () => process.env.KILL_SWITCH === "1",
  shouldStop: () => stopping,
  log: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), agent: env.AGENT_ID, msg, ...extra })),
});
const result = await agent.run();
console.log(JSON.stringify({ t: new Date().toISOString(), agent: env.AGENT_ID, msg: "run finished", ...result }));

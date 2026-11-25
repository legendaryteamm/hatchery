import { z } from "zod";
import { AnthropicProvider } from "./anthropic-provider.ts";
import { Decomposer } from "./decomposer.ts";
import { DeskClient } from "./desk-client.ts";

const env = z
  .object({
    DESK_URL: z.string().default("http://127.0.0.1:4200"),
    DESK_WORKER_TOKEN: z.string().min(16),
    DECOMPOSER_ID: z.string().default("decomposer-1"),
    AGENT_MODEL: z.string().min(1, "set AGENT_MODEL, e.g. claude-opus-5-5"),
    AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
    AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
    AGENT_REFUSAL_FALLBACK: z.enum(["0", "1"]).default("1"),
    DECOMPOSER_MAX_TURNS: z.coerce.number().int().positive().default(6),
    DECOMPOSER_INTERVAL_SECONDS: z.coerce.number().positive().default(3600),
    DECOMPOSER_MAX_SESSIONS: z.coerce.number().int().nonnegative().default(0),
    WORKER_SLEEP_POLL_SECONDS: z.coerce.number().positive().default(60),
  })
  .parse(process.env);

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));

const d = new Decomposer(
  new DeskClient(env.DESK_URL, env.DESK_WORKER_TOKEN, env.DECOMPOSER_ID),
  new AnthropicProvider({ model: env.AGENT_MODEL, maxTokens: env.AGENT_MAX_TOKENS, effort: env.AGENT_EFFORT, refusalFallback: env.AGENT_REFUSAL_FALLBACK === "1" }),
  {
    maxTurns: env.DECOMPOSER_MAX_TURNS,
    intervalMs: env.DECOMPOSER_INTERVAL_SECONDS * 1000,
    sleepPollMs: env.WORKER_SLEEP_POLL_SECONDS * 1000,
    maxSessions: env.DECOMPOSER_MAX_SESSIONS,
    killSwitch: () => process.env.KILL_SWITCH === "1",
    shouldStop: () => stopping,
    log: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), agent: env.DECOMPOSER_ID, msg, ...extra })),
  },
);
console.log(JSON.stringify({ msg: "decomposer finished", ...(await d.run()) }));

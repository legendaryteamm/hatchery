/**
 * AI review agents (docs/autonomous-review.md): one reviewer per model in REVIEWER_MODELS (use
 * different models where available, e.g. "claude-opus-5-5,claude-sonnet-5-5"), each also acting as
 * the adversary when a definition reaches that step. Every call is paid from the pantry.
 */
import { z } from "zod";
import { AnthropicProvider } from "./anthropic-provider.ts";
import { DeskClient } from "./desk-client.ts";
import { ReviewerAgent } from "./reviewer.ts";

const env = z
  .object({
    DESK_URL: z.string().default("http://127.0.0.1:4200"),
    DESK_WORKER_TOKEN: z.string().min(16),
    AGENT_MODEL: z.string().default(""),
    REVIEWER_MODELS: z.string().default(""),
    REVIEWERS_PER_MODEL: z.coerce.number().int().min(1).max(4).default(1),
    REVIEWER_ID_PREFIX: z.string().default("reviewer"),
    AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
    AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
    AGENT_REFUSAL_FALLBACK: z.enum(["0", "1"]).default("1"),
    ADVERSARY_MAX_TURNS: z.coerce.number().int().positive().default(12),
    REVIEWER_IDLE_SECONDS: z.coerce.number().positive().default(60),
    WORKER_SLEEP_POLL_SECONDS: z.coerce.number().positive().default(60),
  })
  .parse(process.env);

const models = (env.REVIEWER_MODELS || env.AGENT_MODEL).split(",").map((m) => m.trim()).filter(Boolean);
if (!models.length) {
  console.error("set REVIEWER_MODELS (e.g. claude-opus-5-5,claude-sonnet-5-5) or AGENT_MODEL");
  process.exit(2);
}
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));

const agents = models.flatMap((model) =>
  Array.from({ length: env.REVIEWERS_PER_MODEL }, (_, i) => {
    const id = `${env.REVIEWER_ID_PREFIX}-${model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${i + 1}`.slice(0, 62);
    return new ReviewerAgent(
      new DeskClient(env.DESK_URL, env.DESK_WORKER_TOKEN, id),
      new AnthropicProvider({ model, maxTokens: env.AGENT_MAX_TOKENS, effort: env.AGENT_EFFORT, refusalFallback: env.AGENT_REFUSAL_FALLBACK === "1" }),
      {
        maxAdversaryTurns: env.ADVERSARY_MAX_TURNS,
        idleMs: env.REVIEWER_IDLE_SECONDS * 1000,
        sleepPollMs: env.WORKER_SLEEP_POLL_SECONDS * 1000,
        maxTasks: 0,
        killSwitch: () => process.env.KILL_SWITCH === "1",
        shouldStop: () => stopping,
        log: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), agent: id, msg, ...extra })),
      },
    );
  }),
);
console.log(JSON.stringify({ msg: "AI review agents", models, agents: agents.length }));
await Promise.all(agents.map((a) => a.run()));

import { fileURLToPath } from "node:url";
import { z } from "zod";

const flag = z.enum(["0", "1"]).default("0").transform((v) => v === "1");

const Env = z.object({
  DATABASE_URL: z.string().default("postgres://hatchery:hatchery-dev-only@127.0.0.1:5433/hatchery"),
  JUDGE_URL: z.string().default("http://127.0.0.1:4100"),
  JUDGE_API_TOKEN: z.string().optional(),
  DESK_WORKER_TOKEN: z.string().min(16, "DESK_WORKER_TOKEN must be at least 16 characters"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4200),
  LEAN_DIR: z.string().default(fileURLToPath(new URL("../../../lean", import.meta.url))),
  LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  AGENT_MAX_ATTEMPTS_PER_LEMMA: z.coerce.number().int().positive().default(3),
  LEMMA_ABANDON_AFTER_ATTEMPTS: z.coerce.number().int().positive().default(12),
  /** Off until the `full` job of .github/workflows/judge.yml is green (docs/deploy.md). */
  MATHLIB_LEMMAS_ENABLED: flag,
  GIT_COMMIT: z.string().optional(),
  RECHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),

  // ---- Phase 2: budget (section 8)
  GLOBAL_DAILY_CAP_USD: z.coerce.number().nonnegative().default(100),
  RUNWAY_TARGET_DAYS: z.coerce.number().positive().default(30),
  KILL_SWITCH: flag,
  /** Bearer token for /admin/* (kill switch). Admin routes are disabled when unset. Phase 6: GitHub OAuth allowlist. */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Agents seen within this window share the daily budget. */
  ACTIVE_AGENT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  // ---- Phase 2: collaboration (section 6b)
  ASK_AFTER_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
  MAX_QUESTIONS_PER_HOUR: z.coerce.number().int().nonnegative().default(2),
  MAX_REPLIES_PER_HOUR: z.coerce.number().int().nonnegative().default(6),
  QUESTION_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  HANDOFF_OFFER_SECONDS: z.coerce.number().int().positive().default(600),

  // ---- Phase 2: commit checked proofs to lean/Proofs/ (resolves open question 15)
  /** commit = write + git commit; write = write file only; off = DB only. */
  PROOF_COMMIT_MODE: z.enum(["commit", "write", "off"]).default("commit"),
  PROOF_COMMIT_AUTHOR_NAME: z.string().default("Hatchery Judge"),
  PROOF_COMMIT_AUTHOR_EMAIL: z.string().default("judge@hatchery.invalid"),
});

export type DeskConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeskConfig {
  return Env.parse(env);
}

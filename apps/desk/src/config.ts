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
  LEASE_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  AGENT_MAX_ATTEMPTS_PER_LEMMA: z.coerce.number().int().positive().default(3),
  LEMMA_ABANDON_AFTER_ATTEMPTS: z.coerce.number().int().positive().default(12),
  /** Off until the `full` job of .github/workflows/judge.yml is green (docs/deploy.md). */
  MATHLIB_LEMMAS_ENABLED: flag,
  GIT_COMMIT: z.string().optional(),
  RECHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
});

export type DeskConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeskConfig {
  return Env.parse(env);
}

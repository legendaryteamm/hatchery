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

  // ---- Accepted proofs in lean/Proofs/ (see docs/deploy.md, "Where bot commits go")
  /**
   * sandbox (default) = commit into a throwaway clone, never the real checkout;
   * commit = write + git commit in the real checkout (needs HATCHERY_REAL_RUN=1);
   * write = write the file only, in the real checkout (needs HATCHERY_REAL_RUN=1);
   * off = database only.
   */
  PROOF_COMMIT_MODE: z.enum(["sandbox", "commit", "write", "off"]).default("sandbox"),
  /** Explicit "this is a real run": the only way the desk may write to the real checkout. */
  HATCHERY_REAL_RUN: flag,
  /** Where the sandbox clone goes (default: a new temp directory per desk start). */
  PROOF_SANDBOX_DIR: z.string().optional(),
  PROOF_COMMIT_AUTHOR_NAME: z.string().default("Hatchery Judge"),
  PROOF_COMMIT_AUTHOR_EMAIL: z.string().default("judge@hatchery.invalid"),
  /** Server only: push bot commits (deploy key via GIT_SSH_COMMAND). Never on a laptop. */
  PROOF_PUSH: flag,
  PROOF_PUSH_REMOTE: z.string().default("origin"),
  PROOF_PUSH_BRANCH: z.string().default("main"),

  // ---- Phase 3: review and decomposer
  /** Where reviewers open the review tool (invite links point here). */
  PUBLIC_SITE_URL: z.string().default("http://localhost:5173"),
  REVIEW_SESSION_DAYS: z.coerce.number().int().positive().default(30),
  REVIEW_INVITE_DAYS: z.coerce.number().int().positive().default(7),
  MAX_PROPOSALS_PER_HOUR: z.coerce.number().int().nonnegative().default(20),

  // ---- Phase 4: public site
  /** Requests per minute per client on public routes (workers and reviewers are not limited). */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** Concurrent live event streams per client. */
  MAX_STREAMS_PER_CLIENT: z.coerce.number().int().positive().default(4),
  /** Behind a reverse proxy (Phase 7), trust X-Forwarded-For for the client address. */
  TRUST_PROXY: flag,

  // ---- Phase 5: pantry (treasury)
  /** The chain whose inflows this desk records. "mock" = development; the site labels it. */
  TREASURY_CHAIN: z.string().regex(/^[a-z0-9-]{1,32}$/).default("mock"),
  /** The public treasury address (shown on the site). Empty with the mock chain. */
  TREASURY_ADDRESS: z.string().max(200).default(""),
  /** Bearer token for the indexer's routes (/internal/pantry/*). Separate from the worker token, so a worker can never record money. */
  INDEXER_TOKEN: z.string().min(16).optional(),
  /** Optional webhook for pantry alerts (Slack- and Discord-compatible JSON). Alerts are always logged and shown in the feed. */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  PANTRY_ALERT_CHECK_SECONDS: z.coerce.number().int().positive().default(60),

  // ---- Phase 6: outside contributors (BUILD_PROMPT.md section 10)
  /** GitHub OAuth app (HANDOFF.md). Sign-in with GitHub is off until both are set. */
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  /** Overridable only so tests can stand in for GitHub. */
  GITHUB_OAUTH_URL: z.string().url().default("https://github.com"),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  /** Comma-separated GitHub logins allowed into /admin (case-insensitive). */
  ADMIN_GITHUB_HANDLES: z.string().default(""),
  /** LOCAL ONLY: sign in as any name without GitHub, to try the contributor flow. Refused unless PUBLIC_SITE_URL is http://localhost or http://127.0.0.1. */
  DEV_LOGIN: flag,
  CONTRIBUTOR_SESSION_DAYS: z.coerce.number().int().positive().default(30),
  /** Bearer token the contributor CI (contrib-merge workflow) uses to report pull requests. Routes are off without it. */
  CONTRIB_TOKEN: z.string().min(16).optional(),
  /** "owner/name" of the GitHub repository (shown in join.txt). */
  CONTRIB_REPO: z.string().regex(/^$|^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).default(""),
  /** Outside leases: at most this long in total, a heartbeat at least this often (+ grace), and at most this many at once. */
  EXTERNAL_LEASE_MAX_HOURS: z.coerce.number().positive().default(6),
  EXTERNAL_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(2700),
  EXTERNAL_HEARTBEAT_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(900),
  MAX_EXTERNAL_LEASES: z.coerce.number().int().nonnegative().default(20),
  MAX_API_TOKENS_PER_CONTRIBUTOR: z.coerce.number().int().positive().default(5),
}).superRefine((c, ctx) => {
  if ((c.PROOF_COMMIT_MODE === "commit" || c.PROOF_COMMIT_MODE === "write") && !c.HATCHERY_REAL_RUN) {
    ctx.addIssue({
      code: "custom",
      path: ["PROOF_COMMIT_MODE"],
      message: `PROOF_COMMIT_MODE=${c.PROOF_COMMIT_MODE} writes to the real checkout. Set HATCHERY_REAL_RUN=1 to confirm this is a real run, or use PROOF_COMMIT_MODE=sandbox.`,
    });
  }
  if (c.DEV_LOGIN && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(c.PUBLIC_SITE_URL)) {
    ctx.addIssue({ code: "custom", path: ["DEV_LOGIN"], message: "DEV_LOGIN=1 is for local development only: PUBLIC_SITE_URL must be http://localhost or http://127.0.0.1." });
  }
  if (c.PROOF_PUSH && !(c.PROOF_COMMIT_MODE === "commit" && c.HATCHERY_REAL_RUN)) {
    ctx.addIssue({ code: "custom", path: ["PROOF_PUSH"], message: "PROOF_PUSH=1 needs PROOF_COMMIT_MODE=commit and HATCHERY_REAL_RUN=1 (server only)." });
  }
});

export type DeskConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeskConfig {
  // An empty variable (e.g. `ADMIN_TOKEN=` from docker compose) means "not set".
  return Env.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
}
